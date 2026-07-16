# Session Pet Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deterministic, user-controllable pet assignment: pets stick to projects (persisted cwd → pet memory), the Sessions tab gets a per-window pet picker, and pool auto-draw becomes opt-in (off by default) per the approved spec `docs/superpowers/specs/2026-07-16-session-pet-assignment-design.md`.

**Architecture:** A pure `project-pet-memory` module + app-state persistence feed a new "remembered pet" step in the window-pet-registry's resolution chain (window binding → project memory → opt-in pool → default). The wire protocol's `requestedPetId` becomes tri-state (`string` = explicit pet, `null` = explicitly default, absent = unspecified). The Control Center gains `assignWindowPet` / `clearProjectPetAssignments` IPC and a window-grouped Sessions tab.

**Tech Stack:** TypeScript, Electron, plain-Node test files with `node:assert/strict` (no framework), pnpm workspaces, React (renderer), flat dotted-key i18n.

## Global Constraints

- KISS > DRY, YAGNI. Follow existing file patterns exactly (this repo has strong idioms — imitate the verbatim excerpts in each task).
- Conventional commits matching repo history: `feat(desktop): …`, `fix(mcp): …`, `test: …`.
- **Stage files individually.** NEVER `git add -A` or `git add .` — the working tree may hold unrelated changes.
- Desktop tests: from `apps/desktop`, `pnpm test` runs everything; a single file runs via `pnpm test:build && node .test-dist/tests/<name>.test.js`. **New test files MUST be registered in `apps/desktop/scripts/run-tests.mjs`** (the array listing test files).
- One pet per OS window stands. Leases/TTL/heartbeats/nonces are untouched except the `requestedPetId` type widening.
- `MessageKey` derives from `apps/desktop/src/i18n/locales/en.ts` — add keys there first; other locales are `Partial<Messages>` falling back to English.
- Windows dev machine: paths in tests must not assume POSIX (`normalizeProjectPath` takes an explicit case-insensitivity flag).

## Task Dependency Map

| Task | Depends on | Parallel-safe with |
|---|---|---|
| 1 memory store + app-state | — | 2, 3, 4 |
| 2 lease-manager tri-state | — | 1, 3, 4 |
| 3 registry resolution + assign | — | 1, 2, 4 |
| 4 wire protocol tri-state | — | 1, 2, 3 |
| 5 local-ipc glue | 1, 2, 3, 4 | — |
| 6 Control Center backend | 5 | 7 (interfaces pinned) |
| 7 renderer Sessions tab | 6 | 8 |
| 8 Settings UI + i18n | 6 | 7 |
| 9 verification pass | all | — |

---

### Task 1: Project memory store (pure module + app-state integration + pool default flip)

**Files:**
- Create: `apps/desktop/src/project-pet-memory.ts`
- Create: `apps/desktop/tests/project-pet-memory.test.ts`
- Modify: `apps/desktop/src/app-state.ts` (type ~line 55, defaults ~line 687, `normalizePreferences` ~line 605, new setters near `setPetPoolOrder` ~line 254)
- Modify: `apps/desktop/scripts/run-tests.mjs` (register new test file)

**Interfaces:**
- Consumes: `assertSafePetId` from `./pet-paths.js`; app-state internals `getInitializedState` / `normalizeState` / `commitState` / `getAppStateSnapshot` (all already in app-state.ts).
- Produces (used by Tasks 5, 6):
  - `normalizeProjectPath(cwd: unknown, caseInsensitive?: boolean): string | null`
  - `normalizeProjectPetAssignments(value: unknown): Record<string, string> | undefined`
  - `withProjectPetAssignment(existing: Record<string, string> | undefined, key: string, petId: string): Record<string, string>`
  - `withoutProjectPetAssignment(existing: Record<string, string> | undefined, key: string): Record<string, string> | undefined`
  - `maxProjectPetAssignments = 128`
  - app-state exports: `rememberProjectPet(cwd: string, petId: string): OpenPetsStateV1`, `forgetProjectPet(cwd: string): OpenPetsStateV1`, `clearProjectPetAssignments(): OpenPetsStateV1`, `getRememberedProjectPet(cwd: string | undefined): string | undefined`
  - Preference field: `readonly projectPetAssignments?: Record<string, string>` — **not** added to `PreferencePatch` (dedicated setters only, like `setPetPoolOrder`).
  - `preferences.petPoolEnabled` default becomes `false`.

- [ ] **Step 1: Write the failing test** — `apps/desktop/tests/project-pet-memory.test.ts`:

```typescript
import assert from "node:assert/strict";

import {
  maxProjectPetAssignments,
  normalizeProjectPath,
  normalizeProjectPetAssignments,
  withProjectPetAssignment,
  withoutProjectPetAssignment,
} from "../src/project-pet-memory.js";

// normalizeProjectPath
assert.equal(normalizeProjectPath(undefined), null, "non-string -> null");
assert.equal(normalizeProjectPath("   "), null, "blank -> null");
assert.equal(normalizeProjectPath("a".repeat(1025)), null, "too long -> null");
assert.equal(normalizeProjectPath("/home/user/proj/"), "/home/user/proj", "trailing slash stripped");
assert.equal(normalizeProjectPath("C:\\Users\\Dev\\Proj\\", true), "c:/users/dev/proj", "win32: backslashes + lowercase");
assert.equal(normalizeProjectPath("/Case/Kept", false), "/Case/Kept", "case kept when case-sensitive");
assert.equal(normalizeProjectPath("/"), "/", "root survives");

// normalizeProjectPetAssignments
assert.equal(normalizeProjectPetAssignments(undefined), undefined, "undefined -> undefined");
assert.equal(normalizeProjectPetAssignments([]), undefined, "array -> undefined");
assert.equal(normalizeProjectPetAssignments({}), undefined, "empty -> undefined");
assert.deepEqual(
  normalizeProjectPetAssignments({ "/a/b/": "fox", "  ": "cat", "/c": 7, "/d": "Bad Pet!" }),
  { "/a/b": "fox" },
  "keeps only valid path->safe-pet-id entries",
);
{
  const big: Record<string, string> = {};
  for (let i = 0; i < maxProjectPetAssignments + 10; i++) big[`/p/${i}`] = "fox";
  const normalized = normalizeProjectPetAssignments(big);
  assert.equal(Object.keys(normalized ?? {}).length, maxProjectPetAssignments, "capped on read");
}

// withProjectPetAssignment — recency refresh + eviction
{
  let map: Record<string, string> | undefined;
  map = withProjectPetAssignment(map, "/a", "fox");
  map = withProjectPetAssignment(map, "/b", "cat");
  map = withProjectPetAssignment(map, "/a", "dog"); // refreshes /a to newest
  assert.deepEqual(Object.entries(map), [["/b", "cat"], ["/a", "dog"]], "rewrite refreshes position");
  for (let i = 0; i < maxProjectPetAssignments; i++) map = withProjectPetAssignment(map, `/fill/${i}`, "fox");
  assert.equal(Object.keys(map).length, maxProjectPetAssignments, "capped");
  assert.equal(map["/b"], undefined, "least-recently-written evicted");
  assert.equal(map[`/fill/${maxProjectPetAssignments - 1}`], "fox", "newest kept");
}

// withoutProjectPetAssignment
assert.equal(withoutProjectPetAssignment(undefined, "/a"), undefined, "missing map passthrough");
assert.deepEqual(withoutProjectPetAssignment({ "/a": "fox", "/b": "cat" }, "/a"), { "/b": "cat" });
assert.equal(withoutProjectPetAssignment({ "/a": "fox" }, "/a"), undefined, "empty collapses to undefined");

console.log("project-pet-memory tests passed");
```

- [ ] **Step 2: Register the test and run to verify it fails** — add `"project-pet-memory.test.js"` to the test array in `apps/desktop/scripts/run-tests.mjs` (imitate neighbors). Run from `apps/desktop`: `pnpm test:build` — Expected: FAIL, cannot find module `../src/project-pet-memory.js`.

- [ ] **Step 3: Implement** — `apps/desktop/src/project-pet-memory.ts`:

```typescript
/**
 * project-pet-memory.ts — pure logic for the persisted project→pet map.
 *
 * Keys are normalized project paths (forward slashes, no trailing separator,
 * lowercased on case-insensitive filesystems); values are pet ids. The map is
 * capped: re-writing a key refreshes its position, and the least-recently-
 * written entry is evicted past the cap (same idiom as perMonitorPositions).
 */

import { assertSafePetId } from "./pet-paths.js";

export const maxProjectPetAssignments = 128;

/** Normalize a cwd into a stable map key. Returns null for unusable input. */
export function normalizeProjectPath(cwd: unknown, caseInsensitive: boolean = process.platform === "win32"): string | null {
  if (typeof cwd !== "string") return null;
  let path = cwd.trim();
  if (!path || path.length > 1024) return null;
  path = path.replace(/\\/g, "/");
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return caseInsensitive ? path.toLowerCase() : path;
}

/** Parse a persisted assignments map, dropping malformed entries. */
export function normalizeProjectPetAssignments(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  let count = 0;
  for (const [rawKey, rawPet] of Object.entries(value as Record<string, unknown>)) {
    if (count >= maxProjectPetAssignments) break;
    const key = normalizeProjectPath(rawKey);
    if (key === null || typeof rawPet !== "string") continue;
    try {
      assertSafePetId(rawPet);
    } catch {
      continue;
    }
    if (key in result) continue;
    result[key] = rawPet;
    count += 1;
  }
  return count > 0 ? result : undefined;
}

/** Insert/update one assignment, refreshing recency and evicting past the cap. */
export function withProjectPetAssignment(
  existing: Record<string, string> | undefined,
  key: string,
  petId: string,
): Record<string, string> {
  const entries = Object.entries(existing ?? {}).filter(([k]) => k !== key);
  entries.push([key, petId]);
  return Object.fromEntries(entries.slice(-maxProjectPetAssignments));
}

/** Remove one assignment; collapses an empty map back to undefined. */
export function withoutProjectPetAssignment(
  existing: Record<string, string> | undefined,
  key: string,
): Record<string, string> | undefined {
  if (!existing || !(key in existing)) return existing;
  const entries = Object.entries(existing).filter(([k]) => k !== key);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
```

- [ ] **Step 4: Run the module test** — `pnpm test:build && node .test-dist/tests/project-pet-memory.test.js` — Expected: `project-pet-memory tests passed`.

- [ ] **Step 5: Integrate into app-state.ts** — four edits, following the verbatim idioms:

(a) Preference type (after the `petPoolEnabled` member, ~line 60):
```typescript
    /** Persisted project→pet memory: normalized project path → petId.
     * Written when a pet is called (--pet, adopt, Sessions-tab picker, pool draw);
     * capped at 128 entries, least-recently-written evicted. */
    readonly projectPetAssignments?: Record<string, string>;
```

(b) Defaults (~line 687): change `petPoolEnabled: true,` to `petPoolEnabled: false,` and add `projectPetAssignments: undefined,` after it.

(c) `normalizePreferences` (~line 605), after the `petPoolEnabled` lines:
```typescript
    projectPetAssignments: normalizeProjectPetAssignments(value.projectPetAssignments),
```
with import at top: `import { normalizeProjectPath, normalizeProjectPetAssignments, withProjectPetAssignment, withoutProjectPetAssignment } from "./project-pet-memory.js";`

(d) New exported setters (place near `setPetPoolOrder`, imitating `setPerMonitorPetPosition` at app-state.ts:302-325):
```typescript
export function rememberProjectPet(cwd: string, petId: string): OpenPetsStateV1 {
  const key = normalizeProjectPath(cwd);
  if (key === null) return getAppStateSnapshot();
  const state = getInitializedState();
  const nextState = normalizeState({
    ...state,
    preferences: {
      ...state.preferences,
      projectPetAssignments: withProjectPetAssignment(state.preferences.projectPetAssignments, key, petId),
    },
  });
  commitState(nextState);
  return getAppStateSnapshot();
}

export function forgetProjectPet(cwd: string): OpenPetsStateV1 {
  const key = normalizeProjectPath(cwd);
  if (key === null) return getAppStateSnapshot();
  const state = getInitializedState();
  const nextState = normalizeState({
    ...state,
    preferences: {
      ...state.preferences,
      projectPetAssignments: withoutProjectPetAssignment(state.preferences.projectPetAssignments, key),
    },
  });
  commitState(nextState);
  return getAppStateSnapshot();
}

export function clearProjectPetAssignments(): OpenPetsStateV1 {
  const state = getInitializedState();
  const nextState = normalizeState({
    ...state,
    preferences: { ...state.preferences, projectPetAssignments: undefined },
  });
  commitState(nextState);
  return getAppStateSnapshot();
}

export function getRememberedProjectPet(cwd: string | undefined): string | undefined {
  const key = normalizeProjectPath(cwd);
  if (key === null) return undefined;
  return getInitializedState().preferences.projectPetAssignments?.[key];
}
```

- [ ] **Step 6: Run the full desktop suite** — `pnpm test`. Expected: PASS. If any existing test asserts `petPoolEnabled` defaults to `true` (candidates: `pet-pool-order.test.ts`, `onboarding-state.test.ts`), update that expectation to `false` — the flip is the spec's explicit requirement.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/project-pet-memory.ts apps/desktop/tests/project-pet-memory.test.ts apps/desktop/src/app-state.ts apps/desktop/scripts/run-tests.mjs
git commit -m "feat(desktop): persisted project-to-pet assignment memory; pool auto-draw off by default"
```
(Also stage any test file whose default-expectation you updated in Step 6.)

---

### Task 2: Lease-manager tri-state `requestedPetId`

**Files:**
- Modify: `apps/desktop/src/lease-manager.ts` (PetLease ~line 8, acquire ~line 123, snapshot ~line 461)
- Modify: `apps/desktop/tests/lease-manager.test.ts` (append cases)

**Interfaces:**
- Produces (used by Tasks 4, 5): `PetLease.requestedPetId?: string | null`; `LeaseManager.acquire(requestedPetId?: string | null, clientPid?, sessionNonce?, cwd?)`. `LeaseSnapshot.requestedPetId` stays `string | undefined` — `null` never leaves the raw lease.

- [ ] **Step 1: Write the failing test** — append to `apps/desktop/tests/lease-manager.test.ts` (imitate the file's existing construction — a `LeaseManager` with a stub `resolveTarget` returning default targets):

```typescript
// Tri-state requestedPetId: null = explicitly default.
{
  const manager = new LeaseManager({
    resolveTarget: () => ({ targetKind: "default", actualPetId: "builtin" }),
    getDefaultPetId: () => "builtin",
  });
  const lease = manager.acquire(null, 4242, "nonce-null");
  assert.equal(lease.targetKind, "default", "null resolves to default target");
  assert.equal(lease.requestedPetId, undefined, "snapshot hides null (wire response stays string|undefined)");
  const raw = manager.getRawLease(lease.leaseId);
  assert.equal(raw?.requestedPetId, null, "raw lease preserves null");
  // Reuse: same pid+nonce+null → same lease.
  const again = manager.acquire(null, 4242, "nonce-null");
  assert.equal(again.leaseId, lease.leaseId, "null-for-null reuses lease");
  // Mismatch: same pid+nonce but explicit pet → fresh lease.
  const switched = manager.acquire("fox", 4242, "nonce-null");
  assert.notEqual(switched.leaseId, lease.leaseId, "null vs explicit is a mismatch → fresh acquire");
}
```
Adjust the `resolveTarget` stub shape to exactly match neighboring tests in the file (some return `fallbackReason`); if the file constructs managers via a local helper, use it.

- [ ] **Step 2: Run to verify it fails** — `pnpm test:build && node .test-dist/tests/lease-manager.test.js` — Expected: FAIL (TS build error: `null` not assignable to `string | undefined`).

- [ ] **Step 3: Implement** — three edits in `lease-manager.ts`:

(a) `PetLease` (~line 8): `readonly requestedPetId?: string | null;`

(b) `acquire` signature (~line 123): `acquire(requestedPetId?: string | null, clientPid?: number, sessionNonce?: string, cwd?: string): LeaseSnapshot {` and change the resolve call (~line 164) to `const target = this.#resolveTarget(requestedPetId ?? undefined);` — the reuse-scan comparison `existing.requestedPetId !== requestedPetId` already distinguishes `null` from `undefined` and from strings; leave it.

(c) `snapshot()` (~line 467): `requestedPetId: lease.requestedPetId ?? undefined,`

- [ ] **Step 4: Run to verify it passes** — `pnpm test:build && node .test-dist/tests/lease-manager.test.js` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lease-manager.ts apps/desktop/tests/lease-manager.test.ts
git commit -m "feat(desktop): lease-manager accepts tri-state requestedPetId (null = explicitly default)"
```

---

### Task 3: Registry — memory resolution, explicit-default, assignPetToWindow

**Files:**
- Modify: `apps/desktop/src/window-pet-registry.ts`
- Modify: `apps/desktop/tests/window-pet-registry.test.ts` (append cases)

**Interfaces:**
- Consumes: nothing new — all inputs injected.
- Produces (used by Task 5):
  - `RegistrySessionInfo` gains `readonly cwd?: string;`
  - Constructor options gain `resolveRememberedPet?: (cwd: string | undefined, occupiedPetIds: ReadonlySet<string>) => string | null;` and `onPoolPetDrawn?: (cwd: string | undefined, petId: string) => void;`
  - `onSessionIdentified(session, requestedPetId: string | null | undefined, poolEnabled: boolean): string | null` — `null` = explicitly default.
  - `assignPetToWindow(windowKey: WindowKey, petId: string | null): boolean`

- [ ] **Step 1: Write the failing tests** — append to `apps/desktop/tests/window-pet-registry.test.ts`. The file's idiom (verbatim from its head) is a `calls` array + callback recorder; new scenarios construct fresh registries:

```typescript
// --- Task 3 scenarios: project memory, explicit-default, assignPetToWindow ---
function makeRecorder() {
  const recorded: Call[] = [];
  return {
    recorded,
    cb: {
      spawnPet: (...args: unknown[]) => recorded.push({ fn: "spawn", args }),
      closePet: (...args: unknown[]) => recorded.push({ fn: "close", args }),
      rebindPet: (...args: unknown[]) => recorded.push({ fn: "rebind", args }),
      sessionEndedNotice: (...args: unknown[]) => recorded.push({ fn: "notice", args }),
    },
  };
}

// Memory beats pool; pool draw reports via onPoolPetDrawn.
{
  const { recorded, cb } = makeRecorder();
  const drawn: Array<[string | undefined, string]> = [];
  const reg = new WindowPetRegistry({
    callbacks: cb,
    isPidAlive: () => true,
    drawPoolPet: () => "poolpet",
    resolveRememberedPet: (cwd) => (cwd === "/proj/a" ? "membot" : null),
    onPoolPetDrawn: (cwd, petId) => drawn.push([cwd, petId]),
  });
  const sA = { sessionKey: "1:a", leaseId: "LA", terminalOwnerPid: 10, terminalWindowId: 1, label: "a", cwd: "/proj/a" };
  assert.equal(reg.onSessionIdentified(sA, undefined, true), "membot", "memory wins over pool");
  assert.deepEqual(recorded.map((c) => c.fn), ["spawn"]);
  assert.deepEqual(drawn, [], "no pool draw when memory hit");
  const sB = { sessionKey: "2:b", leaseId: "LB", terminalOwnerPid: 20, terminalWindowId: 2, label: "b", cwd: "/proj/b" };
  assert.equal(reg.onSessionIdentified(sB, undefined, true), "poolpet", "no memory → pool draw");
  assert.deepEqual(drawn, [["/proj/b", "poolpet"]], "pool draw reported with cwd");
}

// Memory respects user-closed windows and is skipped when pool disabled? No —
// memory applies regardless of poolEnabled; only user-closed suppresses it.
{
  const { cb } = makeRecorder();
  const reg = new WindowPetRegistry({
    callbacks: cb,
    isPidAlive: () => true,
    resolveRememberedPet: () => "membot",
  });
  const s = { sessionKey: "3:c", leaseId: "LC", terminalOwnerPid: 30, terminalWindowId: 3, label: "c", cwd: "/proj/c" };
  assert.equal(reg.onSessionIdentified(s, undefined, false), "membot", "memory applies with pool off");
  reg.onUserClosedPet("w:3");
  const s2 = { sessionKey: "4:d", leaseId: "LD", terminalOwnerPid: 30, terminalWindowId: 3, label: "d", cwd: "/proj/c" };
  assert.equal(reg.onSessionIdentified(s2, undefined, false), null, "user-closed window suppresses memory bind");
}

// Explicit-default (null): unbinds, marks user-closed, session falls to default coverage.
{
  const { recorded, cb } = makeRecorder();
  const reg = new WindowPetRegistry({ callbacks: cb, isPidAlive: () => true });
  const s = { sessionKey: "5:e", leaseId: "LE", terminalOwnerPid: 50, terminalWindowId: 5, label: "e" };
  assert.equal(reg.onSessionIdentified(s, "fox", false), "fox");
  recorded.length = 0;
  assert.equal(reg.onSessionIdentified(s, null, true), null, "null → default coverage");
  assert.deepEqual(recorded.map((c) => c.fn), ["close"], "binding closed");
  assert.equal((recorded[0]!.args as unknown[])[2], "user-closed", "close reason user-closed");
  assert.equal(reg.petForWindow("w:5"), null);
  // Pool must not re-draw for this window afterwards.
  const s2 = { sessionKey: "6:f", leaseId: "LF", terminalOwnerPid: 50, terminalWindowId: 5, label: "f" };
  assert.equal(reg.onSessionIdentified(s2, undefined, true), null, "no re-draw after explicit default");
}

// assignPetToWindow: bind parked default sessions; move; unbind.
{
  const { recorded, cb } = makeRecorder();
  const reg = new WindowPetRegistry({ callbacks: cb, isPidAlive: () => true });
  const s1 = { sessionKey: "7:g", leaseId: "LG", terminalOwnerPid: 70, terminalWindowId: 7, label: "g" };
  const s2 = { sessionKey: "8:h", leaseId: "LH", terminalOwnerPid: 80, terminalWindowId: 8, label: "h" };
  assert.equal(reg.onSessionIdentified(s1, undefined, false), null, "parked on default");
  assert.equal(reg.assignPetToWindow("w:7", "fox"), true, "binds parked sessions");
  assert.equal(reg.petForWindow("w:7"), "fox");
  assert.equal(reg.displayPetForSession("7:g")?.petId, "fox", "session attached to new binding");
  // Move semantics: assigning fox to another window steals it.
  assert.equal(reg.onSessionIdentified(s2, undefined, false), null);
  recorded.length = 0;
  assert.equal(reg.assignPetToWindow("w:8", "fox"), true, "move steals from w:7");
  assert.equal(reg.petForWindow("w:7"), null);
  assert.equal(reg.petForWindow("w:8"), "fox");
  // Unbind: sessions fall to default, window suppressed.
  assert.equal(reg.assignPetToWindow("w:8", null), true, "unbind succeeds");
  assert.equal(reg.petForWindow("w:8"), null);
  assert.equal(reg.onSessionIdentified(s2, undefined, true), null, "no pool re-draw after UI default");
  // Assigning to a window with no sessions at all fails.
  assert.equal(reg.assignPetToWindow("w:99", "fox"), false, "no sessions → false");
}
```

- [ ] **Step 2: Run to verify it fails** — `pnpm test:build && node .test-dist/tests/window-pet-registry.test.js` — Expected: FAIL (unknown options / missing method).

- [ ] **Step 3: Implement** in `window-pet-registry.ts`:

(a) `RegistrySessionInfo` gains `readonly cwd?: string;` (after `label`).

(b) Constructor: add fields + options (mirror `#drawPoolPet` idiom exactly):
```typescript
  readonly #resolveRememberedPet: (cwd: string | undefined, occupiedPetIds: ReadonlySet<string>) => string | null;
  readonly #onPoolPetDrawn: (cwd: string | undefined, petId: string) => void;
```
options type gains `resolveRememberedPet?` / `onPoolPetDrawn?`; constructor body:
```typescript
    this.#resolveRememberedPet = options.resolveRememberedPet ?? (() => null);
    this.#onPoolPetDrawn = options.onPoolPetDrawn ?? (() => {});
```

(c) Replace `onSessionIdentified` (currently lines 82-109) with:
```typescript
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
```

(d) New method + helper (place after `onUserClosedPet`):
```typescript
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
    this.#userClosedWindows.delete(windowKey);
    const current = this.#bindings.get(windowKey);
    if (current && current.petId === petId) return true;
    const otherKey = this.windowForPet(petId);
    if (otherKey !== null && otherKey !== windowKey) this.#closeBinding(otherKey, "rebind");
    if (current) {
      const fromPetId = current.petId;
      current.petId = petId;
      current.origin = "explicit";
      this.#callbacks.rebindPet(windowKey, fromPetId, petId);
      return true;
    }
    const parked = [...this.#defaultSessions.values()].filter(
      (s) => windowKeyForIdentity(s.terminalWindowId, s.terminalOwnerPid) === windowKey,
    );
    if (parked.length === 0) return false;
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
```

- [ ] **Step 4: Run to verify it passes** — `pnpm test:build && node .test-dist/tests/window-pet-registry.test.js`, then the full `pnpm test` — Expected: PASS (existing scenarios unchanged: the old pool path only moved inside the `!userClosedWindows` guard it already had).

- [ ] **Step 5: Update the module map** — `apps/desktop/src/codemap.md` mentions `onSessionIdentified()`; extend its line to note memory → pool → default resolution and `assignPetToWindow`. Keep it to 1-2 lines.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/window-pet-registry.ts apps/desktop/tests/window-pet-registry.test.ts apps/desktop/src/codemap.md
git commit -m "feat(desktop): registry resolves project memory before pool; explicit-default and window assignment"
```

---

### Task 4: Wire protocol tri-state (client + MCP + desktop validator)

**Files:**
- Modify: `packages/client/src/index.ts` (acquireLease option type, line 70)
- Modify: `packages/client/contracts/client-protocol.contract.ts` (null serialization case)
- Modify: `packages/mcp/src/tools.ts` (`resolveRequestedPetId` lines 53-56; `handleAdopt` acquire call line ~141)
- Modify: `packages/mcp/src/check-mcp-contract.ts` (extend T9)
- Modify: `apps/desktop/src/local-ipc-protocol.ts` (`validateRequestedPetId` lines 106-115)
- Modify: the desktop test covering local-ipc-protocol if present (check `apps/desktop/tests/` for a matching file; if none exists, the lease-manager + registry tests cover the null path — do not create a new file just for one branch).

**Interfaces:**
- Produces (used by Task 5): `validateRequestedPetId(value: unknown): string | null | undefined` — `null` in → `null` out. Client: `acquireLease(options?: { readonly requestedPetId?: string | null })`. MCP: `resolveRequestedPetId(...): string | null | undefined` — stops collapsing `null`; adopt-to-default sends `null` on the wire.
- Version-skew note (accepted): a new MCP client sending `null` to an OLD desktop gets an `invalid_params` error on adopt-to-default only; normal startup is unaffected (absent stays absent).

- [ ] **Step 1: Write the failing MCP contract check** — in `check-mcp-contract.ts`, extend the T9 block (after the raccoon adopt assertions, lines ~353-362). The mock `acquireLease` there records `calls.push("acquire:" + ...)`; make the recording distinguish null, then:

```typescript
// T9c: adopt with no petId returns to default — must send null (not undefined) on the wire.
await mc.callTool({ name: "openpets_adopt", arguments: {} }, CallToolResultSchema);
if (!calls.includes("acquire:null")) throw new Error(`T9c: adopt-to-default did not send requestedPetId=null. calls=${calls.join(",")}`);
```
Adapt the exact recording expression to the mock's current shape: where the mock does `calls.push(\`acquire:${options?.requestedPetId}\`)` (or similar), ensure `null` records as the literal `"acquire:null"` — `String(null)` already yields `"null"`, while `undefined` yields `"acquire:undefined"`; if T9's existing assertions relied on `"acquire:undefined"` for the old collapse behavior, update them to `null`.

- [ ] **Step 2: Run to verify it fails** — from `packages/mcp`: `pnpm build && pnpm test` — Expected: FAIL at T9c (old code collapses null → undefined → configured pet).

- [ ] **Step 3: Implement MCP + client:**

(a) `packages/mcp/src/tools.ts` lines 53-56:
```typescript
/** Effective pet id for (re)acquiring this session's lease.
 *  string = explicit pet · null = explicitly default (adopted) · undefined = unspecified. */
export function resolveRequestedPetId(lease: LeaseContext | undefined, configuredPetId: string | undefined): string | null | undefined {
  if (!lease || lease.requestedPetId === undefined) return configuredPetId;
  return lease.requestedPetId;
}
```

(b) `handleAdopt` (line ~141): change `await client.acquireLease({ requestedPetId });` to `await client.acquireLease({ requestedPetId: requestedPetId ?? null });`

(c) `packages/client/src/index.ts` line 70: `acquireLease(options?: { readonly requestedPetId?: string | null }): Promise<OpenPetsLeaseResult>;` — the serialization at line 106 already passes the value through (`JSON.stringify` preserves `null`, omits `undefined`). No other client change.

- [ ] **Step 4: Client contract case** — in `packages/client/contracts/client-protocol.contract.ts`, add next to the existing acquire-serialization assertions (imitate the file's harness for capturing the outgoing request params):
```typescript
// Tri-state: null must survive serialization (explicitly-default adopt).
// Capture the params of acquireLease({ requestedPetId: null }) and assert:
assert.equal(capturedParams.requestedPetId, null, "null requestedPetId is sent, not dropped");
// And for acquireLease() with no options, requestedPetId must be absent:
assert.ok(!("requestedPetId" in capturedParamsNoOption) || capturedParamsNoOption.requestedPetId === undefined);
```
Use the file's existing request-capture mechanism verbatim (it stubs the socket/discovery); if it asserts full param objects, extend those objects instead.

- [ ] **Step 5: Desktop validator** — `apps/desktop/src/local-ipc-protocol.ts` lines 106-115:
```typescript
export function validateRequestedPetId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null; // tri-state: explicitly-default request
  if (typeof value !== "string") throw new IpcProtocolError("invalid_params", "Requested pet id must be a string.");
  const trimmed = value.trim();
  if (trimmed.length < 1) return undefined;
  if (Buffer.byteLength(trimmed, "utf8") > 128 || /[\x00-\x1F\x7F/\\]/.test(trimmed)) {
    throw new IpcProtocolError("invalid_params", "Requested pet id is outside CLI bounds.");
  }
  return trimmed;
}
```

- [ ] **Step 6: Run all three package tests** — `packages/mcp`: `pnpm build && pnpm test`; `packages/client`: `pnpm test`; `apps/desktop`: `pnpm test` — Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp/src/tools.ts packages/mcp/src/check-mcp-contract.ts packages/client/src/index.ts packages/client/contracts/client-protocol.contract.ts apps/desktop/src/local-ipc-protocol.ts
git commit -m "feat(mcp): tri-state requestedPetId — adopt-to-default sends explicit null on the wire"
```

---

### Task 5: local-ipc glue — memory wiring, acquire handler, assignWindowPet, snapshot

**Files:**
- Modify: `apps/desktop/src/local-ipc.ts` only.

**Interfaces:**
- Consumes: Task 1 app-state exports (`getRememberedProjectPet`, `rememberProjectPet`, `forgetProjectPet`); Task 2 lease types; Task 3 registry options/methods; Task 4 validator.
- Produces (used by Tasks 6, 7):
  - `export function assignWindowPet(windowKey: string, petId: string | null): boolean`
  - `EnrichedSessionSnapshot` gains `readonly windowKey?: string;`
  - `getSessionsSnapshot()` return gains `assignablePets: ReadonlyArray<{ id: string; displayName: string; inUse: boolean }>` and its `pool.used` counts registry-bound pool pets.

This module transitively imports Electron, so it has no direct unit test — correctness rides on the Task 1-4 unit tests plus Task 9 verification. Keep every addition thin: delegate to the tested modules.

- [ ] **Step 1: Imports** — extend the existing `./app-state.js` import with `getRememberedProjectPet, rememberProjectPet, forgetProjectPet`.

- [ ] **Step 2: Wire the registry options** (constructor at line ~132, after `drawPoolPet`):
```typescript
  resolveRememberedPet: (cwd, occupied) => {
    const remembered = getRememberedProjectPet(cwd);
    if (!remembered) return null;
    const state = getAppStateSnapshot();
    const eligible = getEligiblePoolPetIds(state.pets.installed, builtInPet.id, getCurrentDefaultPet().id);
    if (!eligible.includes(remembered)) {
      // Stale entry (uninstalled / broken / became default) — prune on read.
      if (cwd) forgetProjectPet(cwd);
      return null;
    }
    if (occupied.has(remembered)) return null; // non-stealing: first window won
    return remembered;
  },
  onPoolPetDrawn: (cwd, petId) => {
    if (cwd) rememberProjectPet(cwd, petId);
  },
```

- [ ] **Step 3: Write-once guard + session-gone pruning** — near `warnedFallbackPets` (line ~203):
```typescript
/** sessionKey → petIds whose project-memory write already happened. Guards
 *  lease re-acquires (which re-send the same --pet) from overwriting a newer
 *  assignment; a NEW pet for the same session (adopt/UI) still writes. */
const projectMemoryWrites = new Map<string, Set<string>>();

function recordProjectMemoryOnce(sessionKey: string | null, cwd: string | undefined, petId: string): void {
  if (!sessionKey || !cwd) return;
  let seen = projectMemoryWrites.get(sessionKey);
  if (!seen) {
    seen = new Set();
    projectMemoryWrites.set(sessionKey, seen);
  }
  if (seen.has(petId)) return;
  seen.add(petId);
  rememberProjectPet(cwd, petId);
}
```
Then find every call site of `windowPetRegistry.onSessionGone(sessionKey)` (there are four: the `lease.release` handler, `notifyLeaseGone`, `releaseExplicitLease`, `releaseSessionFromUi`) and add `projectMemoryWrites.delete(sessionKey);` immediately before each call (sessionKey is non-null at each site).

- [ ] **Step 4: acquire handler** (lines ~530-567) — after `const lease = leaseManager.acquire(requestedPetId, clientPid, sessionNonce, cwd);` insert:
```typescript
    // Project memory: an explicitly-called pet is remembered for this project;
    // an explicit return-to-default forgets it (spec: tri-state requestedPetId).
    if (requestedPetId === null && cwd) forgetProjectPet(cwd);
    if (lease.targetKind === "explicit" && cwd) {
      recordProjectMemoryOnce(
        clientPid !== undefined && sessionNonce !== undefined ? `${clientPid}:${sessionNonce}` : null,
        cwd,
        lease.actualTargetPetId,
      );
    }
```
No other change: `validateRequestedPetId` (Task 4) already returns the tri-state, and `leaseManager.acquire` (Task 2) already accepts it. The explicit-lease 3s grace block only fires for `targetKind === "explicit"` — unaffected by null.

- [ ] **Step 5: registerIdentifiedSession** (lines ~760-774) — pass cwd and the tri-state through:
```typescript
  return windowPetRegistry.onSessionIdentified(
    {
      sessionKey: `${raw.clientPid}:${raw.sessionNonce}`,
      leaseId,
      terminalOwnerPid: raw.terminalOwnerPid,
      terminalWindowId: raw.terminalWindowId,
      label: sessionLabelFromCwd(raw.cwd, raw.terminalAppName ?? "session"),
      cwd: raw.cwd,
    },
    raw.targetKind === "explicit" ? raw.actualPetId : raw.requestedPetId === null ? null : undefined,
    getAppStateSnapshot().preferences.petPoolEnabled === true,
  );
```

- [ ] **Step 6: assignWindowPet export** — place after `toggleSessionPetVisibility` (line ~1213):
```typescript
/** Control-Center: assign petId to a window's binding (null = return to default).
 *  Writes/clears project memory for every distinct cwd among the window's sessions. */
export function assignWindowPet(windowKey: string, petId: string | null): boolean {
  if (petId !== null) {
    const state = getAppStateSnapshot();
    const eligible = getEligiblePoolPetIds(state.pets.installed, builtInPet.id, getCurrentDefaultPet().id);
    if (!eligible.includes(petId)) return false;
  }
  if (!windowPetRegistry.assignPetToWindow(windowKey, petId)) return false;
  for (const lease of leaseManager.getAllRawLeases()) {
    if (!lease.terminalOwnerPid) continue;
    if (windowKeyForIdentity(lease.terminalWindowId, lease.terminalOwnerPid) !== windowKey) continue;
    if (!lease.cwd) continue;
    const sessionKey = sessionKeyForLease(lease);
    if (petId === null) {
      forgetProjectPet(lease.cwd);
    } else {
      rememberProjectPet(lease.cwd, petId);
      // Mark as written so a later --pet re-acquire can't overwrite this choice.
      if (sessionKey) {
        let seen = projectMemoryWrites.get(sessionKey);
        if (!seen) {
          seen = new Set();
          projectMemoryWrites.set(sessionKey, seen);
        }
        seen.add(petId);
      }
    }
  }
  info("ipc", "window pet assigned from ui", { windowKey, petId });
  return true;
}
```
(`windowKeyForIdentity` is already imported in this file.)

- [ ] **Step 7: getSessionsSnapshot additions** (lines ~1120-1179):

(a) `EnrichedSessionSnapshot` gains `readonly windowKey?: string;` (with the other additions at lines 43-54).

(b) In the per-lease mapping, compute and include:
```typescript
    const windowKey = lease.terminalOwnerPid ? windowKeyForIdentity(lease.terminalWindowId, lease.terminalOwnerPid) : undefined;
```
and add `windowKey` to the returned object literal.

(c) Return-type and body additions — the function's declared return type gains `assignablePets: ReadonlyArray<{ id: string; displayName: string; inUse: boolean }>;` and before the final `return`:
```typescript
  const boundPets = new Set(windowPetRegistry.boundPetIds());
  const assignableEligible = getEligiblePoolPetIds(state.pets.installed, builtInPet.id, state.preferences.defaultPetId);
  const assignablePets = assignableEligible.map((id) => ({ id, displayName: getPetDisplayName(id), inUse: boundPets.has(id) }));
```
include `assignablePets` in the returned object.

(d) Fix `pool.used` to count what is actually on screen — registry-bound pool pets (drawn or assigned) plus lease-explicit ones:
```typescript
    const usedSlots = poolOrder.filter((id) => eligibleSet.has(id) && (boundPets.has(id) || leaseManager.countExplicitLeases(id) > 0)).length;
```
(move the `boundPets` computation above the `pool` block so both use it).

- [ ] **Step 8: Typecheck + full suite** — from `apps/desktop`: `pnpm test` (its build step typechecks the sources). Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/local-ipc.ts
git commit -m "feat(desktop): wire project memory into session identification; assignWindowPet; window-keyed sessions snapshot"
```

---

### Task 6: Control Center backend — IPC handlers + preload

**Files:**
- Modify: `apps/desktop/src/windows.ts` (new handlers next to the session handlers at lines 201-222)
- Modify: `apps/desktop/control-center-preload.cjs`

**Interfaces:**
- Consumes: `assignWindowPet` from `./local-ipc.js` (Task 5), `clearProjectPetAssignments` from `./app-state.js` (Task 1).
- Produces (used by Tasks 7, 8): renderer-callable `api.assignWindowPet(windowKey: string, petId: string | null): Promise<{ assigned: boolean }>` and `api.clearProjectPetAssignments(): Promise<SettingsState>`.

- [ ] **Step 1: windows.ts handlers** — imitate the verbatim `openpets:session-toggle-pet` handler (lines 218-222); place these directly after it:
```typescript
  ipcMain.handle("openpets:session-assign-pet", (event, windowKey: unknown, petId: unknown) => {
    assertAllowedSender(event, ["control-center"]);
    if (typeof windowKey !== "string" || windowKey.length === 0) throw new Error("Invalid window key.");
    if (petId !== null && typeof petId !== "string") throw new Error("Invalid pet id.");
    return { assigned: assignWindowPet(windowKey, petId) };
  });

  ipcMain.handle("openpets:clear-project-pet-assignments", (event) => {
    assertAllowedSender(event, ["control-center"]);
    clearProjectPetAssignments();
    return getSettingsStateSnapshot();
  });
```
Add `assignWindowPet` to the existing `./local-ipc.js` import in windows.ts (the file already imports `getSessionsSnapshot`, `releaseSessionFromUi`, etc. — extend that import), and `clearProjectPetAssignments` to the `./app-state.js` import. `getSettingsStateSnapshot` is already used by the `openpets:update-preferences` handler — reuse it.

- [ ] **Step 2: Preload** — in `control-center-preload.cjs`, next to `toggleSessionPet`:
```javascript
  assignWindowPet: (windowKey, petId) => ipcRenderer.invoke("openpets:session-assign-pet", windowKey, petId),
  clearProjectPetAssignments: () => ipcRenderer.invoke("openpets:clear-project-pet-assignments"),
```

- [ ] **Step 3: Typecheck** — from `apps/desktop`: `pnpm test:build`. Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/windows.ts apps/desktop/control-center-preload.cjs
git commit -m "feat(desktop): control-center IPC for window pet assignment and memory clearing"
```

---

### Task 7: Renderer — window-grouped Sessions tab with pet picker

**Files:**
- Modify: `apps/desktop/src/renderer/src/main.tsx` (types lines ~30-32, ~71-82; `SessionsView` lines ~497-662)
- Modify: `apps/desktop/src/renderer/src/styles.css` (two new classes)

Depends on Task 8's i18n keys existing in `en.ts` (keys listed below are added there by Task 8 — if executing this task first, add the `sessions.*` keys from Task 8's table to `en.ts` in this task instead and note it for Task 8).

**Interfaces:**
- Consumes: `windowKey` + `assignablePets` in the snapshot (Task 5); `api.assignWindowPet` (Task 6).
- Produces: user-visible Sessions tab; i18n keys consumed: `sessions.group.defaultPet`, `sessions.group.identifying`, `sessions.picker.default`, `sessions.picker.inUse`, `sessions.picker.label`.

- [ ] **Step 1: Types** — in main.tsx:
  - `SessionLeaseSnapshot` (line ~30) gains `windowKey?: string`.
  - `SessionsSnapshot` (line ~32) gains `assignablePets: { id: string; displayName: string; inUse: boolean }[]`.
  - `ControlCenterApi` (lines ~71-82) gains:
    ```typescript
    assignWindowPet(windowKey: string, petId: string | null): Promise<{ assigned: boolean }>;
    clearProjectPetAssignments(): Promise<SettingsState>;
    ```

- [ ] **Step 2: Group + render** — inside `SessionsView`, before the `return`, group the sessions:
```typescript
  const IDENTIFYING = "__identifying__";
  const groups = new Map<string, SessionLeaseSnapshot[]>();
  for (const s of snapshot.sessions) {
    const key = s.windowKey ?? IDENTIFYING;
    const list = groups.get(key);
    if (list) list.push(s);
    else groups.set(key, [s]);
  }
```
Replace the flat `{snapshot.sessions.map(...)}` table body (keep the surrounding `sessions-table` div and the existing header row and row cells EXACTLY as they are — rows keep every existing cell including the pet cell) with a per-group render:
```tsx
            {[...groups.entries()].map(([groupKey, groupSessions]) => {
              const isIdentifying = groupKey === IDENTIFYING;
              const lead = groupSessions[0]!;
              const groupPetId = isIdentifying ? undefined : lead.displayPetId;
              const groupPetName = groupPetId ? (lead.displayPetName ?? groupPetId) : undefined;
              return (
                <div key={groupKey} className="sessions-group">
                  <div className="sessions-group-header">
                    <span className="sessions-group-title">
                      {isIdentifying ? t("sessions.group.identifying") : (lead.terminalAppName || "—")}
                      {!isIdentifying && <span className="sessions-pet-name">{groupPetName ?? t("sessions.group.defaultPet")}</span>}
                      {!isIdentifying && (
                        <span className={`pill text-[9px] px-1.5 py-0 ${lead.displayPetOrigin === "pool" ? "pill-orange" : groupPetId ? "pill-purple" : "pill-blue"}`}>
                          {lead.displayPetOrigin === "pool" ? t("sessions.badge.pool") : groupPetId ? t("sessions.badge.explicit") : t("sessions.badge.default")}
                        </span>
                      )}
                    </span>
                    {!isIdentifying && (
                      <label className="sessions-pet-picker-label" title={t("sessions.picker.label")}>
                        <select
                          className="sessions-pet-picker"
                          value={groupPetId ?? ""}
                          onChange={(e) => {
                            const v = e.target.value;
                            void api.assignWindowPet(groupKey, v === "" ? null : v).then(() => void load());
                          }}
                        >
                          <option value="">{groupPetId ? t("sessions.picker.default") : `${t("sessions.picker.default")} — ${groupPetName ?? ""}`.trim()}</option>
                          {snapshot.assignablePets.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.inUse && p.id !== groupPetId ? t("sessions.picker.inUse").replace("{name}", p.displayName) : p.displayName}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                  {groupSessions.map((s) => (
                    /* existing per-session row JSX from the current file, UNCHANGED, keyed by s.leaseId */
                  ))}
                </div>
              );
            })}
```
The per-session row block is the existing `<div key={s.leaseId} className="sessions-table-row">…</div>` from lines 608-638 — move it inside the group loop verbatim. When a window has no pet, the header's Default option label is just "Default" (`groupPetName` undefined). Simplify the first `<option>` to `{t("sessions.picker.default")}` if the composed label reads awkwardly — the picker's `value=""` selection state is what matters.

- [ ] **Step 3: CSS** — append to `styles.css`, using existing sessions-* styles as the idiom (stone/amber palette from the Control Center overhaul):
```css
.sessions-group { margin-bottom: 10px; }
.sessions-group-header {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; padding: 6px 8px; margin-top: 6px;
  border-bottom: 1px solid rgba(168, 162, 158, 0.2);
  font-size: 12px; font-weight: 600; color: #78716c;
}
.sessions-group-title { display: inline-flex; align-items: center; gap: 6px; }
.sessions-pet-picker {
  font-size: 11px; padding: 2px 6px; border-radius: 6px;
  border: 1px solid rgba(168, 162, 158, 0.4); background: rgba(255, 255, 255, 0.72);
  color: #2c2825;
}
```

- [ ] **Step 4: Build the renderer** — from `apps/desktop`: run the renderer build/typecheck script from its package.json (e.g. `pnpm build` or `pnpm typecheck` — use whichever exists; check `package.json` scripts). Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/main.tsx apps/desktop/src/renderer/src/styles.css
git commit -m "feat(desktop): window-grouped sessions tab with per-window pet picker"
```

---

### Task 8: Settings UI + i18n (all 7 locales)

**Files:**
- Modify: `apps/desktop/src/i18n/locales/en.ts` (+ `ja.ts`, `ko.ts`, `zh-Hans.ts`, `zh-Hant.ts`, `pt-BR.ts`, `es-419.ts`)
- Modify: `apps/desktop/src/renderer/src/main.tsx` (SettingsView: clear-memory button near the pool section, lines ~1420-1430)

**Interfaces:**
- Consumes: `api.clearProjectPetAssignments()` (Task 6).
- Produces: the i18n keys Task 7 consumes.

- [ ] **Step 1: en.ts changes** — flat dotted keys (MessageKey derives from this file):

Changed values:
```typescript
  "sessions.badge.explicit": "assigned",
  "settings.petPool.label": "Auto-assign pool pets to new terminal windows",
  "settings.petPool.description": "When on, a new terminal window with no remembered pet draws the next free pet from the pool.",
```
New keys:
```typescript
  "sessions.group.defaultPet": "Default pet",
  "sessions.group.identifying": "Identifying…",
  "sessions.picker.default": "Default",
  "sessions.picker.inUse": "{name} (in use)",
  "sessions.picker.label": "Assign pet",
  "settings.memory.clear": "Clear remembered assignments",
  "settings.memory.description": "Forget which pet belongs to which project folder.",
  "settings.toast.memoryCleared": "Remembered assignments cleared.",
```

- [ ] **Step 2: Other 6 locales** — add/update the same keys with these values:

| Key | ja | ko | zh-Hans | zh-Hant | pt-BR | es-419 |
|---|---|---|---|---|---|---|
| sessions.badge.explicit | 割り当て | 할당됨 | 已分配 | 已指派 | atribuído | asignada |
| sessions.group.defaultPet | デフォルトペット | 기본 펫 | 默认宠物 | 預設寵物 | Pet padrão | Mascota predeterminada |
| sessions.group.identifying | 識別中… | 식별 중… | 识别中… | 識別中… | Identificando… | Identificando… |
| sessions.picker.default | デフォルト | 기본 | 默认 | 預設 | Padrão | Predeterminada |
| sessions.picker.inUse | {name}(使用中) | {name} (사용 중) | {name}（使用中） | {name}（使用中） | {name} (em uso) | {name} (en uso) |
| sessions.picker.label | ペットを割り当て | 펫 할당 | 分配宠物 | 指派寵物 | Atribuir pet | Asignar mascota |
| settings.petPool.label | 新しいターミナルウィンドウにプールのペットを自動割り当て | 새 터미널 창에 풀의 펫 자동 할당 | 为新终端窗口自动分配宠物池中的宠物 | 為新終端機視窗自動指派寵物池中的寵物 | Atribuir automaticamente pets do pool a novas janelas de terminal | Asignar automáticamente mascotas del grupo a nuevas ventanas de terminal |
| settings.petPool.description | オンにすると、記憶されたペットのない新しいターミナルウィンドウはプールから次の空きペットを引き当てます。 | 켜면 기억된 펫이 없는 새 터미널 창이 풀에서 다음 빈 펫을 가져옵니다. | 开启后，没有已记住宠物的新终端窗口将从宠物池中抽取下一个空闲宠物。 | 開啟後，沒有已記住寵物的新終端機視窗會從寵物池抽取下一個空閒寵物。 | Quando ativado, uma nova janela de terminal sem pet memorizado recebe o próximo pet livre do pool. | Al activarlo, una ventana de terminal nueva sin mascota recordada toma la siguiente mascota libre del grupo. |
| settings.memory.clear | 記憶された割り当てをクリア | 기억된 할당 지우기 | 清除已记住的分配 | 清除已記住的指派 | Limpar atribuições memorizadas | Borrar asignaciones recordadas |
| settings.memory.description | どのペットがどのプロジェクトフォルダーに属するかを忘れます。 | 어떤 펫이 어떤 프로젝트 폴더에 속하는지 잊습니다. | 忘记宠物与项目文件夹的对应关系。 | 忘記寵物與專案資料夾的對應關係。 | Esquece qual pet pertence a qual pasta de projeto. | Olvida qué mascota pertenece a qué carpeta de proyecto. |
| settings.toast.memoryCleared | 記憶された割り当てをクリアしました。 | 기억된 할당을 지웠습니다. | 已清除记住的分配。 | 已清除記住的指派。 | Atribuições memorizadas limpas. | Asignaciones recordadas borradas. |

- [ ] **Step 3: SettingsView button** — in main.tsx, inside the pet-pool settings block (near the `petPoolEnabled` toggle at lines ~1420-1430), add below the pool order editor, following the surrounding button/`run` idiom (see `patchPreferences` at lines ~1277-1280 for the busy/toast pattern):
```tsx
              <div className="mt-2 flex items-center gap-3">
                <Button
                  variant="secondary"
                  size="compact"
                  disabled={!settings || !!busy}
                  onClick={() => {
                    void run(t("settings.busy.saving"), async () => {
                      const next = await api.clearProjectPetAssignments();
                      setSettings(next);
                    }, t("settings.toast.memoryCleared"));
                  }}
                >
                  {t("settings.memory.clear")}
                </Button>
                <span className="text-xs text-slatecopy">{t("settings.memory.description")}</span>
              </div>
```
Adapt the `run(...)` call signature to the file's actual helper (check how `patchPreferences` shows its success toast — mirror it exactly; if `run` takes no success-message arg, show the toast the way `patchPreferences` does).

- [ ] **Step 4: Build + full desktop suite** — `pnpm test:build && pnpm test` from `apps/desktop`. Expected: PASS (the i18n catalog typecheck catches missing/typo'd keys).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/i18n/locales/en.ts apps/desktop/src/i18n/locales/ja.ts apps/desktop/src/i18n/locales/ko.ts apps/desktop/src/i18n/locales/zh-Hans.ts apps/desktop/src/i18n/locales/zh-Hant.ts apps/desktop/src/i18n/locales/pt-BR.ts apps/desktop/src/i18n/locales/es-419.ts apps/desktop/src/renderer/src/main.tsx
git commit -m "feat(desktop): pool auto-assign copy, clear-remembered-assignments action, i18n for pet picker"
```

---

### Task 9: Verification pass

**Files:** none (verification only; fix regressions where found).

- [ ] **Step 1: Full test matrix**
  - `apps/desktop`: `pnpm test` — Expected: all pass.
  - `packages/client`: `pnpm test` — Expected: pass.
  - `packages/mcp`: `pnpm build && pnpm test` — Expected: pass.

- [ ] **Step 2: Manual smoke (Windows)** — launch the app (`pnpm dev` or the repo's run script in `apps/desktop/package.json`):
  1. Pool toggle OFF (new default applies only to fresh state — flip it off in Settings for this install). Start a Claude session with no `--pet` → session lands on the **default pet**. ✔ spec "default unless called"
  2. In the Sessions tab, the session appears under its terminal-window group with a picker. Assign a pet → pet spawns on that window; every session in the group shows it.
  3. Restart OpenPets with the session still running → the window re-gains the SAME pet (project memory), no reshuffle.
  4. `openpets_adopt` to another pet → window rebinds; adopt with no petId → pet closes, session on default; new session in the same project folder later → default (memory cleared).
  5. Pool ON with 2+ pool pets configured, open two new terminal windows in two different projects → each draws a pool pet; restart → same pets on same projects.
  6. Picker "Default" on a pool-drawn window → pet closes and does NOT respawn while the toggle stays on.

- [ ] **Step 3: Commit any fixes** individually with `fix(desktop): …` messages.
