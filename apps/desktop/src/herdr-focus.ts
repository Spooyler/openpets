/**
 * herdr-focus.ts
 *
 * Focuses the herdr pane/tab that hosts a session. Herdr (herdr.dev) is a
 * terminal multiplexer for coding agents: panes run under a detached,
 * windowless server process, so the client's process ancestry never reaches
 * the terminal emulator window and the usual terminal-identity resolution
 * fails. Instead, the pane identity is captured from the client's environment
 * (HERDR_PANE_ID / HERDR_TAB_ID / HERDR_SOCKET_PATH, inherited from the pane)
 * at lease.acquire, stored on the lease, and used here to ask herdr itself to
 * switch to the session's pane via its CLI.
 *
 * `herdr agent focus <paneId>` switches workspace + tab + pane focus in the
 * attached client. When it fails (e.g. the pane is no longer detected as an
 * agent), `herdr tab focus <tabId>` is the coarser fallback. Both are
 * fire-and-forget: a missing binary, dead server, or stale pane id degrades
 * to "nothing happens", never to an error surfaced at the caller.
 *
 * logger is lazy-loaded via createRequire (same pattern as
 * vscode-tab-focus.ts) so this module stays importable and testable from the
 * plain-Node test suite: logger.ts reads electron's `app.isPackaged` at
 * module-load time, which throws outside an Electron process.
 */

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { posix, win32 } from "node:path";

const nodeRequire = createRequire(import.meta.url);

type LoggerModule = typeof import("./logger.js");

function log(level: "debug" | "info", message: string, fields?: Record<string, unknown>): void {
  try {
    (nodeRequire("./logger.js") as LoggerModule)[level]("herdr-focus", message, fields);
  } catch {
    // Logger unavailable outside Electron (e.g. test suite) — logging is best-effort.
  }
}

/** Herdr pane identity captured from a client's environment at acquire time. */
export interface HerdrFocusContext {
  /** Pane id hosting the session, e.g. "wC:p1". */
  readonly paneId: string;
  /** Tab id containing the pane, e.g. "wC:t1" — coarser focus fallback. */
  readonly tabId?: string;
  /** Socket of the herdr server that owns the pane (supports multiple servers). */
  readonly socketPath?: string;
}

const herdrIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
const maxSocketPathLength = 512;

function isValidHerdrId(value: unknown): value is string {
  return typeof value === "string" && herdrIdPattern.test(value);
}

function isValidSocketPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxSocketPathLength) return false;
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) return false;
  if (!posix.isAbsolute(value) && !win32.isAbsolute(value)) return false;
  // Reject traversal segments on either separator convention.
  return !value.split(/[\\/]/).includes("..");
}

/**
 * Validate an untrusted `herdr` params object from lease.acquire.
 * Returns a clean context or undefined — never throws: a malformed optional
 * field must not fail the lease acquire, only degrade pane focus.
 */
export function validateHerdrFocusContext(value: unknown): HerdrFocusContext | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (!isValidHerdrId(record.paneId)) return undefined;
  return {
    paneId: record.paneId,
    tabId: isValidHerdrId(record.tabId) ? record.tabId : undefined,
    socketPath: isValidSocketPath(record.socketPath) ? record.socketPath : undefined,
  };
}

/** Runs the herdr CLI; resolves on exit code 0, rejects otherwise. Injectable for tests. */
export type HerdrCommandRunner = (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<void>;

const commandTimeoutMs = 3_000;

const defaultRunner: HerdrCommandRunner = (args, env) =>
  new Promise<void>((resolve, reject) => {
    execFile("herdr", [...args], { env, timeout: commandTimeoutMs, windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

/**
 * Ask herdr to focus the session's pane (falling back to its tab). Resolves
 * true when a command succeeded, false otherwise. Never throws.
 */
export async function focusHerdrPane(context: HerdrFocusContext, runner: HerdrCommandRunner = defaultRunner): Promise<boolean> {
  const env: NodeJS.ProcessEnv = context.socketPath ? { ...process.env, HERDR_SOCKET_PATH: context.socketPath } : process.env;
  try {
    await runner(["agent", "focus", context.paneId], env);
    log("info", "herdr pane focus dispatched", { paneId: context.paneId });
    return true;
  } catch (err) {
    log("debug", "herdr agent focus failed", { paneId: context.paneId, error: String(err) });
  }
  if (context.tabId === undefined) return false;
  try {
    await runner(["tab", "focus", context.tabId], env);
    log("info", "herdr tab focus dispatched (fallback)", { tabId: context.tabId });
    return true;
  } catch (err) {
    log("debug", "herdr tab focus failed", { tabId: context.tabId, error: String(err) });
    return false;
  }
}
