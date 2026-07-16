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

  readonly #bindings = new Map<WindowKey, Binding>();
  readonly #sessionWindows = new Map<string, WindowKey>(); // binding membership only
  readonly #userClosedWindows = new Set<WindowKey>();
  readonly #suspendedPoolWindows = new Set<WindowKey>();
  readonly #defaultSessions = new Map<string, TrackedSession>();

  constructor(options: {
    callbacks: RegistryCallbacks;
    now?: () => number;
    isPidAlive?: (pid: number) => boolean;
    drawPoolPet?: (occupiedPetIds: ReadonlySet<string>) => string | null;
    storeFactory?: () => NotificationStore;
  }) {
    this.#callbacks = options.callbacks;
    this.#now = options.now ?? Date.now;
    this.#isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.#drawPoolPet = options.drawPoolPet ?? (() => null);
    this.#storeFactory = options.storeFactory ?? (() => new NotificationStore());
    this.defaultStore = this.#storeFactory();
  }

  onSessionIdentified(session: RegistrySessionInfo, requestedPetId: string | undefined, poolEnabled: boolean): string | null {
    const windowKey = windowKeyForIdentity(session.terminalWindowId, session.terminalOwnerPid);
    this.#detachFromStaleWindow(session.sessionKey, windowKey);

    if (requestedPetId !== undefined) {
      this.#userClosedWindows.delete(windowKey);
      return this.#bindExplicit(windowKey, requestedPetId, session);
    }

    const existing = this.#bindings.get(windowKey);
    if (existing) {
      this.#attachSession(windowKey, existing, session);
      return existing.petId;
    }

    if (poolEnabled && !this.#userClosedWindows.has(windowKey)) {
      const drawn = this.#drawPoolPet(new Set(this.boundPetIds()));
      if (drawn !== null) {
        const binding = this.#createBinding(windowKey, drawn, "pool");
        this.#attachSession(windowKey, binding, session);
        this.#callbacks.spawnPet(windowKey, drawn);
        return drawn;
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
    this.#bindings.delete(windowKey);
    if (this.#isPidAlive(info.terminalOwnerPid)) {
      this.#callbacks.sessionEndedNotice(info.label, binding.petId, windowKey);
      this.#callbacks.closePet(windowKey, binding.petId, "session-ended");
    } else {
      this.#callbacks.closePet(windowKey, binding.petId, "window-dead");
    }
  }

  onUserClosedPet(windowKey: WindowKey): void {
    this.#userClosedWindows.add(windowKey);
    if (this.#bindings.has(windowKey)) this.#closeBinding(windowKey, "user-closed");
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

  focusTargetForPet(petId: string): { terminalOwnerPid: number; terminalWindowId?: number } | null {
    const windowKey = this.windowForPet(petId);
    if (windowKey === null) return null;
    const binding = this.#bindings.get(windowKey)!;
    return this.#focusTarget(binding.store, binding.sessions);
  }

  focusTargetForDefault(): { terminalOwnerPid: number; terminalWindowId?: number } | null {
    return this.#focusTarget(this.defaultStore, this.#defaultSessions);
  }

  /**
   * Look up the specific session's own focus target, regardless of which
   * pet (or default coverage) it currently belongs to. Used for row-level
   * "focus this notification" actions so the click raises the window that
   * actually owns that session — not just the aggregate target for the pet,
   * which can differ when a pet's coverage spans multiple terminal windows.
   */
  sessionFocusTarget(sessionKey: string): { terminalOwnerPid: number; terminalWindowId?: number } | null {
    const parked = this.#defaultSessions.get(sessionKey);
    if (parked) return { terminalOwnerPid: parked.terminalOwnerPid, terminalWindowId: parked.terminalWindowId };
    for (const binding of this.#bindings.values()) {
      const info = binding.sessions.get(sessionKey);
      if (info) return { terminalOwnerPid: info.terminalOwnerPid, terminalWindowId: info.terminalWindowId };
    }
    return null;
  }

  boundPetIds(): readonly string[] {
    return [...this.#bindings.values()].map((binding) => binding.petId);
  }

  #focusTarget(
    store: NotificationStore,
    sessions: ReadonlyMap<string, TrackedSession>,
  ): { terminalOwnerPid: number; terminalWindowId?: number } | null {
    const oldest = store.oldestUnresolved();
    if (oldest) {
      const info = sessions.get(oldest.sessionKey);
      if (info) return { terminalOwnerPid: info.terminalOwnerPid, terminalWindowId: info.terminalWindowId };
    }
    let best: TrackedSession | null = null;
    for (const info of sessions.values()) {
      if (!best || info.lastActivityAt > best.lastActivityAt) best = info;
    }
    return best ? { terminalOwnerPid: best.terminalOwnerPid, terminalWindowId: best.terminalWindowId } : null;
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
