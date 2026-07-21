/**
 * window-pet-registry.ts — window-keyed pet lifecycle.
 *
 * Owns window→pet bindings and per-binding notification stores, and decides
 * spawn/close/rebind. Side effects (Electron windows) are injected callbacks
 * so the module stays pure and unit-testable. No electron imports.
 */

import { NotificationStore } from "./notification-store.js";

export type WindowKey = string;

export function windowKeyForIdentity(terminalWindowId: number | undefined, terminalOwnerPid: number): WindowKey {
  return terminalWindowId !== undefined ? `w:${terminalWindowId}` : `p:${terminalOwnerPid}`;
}

export interface RegistrySessionInfo {
  readonly sessionKey: string; // `${clientPid}:${sessionNonce}`
  readonly leaseId: string;
  readonly terminalOwnerPid: number;
  readonly terminalWindowId?: number;
  readonly label: string;
  readonly cwd?: string;
}

export type PetCloseReason = "window-dead" | "session-ended" | "user-closed" | "rebind" | "pool-disabled";

export interface RegistryCallbacks {
  spawnPet(windowKey: WindowKey, petId: string): void;
  closePet(windowKey: WindowKey, petId: string, reason: PetCloseReason): void;
  rebindPet(windowKey: WindowKey, fromPetId: string, toPetId: string): void;
  sessionEndedNotice(label: string, petId: string, windowKey: WindowKey): void;
}

type TrackedSession = RegistrySessionInfo & { lastActivityAt: number };

interface Binding {
  petId: string;
  origin: "explicit" | "pool";
  readonly sessions: Map<string, TrackedSession>;
  readonly store: NotificationStore;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class WindowPetRegistry {
  readonly defaultStore: NotificationStore;

  readonly #callbacks: RegistryCallbacks;
  readonly #now: () => number;
  readonly #isPidAlive: (pid: number) => boolean;
  readonly #drawPoolPet: (occupiedPetIds: ReadonlySet<string>) => string | null;
  readonly #storeFactory: () => NotificationStore;
  readonly #resolveRememberedPet: (cwd: string | undefined, occupiedPetIds: ReadonlySet<string>) => string | null;
  readonly #onPoolPetDrawn: (cwd: string | undefined, petId: string) => void;

  readonly #bindings = new Map<WindowKey, Binding>();
  readonly #sessionWindows = new Map<string, WindowKey>(); // binding membership only
  readonly #userClosedWindows = new Set<WindowKey>();
  readonly #suspendedPoolWindows = new Set<WindowKey>();
  readonly #defaultSessions = new Map<string, TrackedSession>();
  readonly #dormantBindings = new Map<WindowKey, { petId: string; origin: "explicit" | "pool"; store: NotificationStore; dormantSince: number }>();

  constructor(options: {
    callbacks: RegistryCallbacks;
    now?: () => number;
    isPidAlive?: (pid: number) => boolean;
    drawPoolPet?: (occupiedPetIds: ReadonlySet<string>) => string | null;
    storeFactory?: () => NotificationStore;
    resolveRememberedPet?: (cwd: string | undefined, occupiedPetIds: ReadonlySet<string>) => string | null;
    onPoolPetDrawn?: (cwd: string | undefined, petId: string) => void;
  }) {
    this.#callbacks = options.callbacks;
    this.#now = options.now ?? Date.now;
    this.#isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.#drawPoolPet = options.drawPoolPet ?? (() => null);
    this.#storeFactory = options.storeFactory ?? (() => new NotificationStore());
    this.#resolveRememberedPet = options.resolveRememberedPet ?? (() => null);
    this.#onPoolPetDrawn = options.onPoolPetDrawn ?? (() => {});
    this.defaultStore = this.#storeFactory();
  }

  onSessionIdentified(session: RegistrySessionInfo, requestedPetId: string | null | undefined, poolEnabled: boolean): string | null {
    const windowKey = windowKeyForIdentity(session.terminalWindowId, session.terminalOwnerPid);
    this.#detachFromStaleWindow(session.sessionKey, windowKey);

    // Explicitly default (adopt-to-default / UI "Default"): unbind and suppress
    // future auto-binds for this window; the session falls to default coverage.
    if (requestedPetId === null) {
      this.#userClosedWindows.add(windowKey);
      if (this.#bindings.has(windowKey)) this.#closeBinding(windowKey, "user-closed");
      this.#trackDefault(session);
      return null;
    }

    if (requestedPetId !== undefined) {
      this.#userClosedWindows.delete(windowKey);
      return this.#bindExplicit(windowKey, requestedPetId, session);
    }

    const existing = this.#bindings.get(windowKey);
    if (existing) {
      this.#attachSession(windowKey, existing, session);
      return existing.petId;
    }

    // Reactivate a dormant binding for this window — same pet, no pool draw.
    const dormant = this.#dormantBindings.get(windowKey);
    if (dormant) {
      this.#dormantBindings.delete(windowKey);
      const binding = this.#createBinding(windowKey, dormant.petId, dormant.origin);
      this.#attachSession(windowKey, binding, session);
      return dormant.petId;
    }

    if (!this.#userClosedWindows.has(windowKey)) {
      // Project memory: a previously-called pet for this session's project.
      const remembered = this.#resolveRememberedPet(session.cwd, new Set(this.boundPetIds()));
      if (remembered !== null) {
        const binding = this.#createBinding(windowKey, remembered, "explicit");
        this.#attachSession(windowKey, binding, session);
        this.#callbacks.spawnPet(windowKey, remembered);
        return remembered;
      }
      if (poolEnabled) {
        const drawn = this.#drawPoolPet(new Set(this.boundPetIds()));
        if (drawn !== null) {
          const binding = this.#createBinding(windowKey, drawn, "pool");
          this.#attachSession(windowKey, binding, session);
          this.#onPoolPetDrawn(session.cwd, drawn);
          this.#callbacks.spawnPet(windowKey, drawn);
          return drawn;
        }
      }
    }

    this.#trackDefault(session);
    return null;
  }

  onSessionAdopted(session: RegistrySessionInfo, petId: string): void {
    this.onSessionIdentified(session, petId, false);
  }

  onSessionGone(sessionKey: string): void {
    if (this.#defaultSessions.delete(sessionKey)) {
      this.defaultStore.removeSession(sessionKey);
      return;
    }
    const windowKey = this.#sessionWindows.get(sessionKey);
    if (windowKey === undefined) {
      this.defaultStore.removeSession(sessionKey);
      return;
    }
    this.#sessionWindows.delete(sessionKey);
    const binding = this.#bindings.get(windowKey);
    if (!binding) return;
    const info = binding.sessions.get(sessionKey);
    binding.sessions.delete(sessionKey);
    binding.store.removeSession(sessionKey);
    if (binding.sessions.size > 0 || !info) return;
    // Move to dormant instead of closing immediately — a returning session
    // on the same window reactivates with the same pet.
    if (this.#isPidAlive(info.terminalOwnerPid)) {
      this.#bindings.delete(windowKey);
      this.#dormantBindings.set(windowKey, { petId: binding.petId, origin: binding.origin, store: binding.store, dormantSince: this.#now() });
      this.#callbacks.sessionEndedNotice(info.label, binding.petId, windowKey);
    } else {
      this.#bindings.delete(windowKey);
      this.#callbacks.closePet(windowKey, binding.petId, "window-dead");
    }
  }

  onUserClosedPet(windowKey: WindowKey): void {
    this.#userClosedWindows.add(windowKey);
    if (this.#bindings.has(windowKey)) this.#closeBinding(windowKey, "user-closed");
  }

  /**
   * Control-Center assignment: "this window's pet is now X" (petId) or
   * "this window returns to the default pet" (null). Move semantics match
   * onSessionAdopted; null matches onUserClosedPet (suppresses auto-binds).
   * Returns false when the window has no sessions to (re)bind.
   */
  assignPetToWindow(windowKey: WindowKey, petId: string | null): boolean {
    if (petId === null) {
      const had = this.#bindings.has(windowKey) || this.#hasDefaultSessionsForWindow(windowKey);
      this.#userClosedWindows.add(windowKey);
      if (this.#bindings.has(windowKey)) this.#closeBinding(windowKey, "user-closed");
      return had;
    }
    // Validate the target window can accept the pet BEFORE mutating anything —
    // a stale UI snapshot can request a steal into a window whose sessions all
    // disconnected since render. Discovering that after already stealing from
    // the other window (or clearing user-closed) would leave the pet bound
    // nowhere while having mutated two pieces of state for a "failed" assign.
    const current = this.#bindings.get(windowKey);
    if (current && current.petId === petId) {
      this.#userClosedWindows.delete(windowKey);
      return true;
    }
    const parked = [...this.#defaultSessions.values()].filter(
      (s) => windowKeyForIdentity(s.terminalWindowId, s.terminalOwnerPid) === windowKey,
    );
    if (!current && parked.length === 0) return false;

    this.#userClosedWindows.delete(windowKey);
    const otherKey = this.windowForPet(petId);
    if (otherKey !== null && otherKey !== windowKey) this.#closeBinding(otherKey, "rebind");
    if (current) {
      const fromPetId = current.petId;
      current.petId = petId;
      current.origin = "explicit";
      this.#callbacks.rebindPet(windowKey, fromPetId, petId);
      return true;
    }
    const binding = this.#createBinding(windowKey, petId, "explicit");
    for (const session of parked) this.#attachSession(windowKey, binding, session);
    this.#callbacks.spawnPet(windowKey, petId);
    return true;
  }

  #hasDefaultSessionsForWindow(windowKey: WindowKey): boolean {
    for (const s of this.#defaultSessions.values()) {
      if (windowKeyForIdentity(s.terminalWindowId, s.terminalOwnerPid) === windowKey) return true;
    }
    return false;
  }

  onPoolDisabled(): void {
    for (const [windowKey, binding] of [...this.#bindings]) {
      if (binding.origin !== "pool") continue;
      this.#suspendedPoolWindows.add(windowKey);
      this.#closeBinding(windowKey, "pool-disabled");
    }
  }

  onPoolEnabled(): void {
    const suspended = [...this.#suspendedPoolWindows];
    this.#suspendedPoolWindows.clear();
    for (const windowKey of suspended) {
      if (this.#bindings.has(windowKey) || this.#userClosedWindows.has(windowKey)) continue;
      const parked = [...this.#defaultSessions.values()].filter(
        (s) => windowKeyForIdentity(s.terminalWindowId, s.terminalOwnerPid) === windowKey,
      );
      if (parked.length === 0) continue;
      const drawn = this.#drawPoolPet(new Set(this.boundPetIds()));
      if (drawn === null) continue;
      const binding = this.#createBinding(windowKey, drawn, "pool");
      for (const parkedSession of parked) this.#attachSession(windowKey, binding, parkedSession);
      this.#callbacks.spawnPet(windowKey, drawn);
    }
  }

  petForWindow(windowKey: WindowKey): string | null {
    return this.#bindings.get(windowKey)?.petId ?? null;
  }

  windowForPet(petId: string): WindowKey | null {
    for (const [windowKey, binding] of this.#bindings) {
      if (binding.petId === petId) return windowKey;
    }
    return null;
  }

  displayPetForSession(sessionKey: string): { petId: string; origin: "explicit" | "pool" } | null {
    const windowKey = this.#sessionWindows.get(sessionKey);
    if (windowKey === undefined) return null;
    const binding = this.#bindings.get(windowKey);
    return binding ? { petId: binding.petId, origin: binding.origin } : null;
  }

  storeForPet(petId: string): NotificationStore | null {
    const windowKey = this.windowForPet(petId);
    return windowKey !== null ? this.#bindings.get(windowKey)!.store : null;
  }

  storeForSession(sessionKey: string): NotificationStore {
    const windowKey = this.#sessionWindows.get(sessionKey);
    if (windowKey !== undefined) {
      const binding = this.#bindings.get(windowKey);
      if (binding) return binding.store;
    }
    return this.defaultStore;
  }

  touchSessionActivity(sessionKey: string): void {
    const tracked = this.#defaultSessions.get(sessionKey) ?? this.#bindingSession(sessionKey);
    if (tracked) tracked.lastActivityAt = this.#now();
  }

  resolveWindowFocus(windowKey: WindowKey): readonly string[] {
    const changed: string[] = [];
    const binding = this.#bindings.get(windowKey);
    if (binding && binding.store.resolveWindow(windowKey)) changed.push(binding.petId);
    if (this.defaultStore.resolveWindow(windowKey)) {
      // Default store changed — caller should refresh the default pet view.
    }
    return changed;
  }

  /** Resolve notifications for ALL window keys that share a terminal PID. */
  resolveWindowFocusByPid(ownerPid: number): readonly string[] {
    const changed: string[] = [];
    const pidKey = `p:${ownerPid}`;
    // Resolve on any binding whose sessions include this PID.
    for (const [wk, binding] of this.#bindings) {
      for (const session of binding.sessions.values()) {
        if (session.terminalOwnerPid === ownerPid) {
          if (binding.store.resolveWindow(wk)) changed.push(binding.petId);
          // Also resolve entries keyed by p:pid or w:windowId for this session.
          binding.store.resolveWindow(pidKey);
          if (session.terminalWindowId !== undefined) binding.store.resolveWindow(`w:${session.terminalWindowId}`);
          break;
        }
      }
    }
    // Default store: resolve by both p:pid and any w:windowId matching sessions with this PID.
    this.defaultStore.resolveWindow(pidKey);
    for (const session of this.#defaultSessions.values()) {
      if (session.terminalOwnerPid === ownerPid && session.terminalWindowId !== undefined) {
        this.defaultStore.resolveWindow(`w:${session.terminalWindowId}`);
      }
    }
    return changed;
  }

  focusTargetForPet(petId: string): { terminalOwnerPid: number; terminalWindowId?: number; leaseId?: string } | null {
    const windowKey = this.windowForPet(petId);
    if (windowKey === null) return null;
    const binding = this.#bindings.get(windowKey)!;
    return this.#focusTarget(binding.store, binding.sessions);
  }

  focusTargetForDefault(): { terminalOwnerPid: number; terminalWindowId?: number; leaseId?: string } | null {
    return this.#focusTarget(this.defaultStore, this.#defaultSessions);
  }

  /**
   * Look up the specific session's own focus target, regardless of which
   * pet (or default coverage) it currently belongs to. Used for row-level
   * "focus this notification" actions so the click raises the window that
   * actually owns that session — not just the aggregate target for the pet,
   * which can differ when a pet's coverage spans multiple terminal windows.
   */
  sessionFocusTarget(
    sessionKey: string,
  ): { terminalOwnerPid: number; terminalWindowId?: number; leaseId?: string } | null {
    const parked = this.#defaultSessions.get(sessionKey);
    if (parked) {
      return { terminalOwnerPid: parked.terminalOwnerPid, terminalWindowId: parked.terminalWindowId, leaseId: parked.leaseId };
    }
    for (const binding of this.#bindings.values()) {
      const info = binding.sessions.get(sessionKey);
      if (info) return { terminalOwnerPid: info.terminalOwnerPid, terminalWindowId: info.terminalWindowId, leaseId: info.leaseId };
    }
    return null;
  }

  boundPetIds(): readonly string[] {
    const ids = [...this.#bindings.values()].map((binding) => binding.petId);
    for (const dormant of this.#dormantBindings.values()) ids.push(dormant.petId);
    return ids;
  }

  cleanupDormantBindings(maxAgeMs: number): void {
    const cutoff = this.#now() - maxAgeMs;
    for (const [windowKey, dormant] of [...this.#dormantBindings]) {
      if (dormant.dormantSince <= cutoff) {
        this.#dormantBindings.delete(windowKey);
        this.#callbacks.closePet(windowKey, dormant.petId, "session-ended");
      }
    }
  }

  #focusTarget(
    _store: NotificationStore,
    sessions: ReadonlyMap<string, TrackedSession>,
  ): { terminalOwnerPid: number; terminalWindowId?: number; leaseId?: string } | null {
    let best: TrackedSession | null = null;
    for (const info of sessions.values()) {
      if (!best || info.lastActivityAt > best.lastActivityAt) best = info;
    }
    return best ? { terminalOwnerPid: best.terminalOwnerPid, terminalWindowId: best.terminalWindowId, leaseId: best.leaseId } : null;
  }

  #bindExplicit(windowKey: WindowKey, petId: string, session: RegistrySessionInfo): string {
    const current = this.#bindings.get(windowKey);
    if (current && current.petId === petId) {
      this.#attachSession(windowKey, current, session);
      return petId;
    }
    // Pet bound elsewhere → move semantics: close the old binding, its sessions fall to default.
    const otherKey = this.windowForPet(petId);
    if (otherKey !== null && otherKey !== windowKey) this.#closeBinding(otherKey, "rebind");
    if (current) {
      const fromPetId = current.petId;
      current.petId = petId;
      current.origin = "explicit";
      this.#attachSession(windowKey, current, session);
      this.#callbacks.rebindPet(windowKey, fromPetId, petId);
    } else {
      const binding = this.#createBinding(windowKey, petId, "explicit");
      this.#attachSession(windowKey, binding, session);
      this.#callbacks.spawnPet(windowKey, petId);
    }
    return petId;
  }

  #createBinding(windowKey: WindowKey, petId: string, origin: "explicit" | "pool"): Binding {
    const binding: Binding = { petId, origin, sessions: new Map(), store: this.#storeFactory() };
    this.#bindings.set(windowKey, binding);
    return binding;
  }

  /** Close a binding: park its sessions in default coverage, carry their rows to defaultStore. */
  #closeBinding(windowKey: WindowKey, reason: PetCloseReason): void {
    const binding = this.#bindings.get(windowKey);
    if (!binding) return;
    this.#bindings.delete(windowKey);
    for (const [sessionKey, tracked] of binding.sessions) {
      this.#sessionWindows.delete(sessionKey);
      this.#defaultSessions.set(sessionKey, tracked);
      const entry = binding.store.removeSession(sessionKey);
      if (entry) this.defaultStore.adoptEntries([entry]);
    }
    this.#callbacks.closePet(windowKey, binding.petId, reason);
  }

  /** Track under the binding, moving the session (and its notification row) out of default coverage. */
  #attachSession(windowKey: WindowKey, binding: Binding, session: RegistrySessionInfo): void {
    const parked = this.#defaultSessions.get(session.sessionKey);
    if (parked) {
      this.#defaultSessions.delete(session.sessionKey);
      const entry = this.defaultStore.removeSession(session.sessionKey);
      if (entry) binding.store.adoptEntries([entry]);
    }
    const existing = binding.sessions.get(session.sessionKey);
    binding.sessions.set(session.sessionKey, { ...session, lastActivityAt: existing?.lastActivityAt ?? this.#now() });
    this.#sessionWindows.set(session.sessionKey, windowKey);
  }

  #trackDefault(session: RegistrySessionInfo): void {
    const existing = this.#defaultSessions.get(session.sessionKey);
    this.#defaultSessions.set(session.sessionKey, { ...session, lastActivityAt: existing?.lastActivityAt ?? this.#now() });
  }

  /** If the session's window identity changed since last seen, detach it from its old spot. */
  #detachFromStaleWindow(sessionKey: string, windowKey: WindowKey): void {
    const previous = this.#sessionWindows.get(sessionKey);
    if (previous === undefined || previous === windowKey) return;
    this.#sessionWindows.delete(sessionKey);
    const binding = this.#bindings.get(previous);
    if (!binding) return;
    const tracked = binding.sessions.get(sessionKey);
    binding.sessions.delete(sessionKey);
    if (tracked) this.#defaultSessions.set(sessionKey, tracked);
    const entry = binding.store.removeSession(sessionKey);
    if (entry) this.defaultStore.adoptEntries([entry]);
    if (binding.sessions.size === 0) {
      this.#bindings.delete(previous);
      this.#callbacks.closePet(previous, binding.petId, "rebind");
    }
  }

  #bindingSession(sessionKey: string): TrackedSession | undefined {
    const windowKey = this.#sessionWindows.get(sessionKey);
    if (windowKey === undefined) return undefined;
    return this.#bindings.get(windowKey)?.sessions.get(sessionKey);
  }
}
