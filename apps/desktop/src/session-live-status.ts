/**
 * session-live-status.ts — per-session activity status derived from hook
 * reactions (thinking/editing/running/testing/waiting), decaying to idle
 * after `decayMs` (default 30s) of no new reaction. Herdr-driven reactions
 * ("herdr-waiting"/"herdr-running") never decay: herdr pushes only state
 * transitions, so its status holds until the next transition replaces it.
 */

export type LiveStatus = "idle" | "thinking" | "editing" | "running" | "testing" | "waiting";

const reactionToStatus: Record<string, LiveStatus> = {
  thinking: "thinking",
  editing: "editing",
  running: "running",
  testing: "testing",
  waiting: "waiting",
};

const herdrReactionToStatus: Record<string, LiveStatus> = {
  "herdr-waiting": "waiting",
  "herdr-running": "running",
};

export class SessionLiveStatusTracker {
  readonly #entries = new Map<string, { status: LiveStatus; updatedAt: number; sticky: boolean }>();
  readonly #now: () => number;
  readonly #decayMs: number;

  constructor(options: { now?: () => number; decayMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#decayMs = options.decayMs ?? 30_000;
  }

  update(sessionKey: string, reaction: string): void {
    const herdrStatus = herdrReactionToStatus[reaction];
    const status = herdrStatus ?? reactionToStatus[reaction];
    if (!status) {
      this.#entries.delete(sessionKey);
      return;
    }
    this.#entries.set(sessionKey, { status, updatedAt: this.#now(), sticky: herdrStatus !== undefined });
  }

  get(sessionKey: string): LiveStatus {
    const entry = this.#entries.get(sessionKey);
    if (!entry) return "idle";
    if (!entry.sticky && this.#now() - entry.updatedAt > this.#decayMs) {
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
      if (entry.sticky || now - entry.updatedAt <= this.#decayMs) {
        result.set(key, entry.status);
      }
    }
    return result;
  }
}
