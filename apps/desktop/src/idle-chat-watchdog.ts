/**
 * idle-chat-watchdog.ts — pure idle-session watchdog (no Electron).
 *
 * Watches live agent-session leases and, per idle stretch:
 *   1. Warns once through the session's pet when the chat has been idle for
 *      `idleChatWarnMinutes` (speech bubble + notification row).
 *   2. Optionally auto-compacts once at AUTO_COMPACT_MINUTES by injecting
 *      the /compact command into the session's console (Windows only, opt-in
 *      via `idleChatAutoCompactEnabled`).
 *
 * Idle time is measured from the freshest of: the lease's lastActivityAt
 * (touched by every hook-driven say/react), the lease's acquiredAt, and the
 * last statusline busy ping (`noteBusyPing`), so a session mid-long-tool-run
 * with a live statusline never reads as idle. Any forward movement of that
 * baseline resets the warned/compacted flags — a new idle stretch starts
 * fresh. Lease death removes all watchdog state for the session.
 *
 * The module is deliberately dependency-injected (same pattern as
 * lease-manager.ts) so the idle→warn→compact→reset state machine can be
 * unit-tested with a fake clock and without Electron.
 */

export const AUTO_COMPACT_MINUTES = 59;
export const DEFAULT_TICK_MS = 30_000;

/** Structural subset of PetLease the watchdog needs. */
export interface IdleChatSession {
  readonly leaseId: string;
  readonly acquiredAt: number;
  readonly lastActivityAt?: number;
  readonly clientPid?: number;
}

export interface IdleChatSettings {
  readonly warnEnabled: boolean;
  readonly warnMinutes: number;
  readonly autoCompactEnabled: boolean;
}

export interface IdleChatWatchdogDeps {
  readonly listSessions: () => readonly IdleChatSession[];
  readonly getSettings: () => IdleChatSettings;
  /** Speak the idle warning through the session's pet + record a notification row. */
  readonly warn: (session: IdleChatSession, idleMinutes: number) => void;
  /**
   * Inject /compact into the session's console. Resolves true when the
   * injection was dispatched. The callee owns success/failure UX.
   */
  readonly compact: (session: IdleChatSession) => Promise<boolean>;
  readonly now?: () => number;
  readonly tickMs?: number;
  /** Platform gate for auto-compact; defaults to win32. Injectable for tests. */
  readonly autoCompactSupported?: boolean;
}

interface SessionWatchState {
  /** Idle baseline (ms epoch) the warned/compacted flags belong to. */
  baseline: number;
  warned: boolean;
  compacted: boolean;
}

export interface IdleChatWatchdog {
  start(): void;
  stop(): void;
  /** Statusline `agent.activity` pings land here — they count as activity. */
  noteBusyPing(leaseId: string): void;
  /** One evaluation pass; exposed for the timer and for unit tests. */
  tick(): void;
}

export function createIdleChatWatchdog(deps: IdleChatWatchdogDeps): IdleChatWatchdog {
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  const autoCompactSupported = deps.autoCompactSupported ?? process.platform === "win32";

  const watched = new Map<string, SessionWatchState>();
  const busyPings = new Map<string, number>();
  let timer: NodeJS.Timeout | null = null;

  function baselineFor(session: IdleChatSession): number {
    return Math.max(session.lastActivityAt ?? 0, session.acquiredAt, busyPings.get(session.leaseId) ?? 0);
  }

  function tick(): void {
    const settings = deps.getSettings();
    const sessions = deps.listSessions();

    // Prune state for sessions whose lease is gone (released or expired).
    const liveIds = new Set(sessions.map((s) => s.leaseId));
    for (const leaseId of [...watched.keys()]) {
      if (!liveIds.has(leaseId)) watched.delete(leaseId);
    }
    for (const leaseId of [...busyPings.keys()]) {
      if (!liveIds.has(leaseId)) busyPings.delete(leaseId);
    }

    if (!settings.warnEnabled && !settings.autoCompactEnabled) return;

    const currentTime = now();
    for (const session of sessions) {
      const baseline = baselineFor(session);
      let state = watched.get(session.leaseId);
      if (!state) {
        state = { baseline, warned: false, compacted: false };
        watched.set(session.leaseId, state);
      } else if (baseline > state.baseline) {
        // Activity happened since the last stretch — start a fresh one.
        state.baseline = baseline;
        state.warned = false;
        state.compacted = false;
      }

      const idleMs = currentTime - state.baseline;
      const idleMinutes = Math.floor(idleMs / 60_000);

      if (settings.warnEnabled && !state.warned && idleMs >= settings.warnMinutes * 60_000) {
        state.warned = true;
        deps.warn(session, idleMinutes);
      }

      if (
        settings.autoCompactEnabled &&
        autoCompactSupported &&
        !state.compacted &&
        session.clientPid !== undefined &&
        idleMs >= AUTO_COMPACT_MINUTES * 60_000
      ) {
        // Flag before dispatch: one attempt per idle stretch, even on failure.
        state.compacted = true;
        void deps.compact(session);
      }
    }
  }

  return {
    start(): void {
      if (timer) return;
      timer = setInterval(tick, tickMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      watched.clear();
      busyPings.clear();
    },
    noteBusyPing(leaseId: string): void {
      busyPings.set(leaseId, now());
    },
    tick,
  };
}
