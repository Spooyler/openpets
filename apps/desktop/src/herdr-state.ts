/**
 * herdr-state.ts
 *
 * Herdr agent-state watcher (phase 2b of the herdr integration; pane/tab
 * focus is herdr-focus.ts, OS-window raise is herdr-window.ts).
 *
 * Herdr's server classifies the agent in every pane (idle / working /
 * blocked / done / unknown) and pushes changes over its control socket
 * (protocol 18): an `events.subscribe` for `pane.updated` first replays every
 * pane's current state, then delivers transition events carrying
 * `agent_status`. This module keeps one connection per herdr socket path,
 * diffs statuses per pane, and hands normalized changes to the desktop glue
 * (local-ipc.ts), which maps pane ids onto leases carrying herdr context and
 * drives the session live-status dot / notification row / pet reaction.
 *
 * Transport: the advertised "socket" file on Windows is a placeholder
 * (`PID:nonce`) — the real endpoint is a named pipe whose name embeds the
 * file path (`\\.\pipe\<socketPath>`, the Rust `interprocess` convention).
 * On POSIX the path is a real unix socket. Framing is newline-delimited
 * JSON: `{id,method,params}` requests, `{id,result|error}` responses, and
 * `{event,data}` pushes.
 *
 * The post-subscribe replay would look like a burst of fresh transitions, so
 * changes within `seedMs` of a (re)connect are flagged `seeding` — the glue
 * updates state silently and suppresses notifications/reactions for them.
 * Connections reconnect with exponential backoff while leases for the socket
 * path exist and self-stop once none remain. Everything is fail-safe: a dead
 * server or unparsable line degrades to "no status updates", never an error.
 *
 * The logger is lazy-loaded via createRequire (same pattern as
 * herdr-focus.ts) so this module stays importable from the plain-Node test
 * suite.
 */

import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

type LoggerModule = typeof import("./logger.js");

function log(level: "debug" | "info" | "warn", message: string, fields?: Record<string, unknown>): void {
  try {
    (nodeRequire("./logger.js") as LoggerModule)[level]("herdr-state", message, fields);
  } catch {
    // Logger unavailable outside Electron (e.g. test suite) — logging is best-effort.
  }
}

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

const AGENT_STATUSES: ReadonlySet<string> = new Set(["idle", "working", "blocked", "done", "unknown"]);

/** One normalized per-pane agent-status change. */
export interface HerdrPaneStatusEvent {
  readonly socketPath: string;
  readonly paneId: string;
  readonly status: HerdrAgentStatus;
  readonly agent?: string;
  /** True during the post-(re)connect replay — apply state, suppress UX. */
  readonly seeding: boolean;
}

// ---------------------------------------------------------------------------
// Status → UI policy (pure)
// ---------------------------------------------------------------------------

/**
 * What the glue should do for a status change. `liveReaction` is fed to
 * SessionLiveStatusTracker.update() — "waiting"/"running" set the dot,
 * "idle" clears it (any non-reaction string deletes the entry), null leaves
 * it untouched.
 */
export interface HerdrStatusActions {
  readonly liveReaction: "waiting" | "running" | "idle" | null;
  readonly notifyBlocked: boolean;
  readonly touchActivity: boolean;
}

/**
 * Merge rules against hook-driven live status: herdr is authoritative about
 * the busy/blocked/quiet boundary but generic about what the agent is doing,
 * so `working` never clobbers a more specific hook status ("editing",
 * "testing", …) and only fills in when the dot is idle. `blocked` always
 * wins (waiting on the user is the high-value signal) but only notifies once
 * per stretch — not when a hook already set "waiting", and never while
 * seeding. `done` stays quiet: Claude's Stop hook already records "Task
 * complete", and duplicating it for every herdr-hosted agent adds noise.
 * `unknown` means the classifier lost track, not that the agent is quiet.
 */
export function herdrStatusActions(status: HerdrAgentStatus, currentLive: string, seeding: boolean): HerdrStatusActions {
  if (status === "blocked") {
    return { liveReaction: "waiting", notifyBlocked: !seeding && currentLive !== "waiting", touchActivity: false };
  }
  if (status === "working") {
    return { liveReaction: currentLive === "idle" ? "running" : null, notifyBlocked: false, touchActivity: true };
  }
  if (status === "idle" || status === "done") {
    return { liveReaction: "idle", notifyBlocked: false, touchActivity: false };
  }
  return { liveReaction: null, notifyBlocked: false, touchActivity: false };
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

export interface HerdrSocketHandlers {
  readonly onConnect: () => void;
  readonly onData: (chunk: string) => void;
  /** Fired exactly once per connection for error and close alike. */
  readonly onClose: () => void;
}

export interface HerdrSocketHandle {
  write(line: string): void;
  destroy(): void;
}

export type HerdrSocketConnect = (socketPath: string, handlers: HerdrSocketHandlers) => HerdrSocketHandle;

/** Injectable seams — production defaults use node:net and real timers. */
export interface HerdrStateWatcherDeps {
  readonly connect?: HerdrSocketConnect;
  /** Whether any live lease still carries herdr context for this socket path. */
  readonly hasHerdrLeases: (socketPath: string) => boolean;
  readonly onStatusChange: (event: HerdrPaneStatusEvent) => void;
  /** Pane closed / exited / agent released — the glue clears its state. */
  readonly onPaneGone?: (socketPath: string, paneId: string) => void;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly seedMs?: number;
  readonly reconnectMinMs?: number;
  readonly reconnectMaxMs?: number;
}

export interface HerdrStateWatcher {
  /** Start (or keep) watching a herdr server; called on herdr lease acquire. */
  ensureWatching(socketPath: string): void;
  /** Last known status for a pane, for seeding leases acquired mid-stream. */
  statusFor(socketPath: string, paneId: string): HerdrAgentStatus | undefined;
  stop(): void;
}

const SUBSCRIBE_REQUEST = JSON.stringify({
  id: "openpets-sub",
  method: "events.subscribe",
  params: { subscriptions: [{ type: "pane.updated" }, { type: "pane.closed" }, { type: "pane.exited" }] },
});

interface WatchedServer {
  handle: HerdrSocketHandle | null;
  buffer: string;
  readonly statuses: Map<string, HerdrAgentStatus>;
  seedUntil: number;
  reconnectDelayMs: number;
  reconnectTimer: unknown;
}

function defaultConnect(socketPath: string, handlers: HerdrSocketHandlers): HerdrSocketHandle {
  const net = nodeRequire("node:net") as typeof import("node:net");
  const target = process.platform === "win32" ? "\\\\.\\pipe\\" + socketPath : socketPath;
  const socket = net.connect({ path: target });
  socket.setEncoding("utf8");
  let closed = false;
  const closeOnce = (): void => {
    if (closed) return;
    closed = true;
    handlers.onClose();
  };
  socket.on("connect", () => handlers.onConnect());
  socket.on("data", (chunk: string) => handlers.onData(chunk));
  socket.on("error", closeOnce);
  socket.on("close", closeOnce);
  return {
    write(line: string): void {
      try {
        socket.write(line);
      } catch {
        // A write on a dying socket surfaces through onClose.
      }
    },
    destroy(): void {
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
    },
  };
}

export function createHerdrStateWatcher(deps: HerdrStateWatcherDeps): HerdrStateWatcher {
  const connect = deps.connect ?? defaultConnect;
  const now = deps.now ?? Date.now;
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): unknown => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    });
  const clearTimer = deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as NodeJS.Timeout));
  const seedMs = deps.seedMs ?? 2_000;
  const reconnectMinMs = deps.reconnectMinMs ?? 5_000;
  const reconnectMaxMs = deps.reconnectMaxMs ?? 60_000;

  const servers = new Map<string, WatchedServer>();
  let stopped = false;

  function drop(socketPath: string): void {
    const server = servers.get(socketPath);
    if (!server) return;
    servers.delete(socketPath);
    if (server.reconnectTimer !== null) clearTimer(server.reconnectTimer);
    server.handle?.destroy();
  }

  function paneGone(socketPath: string, server: WatchedServer, paneId: string): void {
    if (server.statuses.delete(paneId)) deps.onPaneGone?.(socketPath, paneId);
  }

  function handleEventLine(socketPath: string, server: WatchedServer, message: Record<string, unknown>): void {
    // Self-stop: the last herdr session leaving generates pane events itself
    // (its own pane closing), so this check retires idle connections without
    // any lease-release hook.
    if (!deps.hasHerdrLeases(socketPath)) {
      log("debug", "no herdr leases remain, dropping connection", { socketPath });
      drop(socketPath);
      return;
    }
    const data = message.data as Record<string, unknown> | undefined;
    if (message.event === "pane_updated") {
      const pane = data?.pane as Record<string, unknown> | undefined;
      if (!pane) return;
      const paneId = typeof pane.pane_id === "string" ? pane.pane_id : null;
      if (!paneId) return;
      const agent = typeof pane.agent === "string" ? pane.agent : undefined;
      if (agent === undefined) {
        // Agent released the pane (plain shell again) — treat as gone.
        paneGone(socketPath, server, paneId);
        return;
      }
      const rawStatus = typeof pane.agent_status === "string" && AGENT_STATUSES.has(pane.agent_status) ? (pane.agent_status as HerdrAgentStatus) : "unknown";
      if (server.statuses.get(paneId) === rawStatus) return;
      server.statuses.set(paneId, rawStatus);
      deps.onStatusChange({ socketPath, paneId, status: rawStatus, agent, seeding: now() < server.seedUntil });
      return;
    }
    if (message.event === "pane_closed" || message.event === "pane_exited") {
      const paneId = typeof data?.pane_id === "string" ? data.pane_id : null;
      if (paneId) paneGone(socketPath, server, paneId);
    }
  }

  function handleLine(socketPath: string, server: WatchedServer, line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;
    if (typeof record.event === "string") {
      handleEventLine(socketPath, server, record);
      return;
    }
    if (record.error !== undefined) {
      log("warn", "herdr rejected the subscription", { socketPath, error: record.error });
      server.handle?.destroy();
      return;
    }
    // Subscription ack — the connection is healthy, reset the backoff.
    server.reconnectDelayMs = reconnectMinMs;
  }

  function open(socketPath: string, server: WatchedServer): void {
    server.handle = connect(socketPath, {
      onConnect: () => {
        server.seedUntil = now() + seedMs;
        server.handle?.write(SUBSCRIBE_REQUEST + "\n");
        log("debug", "subscribed to herdr pane events", { socketPath });
      },
      onData: (chunk) => {
        server.buffer += chunk;
        let newline;
        while ((newline = server.buffer.indexOf("\n")) >= 0) {
          const line = server.buffer.slice(0, newline);
          server.buffer = server.buffer.slice(newline + 1);
          // The server may drop this entry mid-loop (self-stop) — bail out.
          if (servers.get(socketPath) !== server) return;
          if (line.trim().length > 0) handleLine(socketPath, server, line);
        }
      },
      onClose: () => {
        if (servers.get(socketPath) !== server) return;
        server.handle = null;
        server.buffer = "";
        if (stopped || !deps.hasHerdrLeases(socketPath)) {
          drop(socketPath);
          return;
        }
        const delay = server.reconnectDelayMs;
        server.reconnectDelayMs = Math.min(server.reconnectDelayMs * 2, reconnectMaxMs);
        log("debug", "herdr connection lost, reconnecting", { socketPath, delayMs: delay });
        server.reconnectTimer = setTimer(() => {
          server.reconnectTimer = null;
          if (servers.get(socketPath) === server) open(socketPath, server);
        }, delay);
      },
    });
  }

  return {
    ensureWatching(socketPath: string): void {
      if (stopped || servers.has(socketPath)) return;
      const server: WatchedServer = { handle: null, buffer: "", statuses: new Map(), seedUntil: 0, reconnectDelayMs: reconnectMinMs, reconnectTimer: null };
      servers.set(socketPath, server);
      log("info", "watching herdr agent state", { socketPath });
      open(socketPath, server);
    },
    statusFor(socketPath: string, paneId: string): HerdrAgentStatus | undefined {
      return servers.get(socketPath)?.statuses.get(paneId);
    },
    stop(): void {
      stopped = true;
      for (const socketPath of [...servers.keys()]) drop(socketPath);
    },
  };
}
