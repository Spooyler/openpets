# Hub Mode & Enhanced Flyout — Implementation Plan

> **For agentic workers:** Use sonnet for implementation, haiku for exploration, fable for review/advice. Do NOT use superpowers:subagent-driven-development.

**Goal:** Add a `sessionAssignment` setting (hub/auto-spawn), wire hook events into notification rows, enrich the flyout with window-grouped rows and live status badges, and queue speech bubbles with session labels.

**Architecture:** The `WindowPetRegistry.onSessionIdentified` method gains a `sessionAssignment` parameter that gates pool draws. A new `SessionLiveStatus` map in `local-ipc.ts` tracks per-session activity status from hook events. `notification-view.ts` gains window-grouped rendering. Speech bubbles queue in `pet-window.ts`.

**Tech Stack:** TypeScript, Electron (main process), no new dependencies.

## Global Constraints

- All paths are relative to `apps/desktop/` unless stated otherwise.
- Follow existing patterns: pure modules (no Electron imports) for testable logic; side effects via callbacks.
- i18n keys must be added to all 7 locales (en, es, ja, ko, pt-BR, zh-Hans, zh-Hant).
- Tests run via `node --test` (not vitest/jest). Test files must be registered in `apps/desktop/scripts/run-tests.mjs`.
- `pnpm --filter @open-pets/desktop typecheck` must pass after each task (use `npx tsc --noEmit` directly in `apps/desktop` to skip broken upstream deps).
- Commit format: no ticket prefix for this repo; use conventional commits (`feat:`, `fix:`, `refactor:`).

---

### Task 1: Add `sessionAssignment` and `petSelectionStrategy` to app state

**Files:**
- Modify: `src/app-state.ts` (OpenPetsStateV1 preferences type, createDefaultState, normalizePreferences)
- Modify: `src/app-state-core.ts` (add normalizer exports if needed)
- Test: `tests/app-state-assignment.test.ts` (new)

**Interfaces:**
- Produces: `preferences.sessionAssignment: "hub" | "auto-spawn"` (default `"hub"`), `preferences.petSelectionStrategy: "random" | "ordered"` (default `"random"`)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// These tests verify the new preference fields exist with correct defaults
// and normalize correctly. They will import from app-state-core.ts helpers.

describe("sessionAssignment preference", () => {
  it("defaults to hub", () => {
    // Will test normalizeSessionAssignment(undefined) === "hub"
    assert.strictEqual(normalizeSessionAssignment(undefined), "hub");
  });

  it("accepts auto-spawn", () => {
    assert.strictEqual(normalizeSessionAssignment("auto-spawn"), "auto-spawn");
  });

  it("rejects invalid values", () => {
    assert.strictEqual(normalizeSessionAssignment("invalid"), "hub");
    assert.strictEqual(normalizeSessionAssignment(42), "hub");
  });
});

describe("petSelectionStrategy preference", () => {
  it("defaults to random", () => {
    assert.strictEqual(normalizePetSelectionStrategy(undefined), "random");
  });

  it("accepts ordered", () => {
    assert.strictEqual(normalizePetSelectionStrategy("ordered"), "ordered");
  });

  it("rejects invalid values", () => {
    assert.strictEqual(normalizePetSelectionStrategy("invalid"), "random");
  });
});

describe("migration from petPoolEnabled", () => {
  it("sets auto-spawn when petPoolEnabled was true and no sessionAssignment exists", () => {
    const result = normalizePreferences({ petPoolEnabled: true });
    assert.strictEqual(result.sessionAssignment, "auto-spawn");
  });

  it("preserves hub when petPoolEnabled was false", () => {
    const result = normalizePreferences({ petPoolEnabled: false });
    assert.strictEqual(result.sessionAssignment, "hub");
  });

  it("does not override explicit sessionAssignment", () => {
    const result = normalizePreferences({ petPoolEnabled: true, sessionAssignment: "hub" });
    assert.strictEqual(result.sessionAssignment, "hub");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && node --test tests/app-state-assignment.test.ts`
Expected: FAIL — functions not defined yet

- [ ] **Step 3: Add normalizer functions to `app-state-core.ts`**

Add these exports to `src/app-state-core.ts`:

```typescript
export function normalizeSessionAssignment(value: unknown): "hub" | "auto-spawn" {
  return value === "hub" || value === "auto-spawn" ? value : "hub";
}

export function normalizePetSelectionStrategy(value: unknown): "random" | "ordered" {
  return value === "random" || value === "ordered" ? value : "random";
}
```

- [ ] **Step 4: Add fields to `OpenPetsStateV1` preferences type in `app-state.ts`**

Add to the preferences interface (after `petPoolEnabled`):

```typescript
readonly sessionAssignment: "hub" | "auto-spawn";
readonly petSelectionStrategy: "random" | "ordered";
```

- [ ] **Step 5: Update `createDefaultState` in `app-state.ts`**

Add to the defaults object:

```typescript
sessionAssignment: "hub",
petSelectionStrategy: "random",
```

- [ ] **Step 6: Update `normalizePreferences` in `app-state.ts`**

Import the new normalizers and add migration logic:

```typescript
// Migration: if petPoolEnabled was true and no explicit sessionAssignment
// was stored, infer auto-spawn.
const rawSessionAssignment = value.sessionAssignment;
const migratedAssignment = rawSessionAssignment === undefined && value.petPoolEnabled === true
  ? "auto-spawn" as const
  : normalizeSessionAssignment(rawSessionAssignment);

// In the return object:
sessionAssignment: migratedAssignment,
petSelectionStrategy: normalizePetSelectionStrategy(value.petSelectionStrategy),
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd apps/desktop && node --test tests/app-state-assignment.test.ts`
Expected: PASS

- [ ] **Step 8: Typecheck**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: no errors related to new fields

- [ ] **Step 9: Register test file**

Add `tests/app-state-assignment.test.ts` to `scripts/run-tests.mjs`.

- [ ] **Step 10: Commit**

```bash
git add src/app-state.ts src/app-state-core.ts tests/app-state-assignment.test.ts scripts/run-tests.mjs
git commit -m "feat: add sessionAssignment and petSelectionStrategy preferences"
```

---

### Task 2: Wire `sessionAssignment` into `WindowPetRegistry`

**Files:**
- Modify: `src/window-pet-registry.ts` (`onSessionIdentified` signature change)
- Modify: `src/local-ipc.ts` (pass `sessionAssignment` to registry)
- Test: `tests/window-pet-registry.test.ts` (existing — add hub-mode cases)

**Interfaces:**
- Consumes: `preferences.sessionAssignment` from Task 1
- Produces: `onSessionIdentified(session, requestedPetId, poolEnabled, sessionAssignment)` — when `sessionAssignment === "hub"`, pool draw and project memory steps are skipped (only explicit requests and existing bindings honored).

- [ ] **Step 1: Write failing tests for hub mode**

Add to existing `tests/window-pet-registry.test.ts`:

```typescript
describe("hub mode", () => {
  it("skips pool draw when sessionAssignment is hub", () => {
    let poolDrawn = false;
    const registry = new WindowPetRegistry({
      callbacks: stubCallbacks(),
      drawPoolPet: () => { poolDrawn = true; return "pool-pet"; },
    });
    registry.onSessionIdentified(makeSession("s1"), undefined, true, "hub");
    assert.strictEqual(poolDrawn, false);
  });

  it("skips project memory when sessionAssignment is hub", () => {
    let memoryQueried = false;
    const registry = new WindowPetRegistry({
      callbacks: stubCallbacks(),
      resolveRememberedPet: () => { memoryQueried = true; return "mem-pet"; },
    });
    registry.onSessionIdentified(makeSession("s1"), undefined, true, "hub");
    assert.strictEqual(memoryQueried, false);
  });

  it("still honors explicit pet requests in hub mode", () => {
    const spawned: string[] = [];
    const registry = new WindowPetRegistry({
      callbacks: { ...stubCallbacks(), spawnPet: (_wk, petId) => spawned.push(petId) },
    });
    registry.onSessionIdentified(makeSession("s1"), "explicit-pet", false, "hub");
    assert.deepStrictEqual(spawned, ["explicit-pet"]);
  });

  it("still joins existing bindings in hub mode", () => {
    const registry = new WindowPetRegistry({ callbacks: stubCallbacks() });
    registry.onSessionIdentified(makeSession("s1"), "pet-a", false, "hub");
    const result = registry.onSessionIdentified(makeSession("s2", { terminalOwnerPid: makeSession("s1").terminalOwnerPid }), undefined, false, "hub");
    assert.strictEqual(result, "pet-a");
  });

  it("runs full chain when sessionAssignment is auto-spawn", () => {
    let poolDrawn = false;
    const registry = new WindowPetRegistry({
      callbacks: stubCallbacks(),
      drawPoolPet: () => { poolDrawn = true; return "pool-pet"; },
    });
    registry.onSessionIdentified(makeSession("s1"), undefined, true, "auto-spawn");
    assert.strictEqual(poolDrawn, true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && node --test tests/window-pet-registry.test.ts`
Expected: FAIL — wrong argument count or behavior

- [ ] **Step 3: Update `onSessionIdentified` in `window-pet-registry.ts`**

Add `sessionAssignment` parameter:

```typescript
onSessionIdentified(
  session: RegistrySessionInfo,
  requestedPetId: string | null | undefined,
  poolEnabled: boolean,
  sessionAssignment: "hub" | "auto-spawn" = "auto-spawn",
): string | null {
```

Gate the project memory and pool draw steps:

```typescript
    if (!this.#userClosedWindows.has(windowKey) && sessionAssignment !== "hub") {
      // Project memory: ...
      const remembered = this.#resolveRememberedPet(session.cwd, new Set(this.boundPetIds()));
      // ...
      if (poolEnabled) {
        // ...pool draw...
      }
    }
```

- [ ] **Step 4: Update `local-ipc.ts` call site**

Where `windowPetRegistry.onSessionIdentified` is called during terminal identity resolution, pass the current `sessionAssignment` preference:

```typescript
const { sessionAssignment } = getAppStateSnapshot().preferences;
windowPetRegistry.onSessionIdentified(sessionInfo, requestedPetId, poolEnabled, sessionAssignment);
```

- [ ] **Step 5: Run tests**

Run: `cd apps/desktop && node --test tests/window-pet-registry.test.ts`
Expected: PASS (all existing + new tests)

- [ ] **Step 6: Typecheck**

Run: `cd apps/desktop && npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add src/window-pet-registry.ts src/local-ipc.ts tests/window-pet-registry.test.ts
git commit -m "feat: gate pool/memory resolution on sessionAssignment setting"
```

---

### Task 3: Add `liveStatus` tracking to sessions

**Files:**
- Create: `src/session-live-status.ts`
- Test: `tests/session-live-status.test.ts` (new)

**Interfaces:**
- Produces: `SessionLiveStatusTracker` class with `update(sessionKey, reaction)`, `get(sessionKey): LiveStatus`, `remove(sessionKey)`. `LiveStatus = "idle" | "thinking" | "editing" | "running" | "testing" | "waiting"`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SessionLiveStatusTracker, type LiveStatus } from "../src/session-live-status.js";

describe("SessionLiveStatusTracker", () => {
  let tracker: SessionLiveStatusTracker;
  let now: number;

  beforeEach(() => {
    now = 1000;
    tracker = new SessionLiveStatusTracker({ now: () => now, decayMs: 30_000 });
  });

  it("returns idle for unknown sessions", () => {
    assert.strictEqual(tracker.get("unknown"), "idle");
  });

  it("maps thinking reaction to thinking status", () => {
    tracker.update("s1", "thinking");
    assert.strictEqual(tracker.get("s1"), "thinking");
  });

  it("maps editing reaction to editing status", () => {
    tracker.update("s1", "editing");
    assert.strictEqual(tracker.get("s1"), "editing");
  });

  it("maps running reaction to running status", () => {
    tracker.update("s1", "running");
    assert.strictEqual(tracker.get("s1"), "running");
  });

  it("maps testing reaction to testing status", () => {
    tracker.update("s1", "testing");
    assert.strictEqual(tracker.get("s1"), "testing");
  });

  it("maps waiting reaction to waiting status", () => {
    tracker.update("s1", "waiting");
    assert.strictEqual(tracker.get("s1"), "waiting");
  });

  it("decays to idle after decayMs", () => {
    tracker.update("s1", "thinking");
    now += 30_001;
    assert.strictEqual(tracker.get("s1"), "idle");
  });

  it("resets decay timer on new update", () => {
    tracker.update("s1", "thinking");
    now += 20_000;
    tracker.update("s1", "editing");
    now += 20_000; // 40s total, but only 20s since last update
    assert.strictEqual(tracker.get("s1"), "editing");
  });

  it("maps success reaction to idle (task done)", () => {
    tracker.update("s1", "success");
    assert.strictEqual(tracker.get("s1"), "idle");
  });

  it("removes session state", () => {
    tracker.update("s1", "thinking");
    tracker.remove("s1");
    assert.strictEqual(tracker.get("s1"), "idle");
  });

  it("returns all active statuses", () => {
    tracker.update("s1", "thinking");
    tracker.update("s2", "editing");
    const all = tracker.all();
    assert.strictEqual(all.get("s1"), "thinking");
    assert.strictEqual(all.get("s2"), "editing");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && node --test tests/session-live-status.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `session-live-status.ts`**

```typescript
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
```

- [ ] **Step 4: Run tests**

Run: `cd apps/desktop && node --test tests/session-live-status.test.ts`
Expected: PASS

- [ ] **Step 5: Register test and commit**

```bash
# Add to scripts/run-tests.mjs
git add src/session-live-status.ts tests/session-live-status.test.ts scripts/run-tests.mjs
git commit -m "feat: add SessionLiveStatusTracker for per-session activity status"
```

---

### Task 4: Propagate hook event name through IPC and wire into notification rows

**Files:**
- Modify: `packages/claude/src/hooks.ts` (send `hookEventName` alongside reaction)
- Modify: `src/local-ipc-protocol.ts` (add optional `hookEventName` field to `pet.react` params)
- Modify: `src/local-ipc.ts` (import SessionLiveStatusTracker, create notification rows from hook events, instantiate tracker)
- Test: existing `pet.react` / `pet.say` tests — add cases for hook-event-specific kinds

**Interfaces:**
- Consumes: `SessionLiveStatusTracker` from Task 3, `NotificationStore.record()` from existing code
- Produces: `PermissionRequest` → notification row with kind `"permission"`, `Stop` → kind `"complete"`, `StopFailure` → kind `"error"`. Live status updated on every `pet.react`.

**Critical design note:** We cannot infer `PermissionRequest` from the `waiting` reaction because a manual `openpets_react("waiting")` MCP call would also arrive as `waiting`. The hook event name must be propagated explicitly through the IPC wire.

- [ ] **Step 1: Add `hookEventName` to IPC protocol**

In `src/local-ipc-protocol.ts`, add an optional field to the `pet.react` parameters:

```typescript
// In the pet.react params validation, after reaction validation:
readonly hookEventName?: string; // "PermissionRequest" | "Stop" | "StopFailure" | "PreToolUse" | etc.
```

Validate as optional string, max 64 chars, no special characters.

- [ ] **Step 2: Send `hookEventName` from the Claude hook process**

In `packages/claude/src/hooks.ts`, the `handleClaudeHookPayload` function calls `client.react(decision.reaction, opts)`. Update to include `hookEventName`:

```typescript
if (decision.speechCategory && shouldSpeak) {
  const message = validateHookSpeech(pickHookSpeech(decision.speechCategory, options.random));
  await client.say(message, { reaction: decision.reaction, leaseId: lease?.leaseId, clientAncestorPids, hookEventName: decision.eventName });
} else {
  await client.react(decision.reaction, { leaseId: lease?.leaseId, clientAncestorPids, hookEventName: decision.eventName });
}
```

This requires adding `hookEventName` to `@open-pets/client`'s react/say options type. The field is optional — old clients that don't send it are fine (no hook-specific notification rows, just animations).

- [ ] **Step 3: Map hook event name to notification row kind in `local-ipc.ts`**

```typescript
const hookEventToNotificationKind: Record<string, string> = {
  PermissionRequest: "permission",
  Stop: "complete",
  StopFailure: "error",
};

function notificationKindForHookEvent(hookEventName: string | undefined, fallbackReaction: string): { kind: string; createRow: boolean } {
  if (hookEventName && hookEventName in hookEventToNotificationKind) {
    return { kind: hookEventToNotificationKind[hookEventName]!, createRow: true };
  }
  return { kind: fallbackReaction, createRow: false };
}
```

Only the three mapped hook events create notification rows. Manual MCP `pet.react("waiting")` with no `hookEventName` still triggers the animation but creates no row.

- [ ] **Step 4: Instantiate the live status tracker**

```typescript
import { SessionLiveStatusTracker } from "./session-live-status.js";

const sessionLiveStatus = new SessionLiveStatusTracker();
```

- [ ] **Step 5: Update `pet.react` handler to feed live status + create rows**

In the `pet.react` handler:

```typescript
const sessionKey = rawLease?.clientPid && rawLease.sessionNonce
  ? `${rawLease.clientPid}:${rawLease.sessionNonce}` : undefined;
if (sessionKey) sessionLiveStatus.update(sessionKey, reaction);

const hookEventName = params.hookEventName;
const { kind, createRow } = notificationKindForHookEvent(hookEventName, reaction);
if (createRow) {
  const message = hookNotificationMessage(kind, t);
  recordSessionNotification(rawLease, kind, message);
}
```

- [ ] **Step 6: Add hook notification message helper**

```typescript
function hookNotificationMessage(kind: string, t: TranslateFn): string {
  if (kind === "permission") return t("pet.notify.needsApproval");
  if (kind === "complete") return t("pet.notify.taskComplete");
  if (kind === "error") return t("pet.notify.taskFailed");
  return kind;
}
```

- [ ] **Step 7: Add i18n keys**

Add to `src/i18n/en.ts` (and equivalent in all 7 locales):

```typescript
"pet.notify.needsApproval": "Needs approval",
"pet.notify.taskComplete": "Task complete",
"pet.notify.taskFailed": "Task failed",
```

- [ ] **Step 8: Clean up live status on session gone**

In the `lease.release` and session-gone paths, call `sessionLiveStatus.remove(sessionKey)`.

- [ ] **Step 9: Expose live status for notification view**

```typescript
export function getSessionLiveStatuses(): ReadonlyMap<string, import("./session-live-status.js").LiveStatus> {
  return sessionLiveStatus.all();
}
```

- [ ] **Step 10: Typecheck and test**

Run: `cd apps/desktop && npx tsc --noEmit`
Run: `cd packages/claude && npx tsc --noEmit`
Run existing tests that cover `pet.react` / `pet.say`.

- [ ] **Step 11: Commit**

```bash
git add packages/claude/src/hooks.ts src/local-ipc.ts src/local-ipc-protocol.ts src/i18n/
git commit -m "feat: propagate hook event names and wire into notification rows"
```

---

### Task 5: Enhance notification-view with window grouping and live status

**Files:**
- Modify: `src/notification-view.ts` (add grouped view builder, status dot rendering)
- Test: `tests/notification-view.test.ts` (existing — add grouping tests)

**Interfaces:**
- Consumes: `NotificationEntry` (existing), `LiveStatus` from Task 3, `getSessionLiveStatuses()` from Task 4
- Produces: `buildGroupedNotificationsView()` returning `GroupedNotificationsView` with window groups, session rows with status dots

- [ ] **Step 1: Define new view types**

Add to `notification-view.ts`:

```typescript
import type { LiveStatus } from "./session-live-status.js";

export interface GroupedSessionRow {
  readonly sessionKey: string;
  readonly label: string;
  readonly message: string;
  readonly ageText: string;
  readonly state: "unresolved" | "resolved";
  readonly liveStatus: LiveStatus;
  readonly error?: boolean;
}

export interface WindowGroup {
  readonly windowKey: string;
  readonly windowLabel: string;
  readonly sessionCount: number;
  readonly rows: readonly GroupedSessionRow[];
}

export interface GroupedNotificationsView {
  readonly open: boolean;
  readonly unresolvedCount: number;
  readonly groups: readonly WindowGroup[];
}
```

- [ ] **Step 2: Write failing tests for grouped view**

```typescript
describe("buildGroupedNotificationsView", () => {
  const now = 1000;
  const t = (key: string) => key;

  it("groups entries by windowKey", () => {
    const entries: NotificationEntry[] = [
      { sessionKey: "s1", windowKey: "w:1", kind: "permission", message: "Needs approval", label: "proj-a", updatedAt: 900, firstUnresolvedAt: 900, state: "unresolved" },
      { sessionKey: "s2", windowKey: "w:1", kind: "complete", message: "Task complete", label: "proj-b", updatedAt: 800, firstUnresolvedAt: 800, state: "resolved" },
      { sessionKey: "s3", windowKey: "w:2", kind: "error", message: "Task failed", label: "proj-c", updatedAt: 700, firstUnresolvedAt: 700, state: "unresolved" },
    ];
    const statuses = new Map([["s1", "thinking" as const], ["s3", "waiting" as const]]);
    const view = buildGroupedNotificationsView(entries, true, now, t, statuses);
    assert.strictEqual(view.groups.length, 2);
    assert.strictEqual(view.groups[0]!.rows.length, 2);
    assert.strictEqual(view.groups[1]!.rows.length, 1);
    assert.strictEqual(view.groups[0]!.rows[0]!.liveStatus, "thinking");
    assert.strictEqual(view.groups[1]!.rows[0]!.liveStatus, "waiting");
  });

  it("uses idle for sessions with no live status", () => {
    const entries: NotificationEntry[] = [
      { sessionKey: "s1", windowKey: "w:1", kind: "complete", message: "Done", label: "proj", updatedAt: 900, firstUnresolvedAt: 900, state: "resolved" },
    ];
    const view = buildGroupedNotificationsView(entries, true, now, t, new Map());
    assert.strictEqual(view.groups[0]!.rows[0]!.liveStatus, "idle");
  });

  it("counts unresolved across all groups", () => {
    const entries: NotificationEntry[] = [
      { sessionKey: "s1", windowKey: "w:1", kind: "permission", message: "A", label: "a", updatedAt: 900, firstUnresolvedAt: 900, state: "unresolved" },
      { sessionKey: "s2", windowKey: "w:2", kind: "error", message: "B", label: "b", updatedAt: 800, firstUnresolvedAt: 800, state: "unresolved" },
    ];
    const view = buildGroupedNotificationsView(entries, true, now, t, new Map());
    assert.strictEqual(view.unresolvedCount, 2);
  });
});
```

- [ ] **Step 3: Implement `buildGroupedNotificationsView`**

```typescript
const MAX_GROUPED_ROWS = 50;

export function buildGroupedNotificationsView(
  entries: readonly NotificationEntry[],
  open: boolean,
  now: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
  liveStatuses: ReadonlyMap<string, LiveStatus>,
  errorSessionKeys?: ReadonlySet<string>,
): GroupedNotificationsView {
  let unresolvedCount = 0;
  const groupMap = new Map<string, { windowLabel: string; rows: GroupedSessionRow[] }>();
  let totalRows = 0;

  for (const entry of entries) {
    if (entry.state === "dismissed") continue;
    if (entry.state === "unresolved") unresolvedCount += 1;
    if (totalRows >= MAX_GROUPED_ROWS) continue;

    const wk = entry.windowKey ?? "default";
    let group = groupMap.get(wk);
    if (!group) {
      group = { windowLabel: wk, rows: [] };
      groupMap.set(wk, group);
    }
    group.rows.push({
      sessionKey: entry.sessionKey,
      label: entry.label,
      message: entry.message,
      ageText: ageText(entry.updatedAt, now, t),
      state: entry.state as "unresolved" | "resolved",
      liveStatus: liveStatuses.get(entry.sessionKey) ?? "idle",
      error: errorSessionKeys?.has(entry.sessionKey) || undefined,
    });
    totalRows += 1;
  }

  const groups: WindowGroup[] = [...groupMap.entries()].map(([windowKey, g]) => ({
    windowKey,
    windowLabel: g.windowLabel,
    sessionCount: g.rows.length,
    rows: g.rows,
  }));

  return { open, unresolvedCount, groups };
}
```

- [ ] **Step 4: Add grouped flyout HTML renderer**

```typescript
export function createGroupedNotificationsMarkup(
  view: GroupedNotificationsView,
  t: (key: string, vars?: Record<string, string | number>) => string,
): { badge: string; flyout: string } {
  let badge = "";
  if (view.unresolvedCount > 0 || view.open) {
    const countLabel = view.unresolvedCount > 0 ? String(view.unresolvedCount) : "0";
    const ariaLabel = escapeHtml(t("pet.notify.badgeLabel", { count: view.unresolvedCount }));
    badge = `<div class="notify-badge" data-count="${escapeHtml(countLabel)}" role="status" aria-label="${ariaLabel}">${escapeHtml(countLabel)}</div>`;
  }

  let flyout = "";
  if (view.open) {
    if (view.groups.length === 0) {
      flyout = `<div class="notify-flyout"><div class="notify-empty">${escapeHtml(t("pet.notify.empty"))}</div></div>`;
    } else {
      const groupsHtml = view.groups.map((group) => {
        const headerHtml = `<div class="notify-group-header" data-window-key="${escapeHtml(group.windowKey)}"><span class="notify-group-label">${escapeHtml(group.windowLabel)}</span><span class="notify-group-count">${group.sessionCount}</span></div>`;
        const rowsHtml = group.rows.map((row) => {
          const stateClass = row.state === "unresolved" ? " is-unresolved" : "";
          const errorClass = row.error ? " is-error" : "";
          const statusClass = ` status-${row.liveStatus}`;
          return `<div class="notify-row${stateClass}${errorClass}" data-notify-row data-session-key="${escapeHtml(row.sessionKey)}"><span class="notify-status-dot${statusClass}"></span><span class="notify-label">${escapeHtml(row.label)}</span><span class="notify-message">${escapeHtml(row.message)}</span><span class="notify-age">${escapeHtml(row.ageText)}</span></div>`;
        }).join("");
        return headerHtml + rowsHtml;
      }).join("");
      flyout = `<div class="notify-flyout notify-flyout-grouped">${groupsHtml}</div>`;
    }
  }

  return { badge, flyout };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `cd apps/desktop && node --test tests/notification-view.test.ts`
Run: `cd apps/desktop && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/notification-view.ts tests/notification-view.test.ts
git commit -m "feat: add window-grouped notification flyout with live status dots"
```

---

### Task 6: Change focus target to most-recently-active

**Files:**
- Modify: `src/window-pet-registry.ts` (`#focusTarget` method)
- Test: `tests/window-pet-registry.test.ts` (update existing focus-target tests)

**Interfaces:**
- Consumes: `TrackedSession.lastActivityAt` (existing)
- Produces: `focusTargetForPet` and `focusTargetForDefault` always return the most recently active session, not oldest-unresolved.

- [ ] **Step 1: Write failing test**

```typescript
describe("focusTarget — most recently active", () => {
  it("returns most recently active session even when unresolved exist", () => {
    const registry = new WindowPetRegistry({ callbacks: stubCallbacks() });
    // Set up two sessions: s1 is older with unresolved notification, s2 is newer
    registry.onSessionIdentified(makeSession("s1"), undefined, false, "auto-spawn");
    registry.onSessionIdentified(makeSession("s2"), undefined, false, "auto-spawn");
    // Touch s2 activity more recently
    registry.touchSessionActivity("s2");
    // Record unresolved on s1
    registry.defaultStore.record({ sessionKey: "s1", kind: "permission", message: "test", label: "proj" });
    const target = registry.focusTargetForDefault();
    // Should be s2 (most recent), NOT s1 (oldest unresolved)
    assert.strictEqual(target?.sessionKey, "s2");
  });
});
```

- [ ] **Step 2: Update `#focusTarget` in `window-pet-registry.ts`**

Replace the method body — remove the oldest-unresolved-first logic:

```typescript
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
```

- [ ] **Step 3: Run tests, fix any that expected old behavior**

Run: `cd apps/desktop && node --test tests/window-pet-registry.test.ts`
Update any existing tests that asserted oldest-unresolved-first behavior.

- [ ] **Step 4: Commit**

```bash
git add src/window-pet-registry.ts tests/window-pet-registry.test.ts
git commit -m "feat: change focus target to most-recently-active session"
```

---

### Task 7: Add speech bubble queue with session labels

**Files:**
- Create: `src/speech-bubble-queue.ts`
- Test: `tests/speech-bubble-queue.test.ts` (new)

**Interfaces:**
- Produces: `SpeechBubbleQueue` class with `enqueue(sessionKey, label, message): BubbleContent | null`, `dismiss(sessionKey): BubbleContent | null`, `current(): BubbleContent | null`. `BubbleContent = { sessionKey, label, message }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SpeechBubbleQueue } from "../src/speech-bubble-queue.js";

describe("SpeechBubbleQueue", () => {
  let queue: SpeechBubbleQueue;

  beforeEach(() => {
    queue = new SpeechBubbleQueue({ maxDepth: 5 });
  });

  it("returns first enqueued bubble as current", () => {
    const result = queue.enqueue("s1", "proj-a", "Hello!");
    assert.deepStrictEqual(result, { sessionKey: "s1", label: "proj-a", message: "Hello!" });
    assert.deepStrictEqual(queue.current(), result);
  });

  it("replaces current bubble from same session immediately", () => {
    queue.enqueue("s1", "proj-a", "First");
    const result = queue.enqueue("s1", "proj-a", "Second");
    assert.strictEqual(result!.message, "Second");
    assert.strictEqual(queue.current()!.message, "Second");
  });

  it("queues bubbles from different sessions", () => {
    queue.enqueue("s1", "proj-a", "First");
    const queued = queue.enqueue("s2", "proj-b", "Second");
    assert.strictEqual(queued, null); // not shown yet, queued
    assert.strictEqual(queue.current()!.sessionKey, "s1"); // still showing first
  });

  it("advances to next bubble on dismiss", () => {
    queue.enqueue("s1", "proj-a", "First");
    queue.enqueue("s2", "proj-b", "Second");
    const next = queue.dismiss("s1");
    assert.strictEqual(next!.sessionKey, "s2");
    assert.strictEqual(queue.current()!.sessionKey, "s2");
  });

  it("drops oldest queued when exceeding maxDepth", () => {
    queue.enqueue("s1", "a", "1");
    queue.enqueue("s2", "b", "2");
    queue.enqueue("s3", "c", "3");
    queue.enqueue("s4", "d", "4");
    queue.enqueue("s5", "e", "5");
    queue.enqueue("s6", "f", "6"); // exceeds 5 — drops s2 (oldest queued, not current s1)
    queue.dismiss("s1");
    // s2 was dropped, next should be s3
    assert.strictEqual(queue.current()!.sessionKey, "s3");
  });

  it("returns null current when empty", () => {
    assert.strictEqual(queue.current(), null);
  });

  it("returns null on dismiss when empty", () => {
    assert.strictEqual(queue.dismiss("s1"), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && node --test tests/speech-bubble-queue.test.ts`

- [ ] **Step 3: Implement `speech-bubble-queue.ts`**

```typescript
export interface BubbleContent {
  readonly sessionKey: string;
  readonly label: string;
  readonly message: string;
}

export class SpeechBubbleQueue {
  readonly #maxDepth: number;
  #current: BubbleContent | null = null;
  readonly #queue: BubbleContent[] = [];

  constructor(options: { maxDepth?: number } = {}) {
    this.#maxDepth = options.maxDepth ?? 5;
  }

  enqueue(sessionKey: string, label: string, message: string): BubbleContent | null {
    const bubble: BubbleContent = { sessionKey, label, message };

    if (this.#current === null) {
      this.#current = bubble;
      return bubble;
    }

    if (this.#current.sessionKey === sessionKey) {
      this.#current = bubble;
      return bubble;
    }

    const queueIdx = this.#queue.findIndex((b) => b.sessionKey === sessionKey);
    if (queueIdx !== -1) {
      this.#queue[queueIdx] = bubble;
    } else {
      this.#queue.push(bubble);
      if (this.#queue.length > this.#maxDepth - 1) {
        this.#queue.shift();
      }
    }
    return null;
  }

  dismiss(sessionKey: string): BubbleContent | null {
    if (this.#current?.sessionKey === sessionKey) {
      this.#current = this.#queue.shift() ?? null;
      return this.#current;
    }
    const idx = this.#queue.findIndex((b) => b.sessionKey === sessionKey);
    if (idx !== -1) this.#queue.splice(idx, 1);
    return null;
  }

  current(): BubbleContent | null {
    return this.#current;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/desktop && node --test tests/speech-bubble-queue.test.ts`
Expected: PASS

- [ ] **Step 5: Register test and commit**

```bash
git add src/speech-bubble-queue.ts tests/speech-bubble-queue.test.ts scripts/run-tests.mjs
git commit -m "feat: add SpeechBubbleQueue for multi-session bubble management"
```

---

### Task 8: Integrate speech bubble queue into pet window

**Files:**
- Modify: `src/local-ipc.ts` (instantiate SpeechBubbleQueue, use in pet.say handler)
- Modify: `src/pet-window.ts` or `src/agent-pet-controller.ts` / `src/default-pet-controller.ts` (consume queued bubbles with session labels)

**Interfaces:**
- Consumes: `SpeechBubbleQueue` from Task 7, existing `applyAgentPetSay` / `applyExternalPetSay` functions

This task wires the queue into the existing speech bubble display path. The key change: in hub mode, bubbles flowing through the default pet are prefixed with the session label.

- [ ] **Step 1: Instantiate queue in `local-ipc.ts`**

```typescript
import { SpeechBubbleQueue } from "./speech-bubble-queue.js";

const speechBubbleQueue = new SpeechBubbleQueue({ maxDepth: 5 });
```

- [ ] **Step 2: Update `pet.say` handler to use queue**

When a `pet.say` lands on the default pet and `sessionAssignment` is `"hub"`, route through the queue:

```typescript
// In the pet.say handler, for default-pet-targeted messages:
const sessionKey = rawLease?.clientPid && rawLease.sessionNonce
  ? `${rawLease.clientPid}:${rawLease.sessionNonce}` : undefined;
const label = sessionLabelFromCwd(rawLease?.cwd, rawLease?.terminalAppName ?? "session");

if (sessionKey) {
  const shown = speechBubbleQueue.enqueue(sessionKey, label, message);
  if (shown) {
    const labeledMessage = `${shown.label}: ${shown.message}`;
    applyExternalPetSay(labeledMessage, reaction);
  }
} else {
  applyExternalPetSay(message, reaction);
}
```

- [ ] **Step 3: Wire dismiss on bubble timeout**

When the existing bubble dismiss timer fires, call `speechBubbleQueue.dismiss(sessionKey)` and show the next bubble if one exists.

This requires hooking into the existing bubble dismiss callback. Check `pet-window.ts` for `onBubbleDismissed` and wire through:

```typescript
// In the dismiss callback:
if (sessionKey) {
  const next = speechBubbleQueue.dismiss(sessionKey);
  if (next) {
    const labeledMessage = `${next.label}: ${next.message}`;
    applyExternalPetSay(labeledMessage);
  }
}
```

- [ ] **Step 4: Route urgent hook speech through the queue**

In the `pet.react` handler, when a hook event creates an urgent notification row (kind `"permission"` or `"error"`), also enqueue a speech bubble:

```typescript
if (createRow && (kind === "permission" || kind === "error") && sessionKey) {
  const label = sessionLabelFromCwd(rawLease?.cwd, rawLease?.terminalAppName ?? "session");
  const message = hookNotificationMessage(kind, t);
  const shown = speechBubbleQueue.enqueue(sessionKey, label, message);
  if (shown) {
    applyExternalPetSay(`${shown.label}: ${shown.message}`, reaction);
  }
}
```

- [ ] **Step 5: Typecheck and manual review**

Run: `cd apps/desktop && npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/local-ipc.ts src/pet-window.ts
git commit -m "feat: integrate speech bubble queue with session labels in hub mode"
```

---

### Task 9: Add CSS for grouped flyout and status dots

**Files:**
- Modify: `src/renderer/pet-notifications.css` (or equivalent stylesheet in the renderer)

**Interfaces:**
- Consumes: HTML class names from Task 5 markup (`notify-group-header`, `notify-status-dot`, `status-*`)

- [ ] **Step 1: Find the existing notification styles**

Grep for `.notify-row` or `.notify-badge` in the renderer CSS files to find where styles live.

- [ ] **Step 2: Add group header styles**

```css
.notify-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: rgba(16, 33, 73, 0.6);
  cursor: pointer;
  border-bottom: 1px solid rgba(126, 161, 210, 0.2);
}

.notify-group-header:hover {
  background: rgba(23, 109, 242, 0.06);
}

.notify-group-count {
  font-size: 10px;
  background: rgba(23, 109, 242, 0.12);
  color: #176df2;
  border-radius: 8px;
  padding: 1px 5px;
  font-weight: 700;
}
```

- [ ] **Step 3: Add status dot styles**

```css
.notify-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #94a3b8; /* idle: gray */
}

.notify-status-dot.status-thinking { background: #3b82f6; }
.notify-status-dot.status-editing { background: #f59e0b; }
.notify-status-dot.status-running { background: #10b981; }
.notify-status-dot.status-testing { background: #8b5cf6; }
.notify-status-dot.status-waiting {
  background: #ef4444;
  animation: pulse-dot 1.5s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
```

- [ ] **Step 4: Add grouped flyout layout**

```css
.notify-flyout-grouped {
  max-height: 400px;
  overflow-y: auto;
}

.notify-flyout-grouped .notify-row {
  padding-left: 16px; /* indent rows under group headers */
}
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/
git commit -m "feat: add CSS for grouped flyout layout and status dots"
```

---

### Task 10: Integration — switch controllers to use grouped view

**Files:**
- Modify: `src/default-pet-controller.ts` (use `buildGroupedNotificationsView` + `createGroupedNotificationsMarkup`)
- Modify: `src/agent-pet-controller.ts` (same, for agent pets)
- Modify: `src/pet-window.ts` (handle `data-window-key` click on group headers for focus)

**Interfaces:**
- Consumes: All prior tasks
- Produces: Working grouped flyout rendered in pet windows

- [ ] **Step 1: Update default pet controller to use grouped view**

In `src/default-pet-controller.ts`, find `getDefaultNotificationsView()` (around line 190). Replace its body:

```typescript
function getDefaultNotificationsView(open: boolean): GroupedNotificationsView {
  const entries = defaultNotificationStoreAccessor().rows();
  const liveStatuses = getSessionLiveStatuses();
  return buildGroupedNotificationsView(entries, open, Date.now(), t, liveStatuses);
}
```

Update `refreshDefaultPetContent()` to use `createGroupedNotificationsMarkup` instead of `createNotificationsMarkup`:

```typescript
const notifView = getDefaultNotificationsView(notificationsOpen);
const { badge, flyout } = createGroupedNotificationsMarkup(notifView, t);
```

- [ ] **Step 2: Add group header click handler in `pet-window.ts`**

In the renderer IPC for notification clicks (the `pet:notificationFocus` handler), add a handler for `pet:groupHeaderFocus`:

```typescript
// In the pet window's onPetEvent handler:
if (name === "pet:groupHeaderFocus") {
  const windowKey = data?.windowKey;
  if (windowKey) {
    const target = windowPetRegistry.focusTargetForWindowKey(windowKey);
    if (target?.terminalOwnerPid) {
      focusTerminalWindow(target.terminalOwnerPid);
    }
  }
}
```

In the renderer script, add a click listener for `.notify-group-header` elements that emits `pet:groupHeaderFocus` with the `data-window-key` attribute.

- [ ] **Step 3: Keep ungrouped view for agent pets**

Agent pets always track a single window. In `src/agent-pet-controller.ts`, keep using `buildNotificationsView` + `createNotificationsMarkup` — the grouped view adds no value for single-window pets.

- [ ] **Step 4: Typecheck and manual smoke test**

Run: `cd apps/desktop && npx tsc --noEmit`

If possible: `pnpm dev:desktop` to see the flyout render.

- [ ] **Step 5: Commit**

```bash
git add src/default-pet-controller.ts src/agent-pet-controller.ts src/pet-window.ts
git commit -m "feat: switch pet controllers to grouped notification flyout"
```

---

### Task 11: Add i18n keys for all 7 locales

**Files:**
- Modify: All locale files in `src/i18n/` (en, es, ja, ko, pt-BR, zh-Hans, zh-Hant)

**Interfaces:**
- Consumes: i18n keys introduced in Tasks 4 and 5

- [ ] **Step 1: Audit all new i18n keys**

Grep for all `t("pet.notify.` calls to find keys that need translations.

Expected keys:
- `pet.notify.needsApproval`
- `pet.notify.taskComplete`
- `pet.notify.taskFailed`
- Any group header labels if parameterized

- [ ] **Step 2: Add translations to all locales**

English is the source. For other locales, use the existing pattern in the codebase (check if machine translations have been used before with a "needs review" flag).

- [ ] **Step 3: Commit**

```bash
git add src/i18n/
git commit -m "feat: add i18n keys for hub mode notifications across all locales"
```

---

### Task 12: Add random pet selection strategy

**Files:**
- Modify: `src/pet-pool.ts` (add random draw function)
- Modify: `src/local-ipc.ts` (pass `petSelectionStrategy` to the `drawPoolPet` callback)
- Test: `tests/pet-pool.test.ts` (add random draw test)

**Interfaces:**
- Consumes: `preferences.petSelectionStrategy` from Task 1
- Produces: When strategy is `"random"`, `drawPoolPet` picks randomly from eligible unoccupied pets instead of walking `petPoolOrder` in order.

The current `resolvePoolAssignment` already walks the pool in order (this is the `"ordered"` behavior). For `"random"`, we need a function that picks randomly from eligible pets not in `occupiedPetIds`.

- [ ] **Step 1: Add `resolveRandomPoolAssignment` to `pet-pool.ts`**

```typescript
export function resolveRandomPoolAssignment(
  input: PoolAssignmentInput,
  random: () => number = Math.random,
): PoolAssignmentResult | null {
  const { orderedPool, eligiblePetIds, countActiveExplicit } = input;
  if (!orderedPool || orderedPool.length === 0) return null;
  if (eligiblePetIds.length === 0) return null;

  const eligibleSet = new Set(eligiblePetIds);
  const free = orderedPool.filter((id) => eligibleSet.has(id) && countActiveExplicit(id) === 0);
  if (free.length === 0) return null;
  return { petId: free[Math.floor(random() * free.length)]! };
}
```

- [ ] **Step 2: Update `drawPoolPet` callback in `local-ipc.ts`**

Pass the current `petSelectionStrategy` preference and use it to choose between `resolvePoolAssignment` (ordered) and `resolveRandomPoolAssignment` (random).

- [ ] **Step 3: Write tests for random draw**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRandomPoolAssignment } from "../src/pet-pool.js";

describe("resolveRandomPoolAssignment", () => {
  it("picks from eligible pets not in use", () => {
    const result = resolveRandomPoolAssignment({
      orderedPool: ["a", "b", "c"],
      eligiblePetIds: ["a", "b", "c"],
      countActiveExplicit: (id) => id === "a" ? 1 : 0,
    }, () => 0);
    assert.ok(result);
    assert.notStrictEqual(result.petId, "a");
  });

  it("returns null when no eligible pets are free", () => {
    const result = resolveRandomPoolAssignment({
      orderedPool: ["a"],
      eligiblePetIds: ["a"],
      countActiveExplicit: () => 1,
    });
    assert.strictEqual(result, null);
  });

  it("returns null for empty pool", () => {
    const result = resolveRandomPoolAssignment({
      orderedPool: [],
      eligiblePetIds: ["a"],
      countActiveExplicit: () => 0,
    });
    assert.strictEqual(result, null);
  });

  it("uses provided random function", () => {
    const result = resolveRandomPoolAssignment({
      orderedPool: ["a", "b", "c"],
      eligiblePetIds: ["a", "b", "c"],
      countActiveExplicit: () => 0,
    }, () => 0.999);
    assert.strictEqual(result!.petId, "c");
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add src/pet-pool.ts src/local-ipc.ts tests/pet-pool.test.ts
git commit -m "feat: add random pet selection strategy for auto-spawn pool"
```

---

### Task 13: Store terminal app name on notification entries for group labels

**Files:**
- Modify: `src/notification-store.ts` (add optional `terminalAppName` to `NotificationEntry`)
- Modify: `src/local-ipc.ts` (`recordSessionNotification` passes terminal app name)
- Modify: `src/notification-view.ts` (use terminal app name for group header labels)
- Modify: `src/window-pet-registry.ts` (`RegistrySessionInfo` may already have this — check)

**Interfaces:**
- Consumes: `terminalAppName` from lease data (already tracked in `PetLease`)
- Produces: Group headers labeled "Windows Terminal (2 sessions)" instead of raw window keys

- [ ] **Step 1: Add `terminalAppName` to `NotificationEntry`**

```typescript
export interface NotificationEntry {
  // ... existing fields ...
  readonly terminalAppName?: string;
}
```

- [ ] **Step 2: Pass it through in `recordSessionNotification`**

```typescript
windowPetRegistry.storeForSession(sessionKey).record({
  sessionKey, windowKey, kind: resolvedKind, message, label,
  terminalAppName: rawLease?.terminalAppName,
});
```

- [ ] **Step 3: Use it in `buildGroupedNotificationsView`**

The group `windowLabel` should be the terminal app name from the first entry in the group, not the raw window key.

- [ ] **Step 4: Commit**

```bash
git add src/notification-store.ts src/notification-view.ts src/local-ipc.ts
git commit -m "feat: use terminal app name for notification group labels"
```

---

### Task 14: End-to-end typecheck and test pass

**Files:** None (verification only)

- [ ] **Step 1: Full typecheck**

Run: `cd apps/desktop && npx tsc --noEmit`
Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.renderer.json` (if renderer has separate config)

- [ ] **Step 2: Full test suite**

Run: `cd apps/desktop && node scripts/run-tests.mjs`

- [ ] **Step 3: Fix any failures**

Address typecheck errors or test failures from integration issues.

- [ ] **Step 4: Final commit if fixes were needed**

```bash
git add -A
git commit -m "fix: resolve integration issues from hub mode implementation"
```

---

## Task Summary

| Task | Description | Dependencies |
|------|-------------|-------------|
| 1 | Add `sessionAssignment` + `petSelectionStrategy` to app state | None |
| 2 | Wire `sessionAssignment` into `WindowPetRegistry` | 1 |
| 3 | Add `SessionLiveStatusTracker` | None |
| 4 | Propagate hook event name through IPC, wire into rows + live status | 3 |
| 5 | Enhanced `notification-view` with grouping + status dots | 3 |
| 6 | Change focus target to most-recently-active | None |
| 7 | Add `SpeechBubbleQueue` | None |
| 8 | Integrate speech bubble queue into pet window | 7, 4 |
| 9 | CSS for grouped flyout and status dots | 5 |
| 10 | Switch controllers to use grouped view | 4, 5, 9 |
| 11 | i18n keys for all 7 locales | 4, 5 |
| 12 | Add random pet selection strategy | 1 |
| 13 | Store terminal app name for group labels | 5 |
| 14 | End-to-end typecheck and test pass | All |

**Note:** The spec lists `liveStatus` as a stored field on notification row content. The plan computes it at render time from `SessionLiveStatusTracker` instead — live status is transient and shouldn't be persisted. This is a deliberate deviation.

**Parallelizable groups:**
- Tier 1 (parallel): Tasks 1, 3, 6, 7 — no dependencies
- Tier 2 (parallel, after tier 1): Tasks 2, 4, 5, 12
- Tier 3 (parallel, after tier 2): Tasks 8, 9, 11, 13
- Tier 4 (sequential): Tasks 10, 14

**Execution model:**
- Sonnet agents for implementation (Tasks 1–13)
- Haiku agents for file exploration mid-task
- Fable agent for review after integration (Task 14)
