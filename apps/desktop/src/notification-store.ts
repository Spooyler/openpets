/**
 * notification-store.ts — pure per-pet notification state.
 *
 * One live row per session: record() upserts by sessionKey. Rows persist
 * until resolved (double-click / window focus), dismissed (row right-click),
 * or removed (session teardown). Policy map decides persistent|fade|off per
 * kind; v1 callers pass no policy (everything persistent).
 */

export type NotificationEntryState = "unresolved" | "resolved" | "dismissed";
export type NotificationPolicyMode = "persistent" | "fade" | "off";

export interface NotificationEntry {
  readonly sessionKey: string;
  readonly windowKey?: string;
  readonly terminalAppName?: string;
  readonly kind: string;
  readonly message: string;
  readonly label: string;
  readonly updatedAt: number;
  readonly firstUnresolvedAt: number;
  readonly state: NotificationEntryState;
}

export function sessionLabelFromCwd(cwd: string | undefined, fallback: string): string {
  if (!cwd) return fallback;
  const parts = cwd.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]! : fallback;
}

export class NotificationStore {
  readonly #entries = new Map<string, NotificationEntry>();
  readonly #now: () => number;
  readonly #policy: (kind: string) => NotificationPolicyMode;
  readonly #fadeMs: number;

  constructor(options: { now?: () => number; policy?: (kind: string) => NotificationPolicyMode; fadeMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#policy = options.policy ?? (() => "persistent");
    this.#fadeMs = options.fadeMs ?? 60_000;
  }

  record(input: { sessionKey: string; windowKey?: string; terminalAppName?: string; kind: string; message: string; label: string }): void {
    if (this.#policy(input.kind) === "off") return;
    const now = this.#now();
    const existing = this.#entries.get(input.sessionKey);
    const wasUnresolved = existing?.state === "unresolved";
    this.#entries.set(input.sessionKey, {
      sessionKey: input.sessionKey,
      windowKey: input.windowKey ?? existing?.windowKey,
      terminalAppName: input.terminalAppName ?? existing?.terminalAppName,
      kind: input.kind,
      message: input.message,
      label: input.label,
      updatedAt: now,
      firstUnresolvedAt: wasUnresolved ? existing.firstUnresolvedAt : now,
      state: "unresolved",
    });
  }

  resolveSession(sessionKey: string): boolean {
    const entry = this.#entries.get(sessionKey);
    if (!entry || entry.state !== "unresolved") return false;
    this.#entries.set(sessionKey, { ...entry, state: "resolved" });
    return true;
  }

  resolveWindow(windowKey: string): boolean {
    let changed = false;
    for (const entry of this.#entries.values()) {
      if (entry.windowKey === windowKey && entry.state === "unresolved") {
        this.#entries.set(entry.sessionKey, { ...entry, state: "resolved" });
        changed = true;
      }
    }
    return changed;
  }

  dismissSession(sessionKey: string): boolean {
    const entry = this.#entries.get(sessionKey);
    if (!entry || entry.state === "dismissed") return false;
    this.#entries.set(sessionKey, { ...entry, state: "dismissed" });
    return true;
  }

  removeSession(sessionKey: string): NotificationEntry | null {
    const entry = this.#entries.get(sessionKey) ?? null;
    this.#entries.delete(sessionKey);
    return entry;
  }

  adoptEntries(entries: readonly NotificationEntry[]): void {
    for (const entry of entries) this.#entries.set(entry.sessionKey, entry);
  }

  unresolvedCount(): number {
    this.#applyFade();
    let count = 0;
    for (const entry of this.#entries.values()) if (entry.state === "unresolved") count += 1;
    return count;
  }

  oldestUnresolved(): NotificationEntry | null {
    this.#applyFade();
    let best: NotificationEntry | null = null;
    for (const entry of this.#entries.values()) {
      if (entry.state !== "unresolved") continue;
      if (!best || entry.firstUnresolvedAt < best.firstUnresolvedAt) best = entry;
    }
    return best;
  }

  /** Unresolved rows oldest-first, then non-dismissed resolved rows by recency. */
  rows(): readonly NotificationEntry[] {
    this.#applyFade();
    const unresolved: NotificationEntry[] = [];
    const resolved: NotificationEntry[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.state === "unresolved") unresolved.push(entry);
      else if (entry.state === "resolved") resolved.push(entry);
    }
    unresolved.sort((a, b) => a.firstUnresolvedAt - b.firstUnresolvedAt);
    resolved.sort((a, b) => b.updatedAt - a.updatedAt);
    return [...unresolved, ...resolved];
  }

  clear(): void {
    this.#entries.clear();
  }

  #applyFade(): void {
    const now = this.#now();
    for (const entry of this.#entries.values()) {
      if (entry.state !== "unresolved") continue;
      if (this.#policy(entry.kind) === "fade" && now - entry.firstUnresolvedAt > this.#fadeMs) {
        this.#entries.set(entry.sessionKey, { ...entry, state: "resolved" });
      }
    }
  }
}
