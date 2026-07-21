/**
 * session-live-status.ts — per-session activity status derived from hook
 * reactions (thinking/editing/running/testing/waiting), decaying to idle
 * after `decayMs` (default 30s) of no new reaction.
 */

export type LiveStatus = "idle" | "thinking" | "editing" | "running" | "testing" | "waiting";

const reactionToStatus: Record<string, LiveStatus> = {
  thinking: "thinking",
  editing: "editing",
  running: "running",
  testing: "testing",
  waiting: "waiting",
};

export class SessionLiveStatusTracker {
  readonly #entries = new Map<string, { status: LiveStatus; updatedAt: number }>();
  readonly #now: () => number;
  readonly #decayMs: number;

  constructor(options: { now?: () => number; decayMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#decayMs = options.decayMs ?? 30_000;
  }

  update(sessionKey: string, reaction: string): void {
    const status = reactionToStatus[reaction];
    if (!status) {
      this.#entries.delete(sessionKey);
      return;
    }
    this.#entries.set(sessionKey, { status, updatedAt: this.#now() });
  }

  get(sessionKey: string): LiveStatus {
    const entry = this.#entries.get(sessionKey);
    if (!entry) return "idle";
    if (this.#now() - entry.updatedAt > this.#decayMs) {
      this.#entries.delete(sessionKey);
      return "idle";
    }
    return entry.status;
  }

  remove(sessionKey: string): void {
    this.#entries.delete(sessionKey);
  }

  all(): ReadonlyMap<string, LiveStatus> {
    const now = this.#now();
    const result = new Map<string, LiveStatus>();
    for (const [key, entry] of this.#entries) {
      if (now - entry.updatedAt <= this.#decayMs) {
        result.set(key, entry.status);
      }
    }
    return result;
  }
}
