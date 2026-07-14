# Pet Attention Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind pets to OS windows (one pet per window) instead of sessions, and add a per-pet notification centre (count badge + flyout) that routes you to the session window that needs attention.

**Architecture:** A new `window-pet-registry.ts` layered over the untouched lease machinery owns pet lifecycle keyed by window (`terminalWindowId` else `terminalOwnerPid`), replacing the `onFirstExplicitLease`/`onLastExplicitLease` lease-count hooks. Each binding — and the default pet — owns a pure `NotificationStore`; pet windows render a badge + flyout from store snapshots. Pool assignment moves out of the synchronous acquire path into the registry (per-window draw at identity-resolve time).

**Tech Stack:** Electron main process (TypeScript ESM), plain-Node assert tests compiled via `tsconfig.tests.json`, pnpm workspace packages (`@open-pets/client`, `@open-pets/mcp`, `@open-pets/claude`).

**Spec:** `docs/superpowers/specs/2026-07-14-pet-attention-model-design.md` — read it first.

## Global Constraints

- Protocol version stays `1`; the new `cwd` acquire param is additive and optional (`local-ipc-protocol.ts` validators never throw for optional params — they return `undefined`).
- Lease machinery semantics (TTL 15s, heartbeat, sessionNonce PID-reuse guard, `checkPidLiveness`) must not change.
- Unit-tested modules must not import `electron` at module load (use DI options or the `createRequire` lazy pattern from `pet-roaming-controller.ts:16-34`).
- Test files are NOT globbed: every new test/contract file MUST be appended to `behaviorTests`/`contractTests` in `apps/desktop/scripts/run-tests.mjs` or it will never run.
- Tests are plain Node scripts: `import assert from "node:assert/strict"`, top-level assertions, `console.log("... passed.")`, no test framework.
- `pet.say` messages stay ≤140 chars, single-line, no code/URL/path (validated by `validateSayMessage`).
- Windows (win32) is the primary target; macOS code paths must keep compiling; Linux focus stays unsupported (`focusActionAvailable: false`).
- All user-visible strings go through `t("...")` message keys (add to the EN catalog; other locales fall back to EN).
- Run from `apps/desktop/`: `pnpm typecheck` after each task, `pnpm test` for test steps, `pnpm check` at the end.
- Commit style: `feat(desktop): ...` / `feat(client): ...` / `test(desktop): ...` single line.

---

### Task 1: `cwd` on lease acquire (client → protocol → lease)

Notification rows are labeled with the project directory basename. Thread an optional `cwd` from the client into `PetLease`.

**Files:**
- Modify: `packages/client/src/index.ts:106`
- Modify: `apps/desktop/src/local-ipc-protocol.ts` (next to `validateSessionNonce`, lines 123-129)
- Modify: `apps/desktop/src/local-ipc.ts:386-408` (lease.acquire handler)
- Modify: `apps/desktop/src/lease-manager.ts` (PetLease + acquire)
- Test: `apps/desktop/contracts/local-ipc-protocol.contract.ts` (extend)
- Test: `apps/desktop/tests/lease-cwd.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `validateCwd(value: unknown): string | undefined`; `LeaseManager.acquire(requestedPetId?, clientPid?, sessionNonce?, cwd?)`; `PetLease.cwd?: string`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/contracts/local-ipc-protocol.contract.ts`:

```ts
// --- validateCwd (optional, tolerant — mirrors validateSessionNonce) ---
assert.equal(validateCwd(undefined), undefined, "cwd absent is fine");
assert.equal(validateCwd(42), undefined, "non-string cwd ignored");
assert.equal(validateCwd("  "), undefined, "blank cwd ignored");
assert.equal(validateCwd("C:\\Users\\me\\fraud_project"), "C:\\Users\\me\\fraud_project");
assert.equal(validateCwd("/home/me/api-fix"), "/home/me/api-fix");
assert.equal(validateCwd("x".repeat(1025)), undefined, "cwd >1024 chars ignored");
assert.equal(validateCwd("bad\u0000path"), undefined, "control chars rejected");
```

(add `validateCwd` to the existing import from `../src/local-ipc-protocol.js`.)

Create `apps/desktop/tests/lease-cwd.test.ts`:

```ts
import assert from "node:assert/strict";
import { LeaseManager } from "../src/lease-manager.js";

let now = 1_000;
const manager = new LeaseManager({
  ttlMs: 100,
  now: () => now,
  resolveTarget: () => ({ targetKind: "default" as const, actualPetId: "builtin" }),
  getDefaultPetId: () => "builtin",
  getPetDisplayName: (petId) => petId,
});

const lease = manager.acquire(undefined, 4242, "nonce-1", "C:\\Users\\me\\fraud_project");
const raw = manager.getRawLease(lease.leaseId);
assert.equal(raw?.cwd, "C:\\Users\\me\\fraud_project", "cwd stored on lease");

// Idempotent reuse keeps cwd.
now += 10;
const reused = manager.acquire(undefined, 4242, "nonce-1", "C:\\Users\\me\\fraud_project");
assert.equal(reused.leaseId, lease.leaseId, "same lease reused");
assert.equal(manager.getRawLease(reused.leaseId)?.cwd, "C:\\Users\\me\\fraud_project");

console.log("Lease cwd threading passed.");
```

- [ ] **Step 2: Register the test and verify both fail**

Add `".test-dist/tests/lease-cwd.test.js"` to `behaviorTests` in `apps/desktop/scripts/run-tests.mjs`.

Run: `pnpm test` (from `apps/desktop/`)
Expected: FAIL — `validateCwd` is not exported; `acquire` has no 4th param.

- [ ] **Step 3: Implement**

`apps/desktop/src/local-ipc-protocol.ts`, directly below `validateSessionNonce`:

```ts
/** Optional working-directory string on lease.acquire. Tolerant: returns
 * undefined for anything malformed instead of throwing. */
export function validateCwd(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1024) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(trimmed)) return undefined;
  return trimmed;
}
```

`apps/desktop/src/lease-manager.ts`:
- Add to `PetLease` (after `sessionNonce`, ~line 25): `readonly cwd?: string;`
- `acquire` signature (line 104): `acquire(requestedPetId?: string, clientPid?: number, sessionNonce?: string, cwd?: string): LeaseSnapshot`
- Fresh-lease literal (~line 146-157): add `cwd,` after `sessionNonce,`.
- The idempotent-reuse path spreads `...existing`, so cwd survives automatically.

`apps/desktop/src/local-ipc.ts` lease.acquire handler (386-408): alongside the existing param reads add
`const cwd = validateCwd(params.cwd);` (import `validateCwd` from `./local-ipc-protocol.js`) and pass it: `leaseManager.acquire(requestedPetId, clientPid, sessionNonce, cwd)`.

`packages/client/src/index.ts:106` — add `cwd: process.cwd(),` to the `lease.acquire` params object next to `clientPid: process.pid`. This covers the MCP server AND `--pet` hook leases for free.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS (all suites, including the two new blocks).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/index.ts apps/desktop/src/local-ipc-protocol.ts apps/desktop/src/local-ipc.ts apps/desktop/src/lease-manager.ts apps/desktop/contracts/local-ipc-protocol.contract.ts apps/desktop/tests/lease-cwd.test.ts apps/desktop/scripts/run-tests.mjs
git commit -m "feat: thread client cwd through lease acquire for session labels"
```

---

### Task 2: `notification-store.ts` — pure per-pet notification state

**Files:**
- Create: `apps/desktop/src/notification-store.ts`
- Test: `apps/desktop/tests/notification-store.test.ts`

**Interfaces:**
- Consumes: nothing (pure; DI `now`).
- Produces (used by Tasks 3-6):

```ts
export type NotificationEntryState = "unresolved" | "resolved" | "dismissed";
export type NotificationPolicyMode = "persistent" | "fade" | "off";
export interface NotificationEntry {
  readonly sessionKey: string;
  readonly windowKey?: string;
  readonly kind: string;           // reaction name or "message"
  readonly message: string;
  readonly label: string;          // cwd basename / app name fallback
  readonly updatedAt: number;
  readonly firstUnresolvedAt: number;
  readonly state: NotificationEntryState;
}
export function sessionLabelFromCwd(cwd: string | undefined, fallback: string): string;
export class NotificationStore {
  constructor(options?: { now?: () => number; policy?: (kind: string) => NotificationPolicyMode; fadeMs?: number });
  record(input: { sessionKey: string; windowKey?: string; kind: string; message: string; label: string }): void;
  resolveSession(sessionKey: string): boolean;
  resolveWindow(windowKey: string): boolean;
  dismissSession(sessionKey: string): boolean;
  removeSession(sessionKey: string): NotificationEntry | null;
  adoptEntries(entries: readonly NotificationEntry[]): void;
  unresolvedCount(): number;
  oldestUnresolved(): NotificationEntry | null;
  rows(): readonly NotificationEntry[];
  clear(): void;
}
```

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/tests/notification-store.test.ts`:

```ts
import assert from "node:assert/strict";
import { NotificationStore, sessionLabelFromCwd } from "../src/notification-store.js";

assert.equal(sessionLabelFromCwd("C:\\Users\\me\\fraud_project", "Terminal"), "fraud_project");
assert.equal(sessionLabelFromCwd("/home/me/api-fix/", "Terminal"), "api-fix");
assert.equal(sessionLabelFromCwd(undefined, "Ghostty"), "Ghostty");

let now = 1_000;
const store = new NotificationStore({ now: () => now });

// One live row per session; re-record replaces content.
store.record({ sessionKey: "s1", windowKey: "w:1", kind: "waiting", message: "needs permission", label: "fraud_project" });
now = 2_000;
store.record({ sessionKey: "s2", windowKey: "w:2", kind: "success", message: "turn done", label: "api-fix" });
assert.equal(store.rows().length, 2);
assert.equal(store.unresolvedCount(), 2);
assert.equal(store.oldestUnresolved()?.sessionKey, "s1", "oldest unresolved is s1");

// Resolution by window focus.
assert.equal(store.resolveWindow("w:1"), true);
assert.equal(store.unresolvedCount(), 1);
assert.equal(store.oldestUnresolved()?.sessionKey, "s2");

// Fresh activity re-marks unresolved and resets firstUnresolvedAt.
now = 3_000;
store.record({ sessionKey: "s1", windowKey: "w:1", kind: "working", message: "refactoring", label: "fraud_project" });
assert.equal(store.unresolvedCount(), 2);
assert.equal(store.oldestUnresolved()?.sessionKey, "s2", "s1 unresolved-age reset — s2 now oldest");

// rows(): unresolved oldest-first, then resolved by recency.
store.resolveSession("s2");
assert.deepEqual(store.rows().map((r) => r.state), ["unresolved", "resolved"]);

// Dismiss removes from badge but a new event revives the row.
assert.equal(store.dismissSession("s1"), true);
assert.equal(store.unresolvedCount(), 0);
store.record({ sessionKey: "s1", windowKey: "w:1", kind: "error", message: "tests failed", label: "fraud_project" });
assert.equal(store.unresolvedCount(), 1);

// Policy: "off" writes nothing; "fade" auto-resolves after fadeMs.
let fadeNow = 0;
const fading = new NotificationStore({ now: () => fadeNow, policy: (kind) => (kind === "working" ? "fade" : kind === "idle" ? "off" : "persistent"), fadeMs: 10_000 });
fading.record({ sessionKey: "a", kind: "idle", message: "x", label: "l" });
assert.equal(fading.rows().length, 0, "off kind writes no row");
fading.record({ sessionKey: "a", kind: "working", message: "x", label: "l" });
assert.equal(fading.unresolvedCount(), 1);
fadeNow = 10_001;
assert.equal(fading.unresolvedCount(), 0, "fade kind auto-resolved after fadeMs");
assert.equal(fading.rows()[0]?.state, "resolved");

// removeSession + adoptEntries (close-pet fallback migration).
const moved = store.removeSession("s1");
assert.equal(moved?.sessionKey, "s1");
const target = new NotificationStore({ now: () => now });
target.adoptEntries(moved ? [moved] : []);
assert.equal(target.unresolvedCount(), 1);

console.log("Notification store passed.");
```

- [ ] **Step 2: Register in `run-tests.mjs` (`behaviorTests` += `".test-dist/tests/notification-store.test.js"`) and verify it fails**

Run: `pnpm test` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `apps/desktop/src/notification-store.ts`**

```ts
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

  record(input: { sessionKey: string; windowKey?: string; kind: string; message: string; label: string }): void {
    if (this.#policy(input.kind) === "off") return;
    const now = this.#now();
    const existing = this.#entries.get(input.sessionKey);
    const wasUnresolved = existing?.state === "unresolved";
    this.#entries.set(input.sessionKey, {
      sessionKey: input.sessionKey,
      windowKey: input.windowKey ?? existing?.windowKey,
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
```

- [ ] **Step 4: Run `pnpm test` — Expected: PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/notification-store.ts apps/desktop/tests/notification-store.test.ts apps/desktop/scripts/run-tests.mjs
git commit -m "feat(desktop): add pure notification store for pet attention rows"
```

---

### Task 3: `window-pet-registry.ts` — window-keyed pet lifecycle

The registry owns window→pet bindings and per-binding notification stores, and decides spawn/close/rebind. Side effects (Electron windows) are injected callbacks so the module stays unit-testable.

**Files:**
- Create: `apps/desktop/src/window-pet-registry.ts`
- Test: `apps/desktop/tests/window-pet-registry.test.ts`

**Interfaces:**
- Consumes: `NotificationStore`, `NotificationEntry` from Task 2.
- Produces (used by Tasks 4-8):

```ts
export type WindowKey = string;
export function windowKeyForIdentity(terminalWindowId: number | undefined, terminalOwnerPid: number): WindowKey;
export interface RegistrySessionInfo {
  readonly sessionKey: string;      // `${clientPid}:${sessionNonce}`
  readonly leaseId: string;
  readonly terminalOwnerPid: number;
  readonly terminalWindowId?: number;
  readonly label: string;
}
export interface RegistryCallbacks {
  spawnPet(windowKey: WindowKey, petId: string): void;
  closePet(windowKey: WindowKey, petId: string, reason: "window-dead" | "session-ended" | "user-closed" | "rebind" | "pool-disabled"): void;
  rebindPet(windowKey: WindowKey, fromPetId: string, toPetId: string): void;
  sessionEndedNotice(label: string, petId: string): void; // default pet's "session ended in X"
}
export class WindowPetRegistry {
  constructor(options: {
    callbacks: RegistryCallbacks;
    now?: () => number;
    isPidAlive?: (pid: number) => boolean;
    drawPoolPet?: (occupiedPetIds: ReadonlySet<string>) => string | null;
    storeFactory?: () => NotificationStore;
  });
  readonly defaultStore: NotificationStore;
  onSessionIdentified(session: RegistrySessionInfo, requestedPetId: string | undefined, poolEnabled: boolean): string | null;
  onSessionAdopted(session: RegistrySessionInfo, petId: string): void;
  onSessionGone(sessionKey: string): void;
  onUserClosedPet(windowKey: WindowKey): void;
  onPoolDisabled(): void;
  onPoolEnabled(): void;
  petForWindow(windowKey: WindowKey): string | null;
  windowForPet(petId: string): WindowKey | null;
  storeForPet(petId: string): NotificationStore | null;  // bound pets only
  storeForSession(sessionKey: string): NotificationStore; // binding store or defaultStore
  touchSessionActivity(sessionKey: string): void;
  resolveWindowFocus(windowKey: WindowKey): readonly string[]; // petIds whose stores changed
  focusTargetForPet(petId: string): { terminalOwnerPid: number; terminalWindowId?: number } | null;
  focusTargetForDefault(): { terminalOwnerPid: number; terminalWindowId?: number } | null;
  boundPetIds(): readonly string[];
}
```

Behavior rules (from the spec, plus two refinements settled in planning):

1. A pet is bound to at most one window. Adopting a pet already bound elsewhere MOVES it: the old binding closes (`reason: "rebind"`), its sessions fall to default coverage.
2. `onSessionIdentified` for a session whose window is user-closed: explicit `requestedPetId` clears the user-closed mark and binds; pool draw does NOT (user said no to this window).
3. `onSessionGone` — last session out of a binding: `isPidAlive(terminalOwnerPid)` false → `closePet(..., "window-dead")`; alive → `sessionEndedNotice(label, petId)` then `closePet(..., "session-ended")`. Its store entries for remaining... (none remain — last session) are dropped; the session's own row moves to `defaultStore` only via `sessionEndedNotice`.
4. Sessions never identified (no terminal identity) stay on default coverage: `storeForSession` returns `defaultStore`.
5. Pool: `onSessionIdentified(session, undefined, true)` on an unbound, non-user-closed window draws `drawPoolPet(occupiedPetIds)`; occupied = all currently bound petIds. `onPoolDisabled()` closes pool-origin bindings (`reason: "pool-disabled"`), remembers their windowKeys; `onPoolEnabled()` re-draws for remembered windows that still have live sessions.
6. Focus targets: `focusTargetForPet` — oldest unresolved entry's session in that binding, else the binding session with the freshest activity. `focusTargetForDefault` — same over `defaultStore` + default-covered sessions.

- [ ] **Step 1: Write the failing test** — `apps/desktop/tests/window-pet-registry.test.ts`:

```ts
import assert from "node:assert/strict";
import { WindowPetRegistry, windowKeyForIdentity } from "../src/window-pet-registry.js";

assert.equal(windowKeyForIdentity(77, 500), "w:77");
assert.equal(windowKeyForIdentity(undefined, 500), "p:500");

interface Call { fn: string; args: unknown[] }
const calls: Call[] = [];
const cb = {
  spawnPet: (...args: unknown[]) => calls.push({ fn: "spawn", args }),
  closePet: (...args: unknown[]) => calls.push({ fn: "close", args }),
  rebindPet: (...args: unknown[]) => calls.push({ fn: "rebind", args }),
  sessionEndedNotice: (...args: unknown[]) => calls.push({ fn: "notice", args }),
};
let alive = true;
let now = 1_000;
const registry = new WindowPetRegistry({
  callbacks: cb,
  now: () => now,
  isPidAlive: () => alive,
  drawPoolPet: (occupied) => (occupied.has("cat") ? (occupied.has("dog") ? null : "dog") : "cat"),
});

const s1 = { sessionKey: "100:n1", leaseId: "L1", terminalOwnerPid: 500, terminalWindowId: 77, label: "fraud_project" };
const s2 = { sessionKey: "200:n2", leaseId: "L2", terminalOwnerPid: 500, terminalWindowId: 77, label: "fraud_project" };
const s3 = { sessionKey: "300:n3", leaseId: "L3", terminalOwnerPid: 900, terminalWindowId: 88, label: "api-fix" };

// Explicit bind; second session in same window joins without a second spawn.
assert.equal(registry.onSessionIdentified(s1, "cat", false), "cat");
assert.equal(registry.onSessionIdentified(s2, undefined, false), "cat", "joins existing binding");
assert.deepEqual(calls.map((c) => c.fn), ["spawn"]);
assert.equal(registry.petForWindow("w:77"), "cat");
assert.equal(registry.windowForPet("cat"), "w:77");

// Session without explicit pet in a new window, pool off → default coverage.
assert.equal(registry.onSessionIdentified(s3, undefined, false), null);
assert.equal(registry.storeForSession("300:n3"), registry.defaultStore);

// Pool on → new window draws pool pet; occupied excludes drawing "cat".
const s4 = { sessionKey: "400:n4", leaseId: "L4", terminalOwnerPid: 901, terminalWindowId: 89, label: "docs" };
assert.equal(registry.onSessionIdentified(s4, undefined, true), "dog");

// Adopt a pet bound elsewhere → old binding closes with "rebind", pet moves.
calls.length = 0;
registry.onSessionAdopted(s3, "cat");
assert.deepEqual(calls.map((c) => c.fn), ["close", "spawn"]);
assert.equal((calls[0]!.args as string[])[2], "rebind");
assert.equal(registry.petForWindow("w:88"), "cat");
assert.equal(registry.petForWindow("w:77"), null, "old window unbound");
assert.equal(registry.storeForSession("100:n1"), registry.defaultStore, "orphaned sessions fall to default");

// Notifications route to binding store; window focus resolves them.
registry.storeForSession("300:n3").record({ sessionKey: "300:n3", windowKey: "w:88", kind: "waiting", message: "needs permission", label: "api-fix" });
assert.equal(registry.storeForPet("cat")?.unresolvedCount(), 1);
assert.deepEqual(registry.resolveWindowFocus("w:88"), ["cat"]);
assert.equal(registry.storeForPet("cat")?.unresolvedCount(), 0);

// Focus target: oldest unresolved wins, else freshest activity.
registry.storeForPet("cat")?.record({ sessionKey: "300:n3", windowKey: "w:88", kind: "error", message: "boom", label: "api-fix" });
assert.deepEqual(registry.focusTargetForPet("cat"), { terminalOwnerPid: 900, terminalWindowId: 88 });

// User close: binding gone, heartbeat-driven re-identify does NOT respawn without explicit request.
calls.length = 0;
registry.onUserClosedPet("w:88");
assert.deepEqual(calls.map((c) => c.fn), ["close"]);
assert.equal((calls[0]!.args as string[])[2], "user-closed");
assert.equal(registry.onSessionIdentified(s3, undefined, true), null, "pool skips user-closed window");
assert.equal(registry.onSessionIdentified(s3, "cat", false), "cat", "explicit adopt re-binds");

// Teardown: last session out, window alive → notice + close(session-ended).
calls.length = 0;
registry.onSessionGone("300:n3");
assert.deepEqual(calls.map((c) => c.fn), ["notice", "close"]);
assert.equal((calls[1]!.args as string[])[2], "session-ended");

// Window dead → instant close, no notice.
calls.length = 0;
alive = false;
registry.onSessionGone("400:n4");
assert.deepEqual(calls.map((c) => c.fn), ["close"]);
assert.equal((calls[0]!.args as string[])[2], "window-dead");

console.log("Window pet registry passed.");
```

- [ ] **Step 2: Register in `run-tests.mjs` and verify FAIL** (`pnpm test` — module not found).

- [ ] **Step 3: Implement `apps/desktop/src/window-pet-registry.ts`**

Implementation notes (keep it a single focused module, ~250 lines):

- Internal state: `#bindings = Map<WindowKey, { petId: string; origin: "explicit" | "pool"; sessions: Map<string, RegistrySessionInfo & { lastActivityAt: number }>; store: NotificationStore }>`; `#sessionWindows = Map<string /*sessionKey*/, WindowKey>`; `#userClosedWindows = Set<WindowKey>`; `#suspendedPoolWindows = Set<WindowKey>`; `#defaultSessions = Map<string, RegistrySessionInfo & { lastActivityAt: number }>`; `public defaultStore = storeFactory()`.
- `onSessionIdentified`: compute `windowKey = windowKeyForIdentity(...)`. If session already tracked under that key, refresh info and return current pet. If `requestedPetId`: clear user-closed mark; if window bound to a different pet → move semantics (close other binding of that pet if bound elsewhere via `windowForPet`, then rebind this window: `rebindPet` when binding exists, else `spawnPet`); park displaced sessions in `#defaultSessions`. If no `requestedPetId`: join existing binding if present; else if `poolEnabled` and not user-closed → `drawPoolPet(boundPetIds set)`; null → default coverage (track in `#defaultSessions`).
- `onSessionAdopted(session, petId)` = `onSessionIdentified(session, petId, false)` after removing the session from wherever it currently sits.
- `onSessionGone`: remove from `#defaultSessions` (drop its defaultStore row via `removeSession`) or from its binding; if binding now empty → `isPidAlive(terminalOwnerPid)`? notice+close("session-ended") : close("window-dead"); delete binding either way.
- `resolveWindowFocus(windowKey)`: resolve unresolved entries on the binding store for that key AND on `defaultStore` (`defaultStore.resolveWindow(windowKey)`); return the bound petIds whose stores changed as `readonly string[]`. The default store needs no sentinel in the return value — Task 6's subscriber re-renders the default pet unconditionally after every focus change.
- `focusTargetForPet` / `focusTargetForDefault`: oldest unresolved entry → find that session's info (in binding sessions / `#defaultSessions`) → `{ terminalOwnerPid, terminalWindowId }`; else scan sessions for max `lastActivityAt`; null when no sessions.
- `onPoolDisabled`: for bindings with `origin === "pool"` → close("pool-disabled"), remember windowKey in `#suspendedPoolWindows`, park sessions in `#defaultSessions`. `onPoolEnabled`: for each suspended key, if any parked session's windowKey matches → re-draw via the normal identified path.
- No electron imports; DI everything (`now`, `isPidAlive` default `(pid) => { try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code !== "ESRCH"; } }`).

- [ ] **Step 4: `pnpm test` — Expected: PASS.** Iterate until the test above passes as written.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/window-pet-registry.ts apps/desktop/tests/window-pet-registry.test.ts apps/desktop/scripts/run-tests.mjs
git commit -m "feat(desktop): add window-keyed pet registry with per-binding notification stores"
```

---

### Task 4: Wire the registry into `local-ipc.ts` (lease, pool, say/react)

Replace lease-count-driven pet lifecycle with registry events. **Behavior change accepted in design:** pool sessions now acquire as `targetKind: "default"` (the binding decides the visible pet); `LeaseSnapshot.usingDefaultPet` is true for pool sessions.

**Files:**
- Modify: `apps/desktop/src/local-ipc.ts` (constructor options :31-39, acquire :386-408, pool :121-151 & :735-779, identity :534-646, cleanup :523, say/react :433-487)
- Modify: `apps/desktop/src/agent-pet-controller.ts` (registry-facing helpers)
- Test: `apps/desktop/tests/lease-manager.test.ts` still passes unchanged (lease semantics untouched)

**Interfaces:**
- Consumes: `WindowPetRegistry`, `windowKeyForIdentity`, `NotificationStore`, `sessionLabelFromCwd` (Tasks 2-3).
- Produces: module-level `export function getWindowPetRegistry(): WindowPetRegistry` in `local-ipc.ts` for Tasks 5-8; `sessionKeyForLease(lease: PetLease): string | null` helper (`${clientPid}:${sessionNonce}`, null when either missing).

- [ ] **Step 1: Construct the registry** (top of `local-ipc.ts`, after the LeaseManager):

```ts
const windowPetRegistry = new WindowPetRegistry({
  callbacks: {
    spawnPet: (windowKey, petId) => { clearAgentPetDismissal(petId); showAgentPet(petId); },
    closePet: (windowKey, petId, reason) => {
      if (reason === "session-ended") scheduleFarewellClose(petId); // Task 7; until then: clearAgentPetLeaseState(petId)
      else clearAgentPetLeaseState(petId);
      clearConfinementState(petId);
    },
    rebindPet: (windowKey, fromPetId, toPetId) => {
      clearAgentPetLeaseState(fromPetId);
      clearConfinementState(fromPetId);
      clearAgentPetDismissal(toPetId);
      showAgentPet(toPetId);
    },
    sessionEndedNotice: (label, petId) => {
      windowPetRegistry.defaultStore.record({ sessionKey: `ended:${petId}:${Date.now()}`, kind: "message", message: t("pet.notify.sessionEnded", { label }), label });
      // Task 5 adds refreshDefaultPetNotifications() here; omit the call in this task.
    },
  },
  drawPoolPet: (occupied) => {
    const state = getAppStateSnapshot();
    const eligible = getEligiblePoolPetIds(state.pets.installed, getBuiltInPet().id, getCurrentDefaultPet().id).filter((id) => !occupied.has(id));
    const pool = state.preferences.petPoolOrder ?? [];
    for (const petId of pool) if (eligible.includes(petId)) return petId;
    return null;
  },
});
export function getWindowPetRegistry(): WindowPetRegistry { return windowPetRegistry; }
```

(Adapt names to the file's actual imports — `getBuiltInPet`/`getCurrentDefaultPet` are the existing helpers used at :763-779. The `sessionEndedNotice` message goes through `validateSayMessage`-safe copy: label is a basename, safe.)

- [ ] **Step 2: Re-route lease lifecycle**
- LeaseManager constructor: DELETE `onFirstExplicitLease: showAgentPet` and `onLastExplicitLease: handleLastExplicitLease` (lines 35-36) and the `handleLastExplicitLease` function (:517-521); explicit-lease confinement unsubscribe stays in `releaseExplicitLease`/`cleanupReleasedLeases`.
- lease.acquire (:397-398): DELETE `clearAgentPetDismissal`/`showAgentPet` — spawning now happens on identity, not acquire.
- `resolveLeaseTarget` (:735-...): DELETE the pool branch (`tryResolveFromPool` call at :743-745) — `requestedPetId === undefined` always resolves default now. Keep `tryResolveFromPool` deleted entirely; pool draw lives in the registry callback above. Preserve the sync invariant comment removal accordingly.
- In `resolveTerminalIdentity` (:534-615) after `setIdentity` runs (both explicit and the `resolveDefaultLeaseTerminalIdentity` path :624-646): call

```ts
const raw = leaseManager.getRawLease(leaseId);
if (raw?.clientPid && raw.sessionNonce && raw.terminalOwnerPid) {
  const bound = windowPetRegistry.onSessionIdentified(
    {
      sessionKey: `${raw.clientPid}:${raw.sessionNonce}`,
      leaseId,
      terminalOwnerPid: raw.terminalOwnerPid,
      terminalWindowId: raw.terminalWindowId,
      label: sessionLabelFromCwd(raw.cwd, raw.terminalAppName ?? "session"),
    },
    raw.targetKind === "explicit" ? raw.actualPetId : undefined,
    getAppStateSnapshot().preferences.petPoolEnabled === true,
  );
  if (bound) applyConfinementUpdateForPet(bound, raw); // existing confinement flow, now keyed by bound pet
}
```

- `cleanupReleasedLeases` (:523) and `releaseExplicitLease` (:529): add `const raw`-based `windowPetRegistry.onSessionGone(sessionKey)` for every released lease that has clientPid+sessionNonce (get the raw lease BEFORE `leaseManager.release`).
- The 3-second unbound-spawn grace from the spec: on explicit acquire, `setTimeout(3_000)`; if `windowForPet(actualPetId) === null` and the lease is still live → `spawnPet`-equivalent (`clearAgentPetDismissal` + `showAgentPet`) so the pet is visible even before identity lands; the later `onSessionIdentified` merge is a no-op spawn (registry returns current pet; `showAgentPet` reuses the window).
- `dispatchPoolToggle` (:121-151): body becomes `enabled ? windowPetRegistry.onPoolEnabled() : windowPetRegistry.onPoolDisabled()`; delete `suspendedPoolSessions`.

- [ ] **Step 3: Feed notifications from say/react**

In BOTH handlers (react :433-459, say :461-487), after the target branch is decided, record into the right store. Shared helper in `local-ipc.ts`:

```ts
function recordSessionNotification(lease: PetLease | null, kind: string, message: string): void {
  const sessionKey = lease?.clientPid && lease.sessionNonce ? `${lease.clientPid}:${lease.sessionNonce}` : undefined;
  if (!sessionKey) return; // anonymous callers animate the pet but write no row
  const windowKey = lease?.terminalOwnerPid ? windowKeyForIdentity(lease.terminalWindowId, lease.terminalOwnerPid) : undefined;
  const label = sessionLabelFromCwd(lease?.cwd, lease?.terminalAppName ?? "session");
  windowPetRegistry.storeForSession(sessionKey).record({ sessionKey, windowKey, kind, message, label });
  windowPetRegistry.touchSessionActivity(sessionKey);
}
```

Call sites: react → `recordSessionNotification(rawLease, reaction, t("pet.notify.reaction." + reaction) /* short localized blip, see Task 5 keys */)`; say → `recordSessionNotification(rawLease, reaction ?? "message", message)`. For the session-routed branch (`resolveSessionPetTarget` match) pass the MATCHED session's raw lease. Display routing: replace `applyAgentPetReaction(lease.actualTargetPetId, ...)` with the binding pet — `const displayPet = windowPetRegistry.petForWindow(windowKey) ?? null; displayPet ? applyAgentPetReaction(displayPet, reaction) : applyExternalPetReaction(reaction)` — same pattern for say.

- [ ] **Step 4: Typecheck + full suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS. `lease-manager.test.ts` passes UNCHANGED (constructor callbacks are optional). Any test asserting pool-assignment inside `resolveLeaseTarget` (check `app-state-pet-pool-default.test.ts` and `lease-manager-fixes.test.ts`) must be updated to the new contract: acquire without requestedPetId is always default-target; pool behavior is covered by `window-pet-registry.test.ts`.

- [ ] **Step 5: Manual smoke (build + run):** `pnpm build && pnpm start` — start one Claude session with `--pet`, verify pet appears after identity resolves, say/react still animate, closing the terminal closes the pet.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/local-ipc.ts apps/desktop/src/agent-pet-controller.ts apps/desktop/tests
git commit -m "feat(desktop): drive pet lifecycle from window registry instead of lease counts"
```

---

### Task 5: Badge + flyout rendering in pet windows

**Simplification vs spec:** the flyout renders INSIDE the existing fixed 340×420 window (bubble headroom, internal scroll, max 12 rows) — no bounds enlargement, so Linux `setShape` rects, drag clamps, and position persistence are untouched. The bubble and flyout are mutually exclusive (flyout open suppresses the transient bubble).

**Files:**
- Modify: `apps/desktop/src/pet-window.ts` (options interfaces :22-64, content loaders :711/:726, body markup :1033, CSS blocks, `allowedPetEventNames` :546)
- Modify: pet preload (`pet-preload.cjs`): hit-test selectors (3× `.closest(...)` at ~L26/L83/L106), click/dblclick/contextmenu handlers
- Modify: `apps/desktop/src/agent-pet-controller.ts`, `apps/desktop/src/default-pet-controller.ts` (thread the view, handle events)
- Modify: `apps/desktop/src/i18n/locales/en.json` (or the EN catalog file — locate `pet.menu.hidePet` and add siblings)
- Test: `apps/desktop/tests/notification-view.test.ts` (new, pure markup builder)

**Interfaces:**
- Consumes: `NotificationEntry`, registry accessors (`getWindowPetRegistry`).
- Produces:

```ts
export interface PetNotificationsView {
  readonly open: boolean;
  readonly unresolvedCount: number;
  readonly rows: readonly { sessionKey: string; label: string; message: string; ageText: string; state: "unresolved" | "resolved" }[];
}
export function buildNotificationsView(entries: readonly NotificationEntry[], open: boolean, now: number, t: (key: string, vars?: Record<string, string | number>) => string): PetNotificationsView;
export function createNotificationsMarkup(view: PetNotificationsView, t: (...) => string): string; // pure, exported for tests
```

New pet events (add to `allowedPetEventNames` and preload): `"pet:notificationsToggle"` (badge click), `"pet:notificationFocus"` payload `{ sessionKey }` (row double-click), `"pet:notificationDismiss"` payload `{ sessionKey }` (row right-click via renderer `contextmenu` listener — the main-process context menu handler must skip popup when the target is a flyout row: preload sets a `data-notify-row` attribute and the renderer listener calls `event.preventDefault()` + `stopPropagation()` before sending).

New EN message keys: `pet.notify.badgeLabel` ("{count} sessions need attention"), `pet.notify.empty` ("All quiet"), `pet.notify.sessionEnded` ("Session ended in {label}"), `pet.notify.ageNow` ("now"), `pet.notify.ageMinutes` ("{m}m"), `pet.notify.ageHours` ("{h}h"), `pet.notify.reaction.<each of the 11 reactions>` (short blips: "thinking…", "working…", "editing…", "running…", "testing…", "waiting on you", "waving", "done", "error", "celebrating", "idle"), `pet.menu.notifications` ("Notifications").

- [ ] **Step 1: Failing test for the pure builders** (`tests/notification-view.test.ts`): feed 3 entries (2 unresolved, 1 resolved), assert view ordering matches `rows()` order, `unresolvedCount`, ageText buckets (30s → "now", 5m → "5m", 3h → "3h"), and that `createNotificationsMarkup` HTML-escapes `<script>` in messages/labels and caps at 12 rows. Register in `run-tests.mjs`; `pnpm test` → FAIL.

- [ ] **Step 2: Implement builders** in a new small module `apps/desktop/src/notification-view.ts` (keeps pet-window.ts from growing; pet-window imports it). Markup shape:

```html
<div class="notify-badge" data-count="3">3</div>          <!-- absolute, top-right of .pet-shell; hidden when count=0 and flyout closed -->
<div class="notify-flyout">                                <!-- absolute, occupies bubble region; only when open -->
  <div class="notify-row is-unresolved" data-notify-row data-session-key="...">
    <span class="notify-dot"></span>
    <span class="notify-label">fraud_project</span>
    <span class="notify-message">needs permission</span>
    <span class="notify-age">2m</span>
  </div>
  ...
</div>
```

Escape with the same escaping used by `createBubbleMarkup` for bubble text (reuse pet-window's existing escape helper; if none is exported, add `escapeHtml` to notification-view.ts and use it for label/message/sessionKey attributes).

- [ ] **Step 3: Thread through pet-window.ts**
- Add `notifications?: PetNotificationsView | null` to `DefaultPetWindowOptions` and `AgentPetWindowOptions`, and as a new optional trailing param on `loadDefaultPetContent` / `loadExplicitPetContent`.
- In `createPetBodyMarkup` (:1033): when `view?.open` render flyout INSTEAD of the transient bubble; always render the badge when `unresolvedCount > 0 || view?.open`.
- CSS (append to the style blocks near bubble styles ~:1050-1160): badge = 20px circle, brand blue `#176df2`, white bold count, absolute `top: -4px; right: -4px` relative to `.pet-shell`, `cursor: pointer`; flyout = `position:absolute; left:50%; transform:translateX(-50%); bottom: <same bubbleBottom formula>; width: 300px; max-height: 240px; overflow-y: auto;` white/95% rounded panel, rows 13px, `.is-unresolved .notify-dot` blue pulse, resolved rows 60% opacity.
- `allowedPetEventNames` (:546): add the three new names.
- Include `open`/`unresolvedCount`/row content in the render `cacheKey` inputs the same way `pluginBubblesCacheKey` feeds it (add `notificationsCacheKey(view)` = `${open}:${unresolvedCount}:${rows.map(r => r.sessionKey + r.state + r.updatedAgeBucket).join(",")}`) so content-only changes take the fast in-place body swap.

- [ ] **Step 4: Preload wiring** (pet-preload.cjs)
- Add `.notify-badge, .notify-flyout` to all three `.closest(".pet-hitbox, .pet-shell, .bubble")` selector strings (L26, L83, L106) so the areas are interactive.
- `click` on `.notify-badge` → `sendPetEvent("pet:notificationsToggle", {})`.
- `dblclick` on `[data-notify-row]` → `sendPetEvent("pet:notificationFocus", { sessionKey: row.dataset.sessionKey })`.
- `contextmenu` on `[data-notify-row]` → `preventDefault(); stopPropagation();` + `sendPetEvent("pet:notificationDismiss", { sessionKey })`.

- [ ] **Step 5: Controller wiring**
- `agent-pet-controller.ts`: module `const notificationsOpen = new Set<string /*petId*/>()`; new export `refreshAgentPetNotifications(petId: string)` that builds the view from `getWindowPetRegistry().storeForPet(petId)` and re-runs `loadExplicitPetContent` with current display/badge/view; extend the `onPetEvent` handler in `getOrCreateAgentPetWindow`:

```ts
onPetEvent: (name, payload) => {
  if (name === "pet:doubleClicked") focusSessionTerminal();
  if (name === "pet:notificationsToggle") { toggle petId in notificationsOpen; refreshAgentPetNotifications(petId); }
  if (name === "pet:notificationFocus") { /* Task 6 fills with real focus; for now resolve + refresh */ }
  if (name === "pet:notificationDismiss") { getWindowPetRegistry().storeForPet(petId)?.dismissSession(String((payload as any).sessionKey)); refreshAgentPetNotifications(petId); }
},
```

- `default-pet-controller.ts`: same pattern against `getWindowPetRegistry().defaultStore`; export `refreshDefaultPetNotifications()` and call it from the `sessionEndedNotice` callback (Task 4 left that call pending) and from `recordSessionNotification` when the store used was `defaultStore` (simplest: `recordSessionNotification` ends with `displayPet ? refreshAgentPetNotifications(displayPet) : refreshDefaultPetNotifications()`).

- [ ] **Step 6: Verify** — `pnpm typecheck && pnpm test && pnpm build && pnpm start`: two sessions under the default pet → badge shows 2; click badge → flyout lists both with labels from cwd; right-click a row dismisses it.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/notification-view.ts apps/desktop/src/pet-window.ts apps/desktop/src/pet-preload.cjs apps/desktop/src/agent-pet-controller.ts apps/desktop/src/default-pet-controller.ts apps/desktop/src/i18n apps/desktop/tests/notification-view.test.ts apps/desktop/scripts/run-tests.mjs
git commit -m "feat(desktop): render notification badge and flyout on pet windows"
```

---

### Task 6: Precise focus + auto-resolve on window focus + routing order

**Files:**
- Modify: `apps/desktop/src/terminal-focus.ts:41-106`
- Modify: `apps/desktop/src/window-tracker.ts` (piggyback the 500ms poller)
- Modify: `apps/desktop/src/local-ipc.ts` (focus resolver), `agent-pet-controller.ts` / `default-pet-controller.ts` (double-click + row focus)
- Test: `apps/desktop/tests/window-tracker-active.test.ts` (new — pure debounce/dispatch logic if extracted; otherwise cover via focus-target tests already in Task 3)

**Interfaces:**
- Consumes: `focusTargetForPet`/`focusTargetForDefault`/`resolveWindowFocus` (Task 3).
- Produces: `focusTerminalWindow(terminalPid: number, terminalWindowId?: number): Promise<boolean>`; `subscribeActiveWindowTracking(cb: (win: { id: number; ownerPid: number } | null) => void): () => void`.

- [ ] **Step 1: HWND-precise focus (win32).** In `focusTerminalWindowWin32`, accept optional `terminalWindowId` (= HWND from get-windows). When present, target it directly instead of `MainWindowHandle`:

```powershell
$hwnd = [IntPtr]${terminalWindowId};
if ([WinFocus]::IsIconic($hwnd)) { [WinFocus]::ShowWindow($hwnd, 9) | Out-Null };
[WinFocus]::SetForegroundWindow($hwnd) | Out-Null
```

Fall back to the existing PID/MainWindowHandle path when `terminalWindowId` is undefined or the HWND call returns false. macOS: ignore the param (existing AXRaise). Update the two existing call sites (`agent-pet-controller.ts:180-187`, `default-pet-controller.ts:32-41`) to pass the window id from the registry focus target.

- [ ] **Step 2: Active-window subscription.** In `window-tracker.ts`, inside the existing latched 500ms tick, every 4th tick call get-windows' `activeWindow()`; keep `lastActiveWindowId`; on change, notify subscribers with `{ id, ownerPid }`. Export `subscribeActiveWindowTracking(cb)` mirroring `subscribeWindowTracking`'s unsubscribe shape. (The poller already runs only while subscriptions exist — make active-window subscribers count toward that gate.)

- [ ] **Step 3: Wire auto-resolve.** In `local-ipc.ts` (near the cleanup interval): subscribe once:

```ts
subscribeActiveWindowTracking((win) => {
  if (!win) return;
  for (const key of [windowKeyForIdentity(win.id, win.ownerPid), windowKeyForIdentity(undefined, win.ownerPid)]) {
    for (const petId of windowPetRegistry.resolveWindowFocus(key)) refreshAgentPetNotifications(petId);
  }
  refreshDefaultPetNotifications();
});
```

- [ ] **Step 4: Routing order.** Replace both double-click paths:
- Agent pet (`agent-pet-controller.ts` `focusSessionTerminal`): `const target = getWindowPetRegistry().focusTargetForPet(petId) ?? confinementFallback(petId);` then `focusTerminalWindow(target.terminalOwnerPid, target.terminalWindowId)`, where `confinementFallback` is the existing `getConfinementState(petId)?.terminalOwnerPid` read.
- Default pet: `setSessionTerminalFocusResolver` (local-ipc.ts:43) becomes `() => windowPetRegistry.focusTargetForDefault() ?? legacyLeaseFallback()` where `legacyLeaseFallback` maps `getFocusableDefaultLease()` to `{ terminalOwnerPid, terminalWindowId }`. Update the resolver's type from `number | undefined` to the target object in `default-pet-controller.ts:24` and its consumer `focusSessionTerminalFromDefaultPet` (:32-41).
- Row focus (`pet:notificationFocus` from Task 5): look up the session in the registry (`storeForSession` scope), resolve + focus that session's `{ terminalOwnerPid, terminalWindowId }`, `resolveSession(sessionKey)`, refresh the view. On focus failure (`focusTerminalWindow` → false), leave unresolved and set a transient `is-error` class via re-render (view rows gain optional `error: boolean` — flash only, no persistence).

- [ ] **Step 5: Verify** — `pnpm typecheck && pnpm test`; manual: two Windows Terminal windows, pet A bound to one; double-click row → correct window rises even when both share one `WindowsTerminal.exe` process; alt-tabbing to a window clears its rows' unresolved state within ~2s.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/terminal-focus.ts apps/desktop/src/window-tracker.ts apps/desktop/src/local-ipc.ts apps/desktop/src/agent-pet-controller.ts apps/desktop/src/default-pet-controller.ts
git commit -m "feat(desktop): HWND-precise focus, focus-driven auto-resolve, oldest-unresolved routing"
```

---

### Task 7: Farewell teardown

**Files:**
- Modify: `apps/desktop/src/agent-pet-controller.ts`
- Modify: `apps/desktop/src/local-ipc.ts` (the `closePet` callback from Task 4 already branches on reason)

**Interfaces:**
- Consumes: `applyAgentPetSay`, `clearAgentPetLeaseState` (existing).
- Produces: `scheduleFarewellClose(petId: string): void`.

- [ ] **Step 1: Implement** in `agent-pet-controller.ts`:

```ts
const farewellTimers = new Map<string, NodeJS.Timeout>();

/** Session ended but its window is still alive: say goodbye, then close after 5s. */
export function scheduleFarewellClose(petId: string): void {
  if (farewellTimers.has(petId)) return;
  applyAgentPetSay(petId, t("pet.notify.farewell"), "waving");
  const timer = setTimeout(() => {
    farewellTimers.delete(petId);
    clearAgentPetLeaseState(petId);
  }, 5_000);
  farewellTimers.set(petId, timer);
}

/** A new binding for this pet cancels a pending farewell (re-adopt during grace). */
export function cancelFarewellClose(petId: string): void {
  const timer = farewellTimers.get(petId);
  if (timer) { clearTimeout(timer); farewellTimers.delete(petId); }
}
```

Add EN key `pet.notify.farewell` ("All done here — bye!"). Call `cancelFarewellClose(petId)` at the top of `showAgentPet`. Swap the Task 4 placeholder in the `closePet` callback to use `scheduleFarewellClose` for `"session-ended"`.

- [ ] **Step 2: Verify** — `pnpm typecheck && pnpm test`; manual: exit Claude in a terminal that stays open → pet waves, "Session ended in X" appears on the default pet, pet despawns after ~5s; closing the whole terminal window → instant despawn, no farewell.

- [ ] **Step 3: Commit** — `git add -A apps/desktop/src && git commit -m "feat(desktop): farewell close and session-ended notice on teardown"`

---

### Task 8: Menu actions — Notifications, Scurry, Hide/Close everywhere

**Files:**
- Modify: `apps/desktop/src/pet-window.ts:199-243` (`buildPetContextMenuTemplate`)
- Modify: `apps/desktop/src/pet-roaming-controller.ts` (scurry)
- Modify: `apps/desktop/src/agent-pet-controller.ts` (hide/show), `apps/desktop/src/tray.ts` (Show hidden pets)
- Modify: EN catalog (keys below)
- Test: `apps/desktop/tests/scurry-target.test.ts` (pure edge-target math)

**Interfaces:**
- Consumes: `livePets` map + `motionMoveTo` (`pet-motion-engine.ts:163`), `getWindowPetRegistry().onUserClosedPet` / `windowForPet`.
- Produces: `scurryAllPetsToEdge(): void` (roaming controller); `hideAgentPet(petId)`, `showHiddenAgentPets()`, `hasHiddenAgentPets()` (agent controller); pure `computeScurryTarget(bounds: {x;y;width;height}, workArea: {x;y;width;height}): { x: number; y: number }`.

EN keys: `pet.menu.scurry` ("Scurry to edge"), `pet.menu.hidePet` exists (default pet) — reuse for agent pets; `tray.showHiddenPets` ("Show hidden pets").

- [ ] **Step 1: Failing test** for `computeScurryTarget` (export it from `pet-roaming-controller.ts`): window at x-center left of workArea midpoint → target x = `workArea.x` (left edge, y unchanged); right of midpoint → `workArea.x + workArea.width - bounds.width`; already at edge → same position. Register + `pnpm test` → FAIL.

- [ ] **Step 2: Implement scurry** in `pet-roaming-controller.ts`:

```ts
export function computeScurryTarget(bounds: { x: number; y: number; width: number; height: number }, workArea: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  const centerX = bounds.x + bounds.width / 2;
  const midpoint = workArea.x + workArea.width / 2;
  const x = centerX < midpoint ? workArea.x : workArea.x + workArea.width - bounds.width;
  return { x, y: bounds.y };
}

/** Send every visible pet walking to the nearest side edge of its display. */
export function scurryAllPetsToEdge(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { screen } = require("electron") as typeof import("electron");
  for (const [petId, accessor] of livePets) {
    const window = accessor();
    if (!window || window.isDestroyed() || !window.isVisible()) continue;
    const bounds = window.getBounds();
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const target = computeScurryTarget(bounds, workArea);
    void motionMoveTo(petId, accessor, target, { durationMs: 900, easing: "easeOut" });
  }
}
```

(`motionMoveTo` import already exists in this file's import line; extend it. The lazy `require` matches the module's existing app-state pattern.)

- [ ] **Step 3: Hide/Close for all pets**
- `agent-pet-controller.ts`: `const hiddenAgentPets = new Set<string>()`; `hideAgentPet(petId)` → `window.hide()` + add to set (binding/store keep running — do NOT touch the registry); `showAgentPet` early-returns `false` also when hidden? NO — hidden is not dismissed: `showAgentPet` must NOT call `window.showInactive()` while hidden but must still create/update content; add the check around the `showInactive` call. `showHiddenAgentPets()` clears the set and `showInactive()`s each window. In-memory only (window keys and petIds are not stable across app restarts — deliberate deviation from the spec's "persisted" line, documented here).
- Menu template (`buildPetContextMenuTemplate`): add for ALL pets — `t("pet.menu.notifications")` → toggles flyout (same handler as badge click: emit through the existing options callbacks — add `onToggleNotifications?: () => void` to both window option interfaces, wired in both controllers), and `t("pet.menu.scurry")` → `scurryAllPetsToEdge()`. For agent pets add Hide (`pet.menu.hidePet` → `hideAgentPet(petId)`) alongside the existing Close; Close's handler changes from `dismissAgentPetForActiveLease(petId)` to `getWindowPetRegistry().onUserClosedPet(windowForPet(petId)!)` with a null-guard fallback to the old dismissal.
- `tray.ts`: add "Show hidden pets" item, visible when `hasHiddenAgentPets()`, → `showHiddenAgentPets()`.

- [ ] **Step 4: Verify** — `pnpm typecheck && pnpm test`; manual: scurry sends default + agent pets walking to their nearest side edge on both monitors; hide keeps the badge state accumulating (visible again after Show hidden pets); Close pet drops the window's sessions onto the default pet's flyout.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src apps/desktop/tests/scurry-target.test.ts apps/desktop/scripts/run-tests.mjs
git commit -m "feat(desktop): scurry-to-edge, hide/close menu actions, show-hidden tray entry"
```

---

### Task 9: Notification policy state shape

**Files:**
- Modify: `apps/desktop/src/app-state.ts` (preferences schema + normalizer)
- Modify: `apps/desktop/src/local-ipc.ts` (pass policy into stores via `storeFactory`)
- Test: `apps/desktop/tests/app-state-notification-policy.test.ts`

- [ ] **Step 1: Failing test:** normalization accepts `{ waiting: "persistent", working: "fade", idle: "off" }`, drops unknown modes/non-string keys, returns `{}` for garbage. Follow the exact pattern of `app-state-pet-pool-default.test.ts` (import the pure normalizer). Register; FAIL.

- [ ] **Step 2: Implement:** `notificationPolicy?: Record<string, "persistent" | "fade" | "off">` in the preferences V1 schema with `normalizeNotificationPolicy(value: unknown)` in `app-state-core.ts` (house pattern: pure normalizers live there); default `{}`. In `local-ipc.ts`, construct the registry with `storeFactory: () => new NotificationStore({ policy: (kind) => getAppStateSnapshot().preferences.notificationPolicy?.[kind] ?? "persistent" })`. No settings UI (out of scope per spec).

- [ ] **Step 3: `pnpm test` PASS → commit** — `git commit -m "feat(desktop): persist notification policy map (all-persistent default)"`

---

### Task 10: Full verification, codemap, manual matrix

- [ ] **Step 1:** `pnpm check` (typecheck + build + full test suite) from `apps/desktop/`, and `pnpm -w build` for the workspace (client change in Task 1). Expected: green.
- [ ] **Step 2:** Update `apps/desktop/src/codemap.md`: add `window-pet-registry.ts`, `notification-store.ts`, `notification-view.ts` to Key Modules; update the IPC Request Flow diagram (lease callbacks → registry events) and the Lease Pattern design note (window-keyed bindings). Update `codemap.md` (root) only if its architecture-flow line 4 needs the registry mention.
- [ ] **Step 3:** Manual matrix on Windows (from the spec): multi-tab Windows Terminal → one pet, one row per tab-session; two terminal windows + VS Code → three pets max; `openpets_adopt` mid-run → window re-binds, sprite swaps; adopt same pet from second window → pet moves windows; kill Claude (terminal open) → farewell + default-pet notice; close terminal window → instant despawn; scurry on two monitors; hide → badge accumulates → Show hidden pets; pool toggle on → new windows draw pool pets, off → they collapse to default coverage.
- [ ] **Step 4:** Commit any doc updates — `git commit -m "docs(desktop): codemap updates for window pet registry and notification centre"`.

---

## Self-review notes (already applied)

- **Spec coverage:** every spec section maps to a task — model/lifecycle (3-4), async-identity 3s grace (Task 4 Step 2), notification centre (2, 5), labels/cwd (1), routing (6), farewell + session-ended notice (7), scurry/hide/close (8), policy state (9), pool rescope (3-4), error handling (6 Step 4 focus-failure, 4 identity-failure = default coverage), testing (each task + 10).
- **Deliberate deviations from spec, carried into planning:** (a) flyout fits inside the existing 340×420 window instead of enlarging bounds — cheaper and avoids Linux setShape/drag-clamp rework; (b) hidden-pet set is in-memory, not persisted — window keys don't survive restarts; (c) pool-session leases report `usingDefaultPet: true` (binding decides the visible pet); (d) a pet adopted in a second window MOVES there (one pet = one window, physical-pet metaphor); (e) the spec's "window gone" row state is realized as row removal at teardown plus the session-ended notice on the default pet, rather than a dedicated greyed-out row state.
- **Type consistency:** `RegistrySessionInfo.label` is computed once at identify-time from `sessionLabelFromCwd(raw.cwd, raw.terminalAppName ?? "session")` and reused by `recordSessionNotification` — both call the same helper with the same fallback; focus targets are `{ terminalOwnerPid, terminalWindowId? }` everywhere (Tasks 3, 6).
