# Hub Mode Phase 2 — Summoning & Sessions Tab Implementation Plan

> **For agentic workers:** Use sonnet for implementation, haiku for exploration, fable for review/advice. Do NOT use superpowers:subagent-driven-development.

**Goal:** Add a "Summon pet" right-click submenu to the default pet and enhance the Sessions tab with live status dots.

**Architecture:** The existing `WindowPetRegistry.assignPetToWindow()` and the Control Center `assignWindowPet` API already handle the bind/unbind/steal mechanics end-to-end. A new `defaultCoverageWindows()` method on the registry feeds the right-click submenu with the list of unbound windows. The Sessions tab already groups by window and has a pet picker — it just needs `liveStatus` in the snapshot.

**Tech Stack:** TypeScript, Electron (main process + renderer), React (Control Center renderer). No new dependencies.

## Global Constraints

- All paths are relative to `apps/desktop/` unless stated otherwise.
- Follow existing patterns: pure modules for testable logic; side effects via callbacks.
- i18n keys must be added to `src/i18n/locales/en.ts` (other locales fall back to English).
- Tests run via `node --test`. New test files must be registered in `scripts/run-tests.mjs`.
- `npx tsc --noEmit` must pass after each task.
- Commit format: conventional commits (`feat:`, `fix:`).
- **Shared checkout warning:** Multiple agents may edit concurrently. Commit ONLY the files you modified using explicit `git add <file1> <file2>`. Never use `git add -A` or `git add .`.

---

### Task 1: Add `defaultCoverageWindows()` to WindowPetRegistry

**Files:**
- Modify: `src/window-pet-registry.ts`
- Test: `tests/window-pet-registry.test.ts` (existing — add cases)

**Interfaces:**
- Produces: `defaultCoverageWindows(): ReadonlyArray<{ windowKey: WindowKey; terminalAppName: string; sessionCount: number }>`

- [ ] **Step 1: Write the failing test**

Add to the end of `tests/window-pet-registry.test.ts` (flat assert style matching the file):

```typescript
// defaultCoverageWindows: returns windows under default coverage with metadata.
{
  const { cb } = makeRecorder();
  const reg = new WindowPetRegistry({ callbacks: cb, isPidAlive: () => true });
  const s1 = { sessionKey: "100:a", leaseId: "La", terminalOwnerPid: 100, terminalWindowId: 10, terminalAppName: "Windows Terminal", label: "proj-a" };
  const s2 = { sessionKey: "101:b", leaseId: "Lb", terminalOwnerPid: 101, terminalWindowId: 10, terminalAppName: "Windows Terminal", label: "proj-b" };
  const s3 = { sessionKey: "200:c", leaseId: "Lc", terminalOwnerPid: 200, terminalWindowId: 20, terminalAppName: "VS Code", label: "proj-c" };
  reg.onSessionIdentified(s1, undefined, false, "hub");
  reg.onSessionIdentified(s2, undefined, false, "hub");
  reg.onSessionIdentified(s3, undefined, false, "hub");
  const windows = reg.defaultCoverageWindows();
  assert.strictEqual(windows.length, 2, "two windows under default coverage");
  const wt = windows.find((w) => w.terminalAppName === "Windows Terminal");
  assert.ok(wt, "Windows Terminal group found");
  assert.strictEqual(wt!.sessionCount, 2);
  const vs = windows.find((w) => w.terminalAppName === "VS Code");
  assert.ok(vs, "VS Code group found");
  assert.strictEqual(vs!.sessionCount, 1);
  // Bind s3's window to a pet — it should no longer appear in default coverage.
  reg.assignPetToWindow("w:20", "owl");
  const afterBind = reg.defaultCoverageWindows();
  assert.strictEqual(afterBind.length, 1, "bound window removed from default coverage");
  assert.strictEqual(afterBind[0]!.terminalAppName, "Windows Terminal");
}

console.log("Window pet registry passed.");
```

Remove the existing final `console.log("Window pet registry passed.");` line since we're adding it at the end of our block.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx tsc -p tsconfig.tests.json && node .test-dist/tests/window-pet-registry.test.js`
Expected: FAIL — `defaultCoverageWindows is not a function`

- [ ] **Step 3: Implement `defaultCoverageWindows` in `window-pet-registry.ts`**

```typescript
defaultCoverageWindows(): ReadonlyArray<{ windowKey: WindowKey; terminalAppName: string; sessionCount: number }> {
  const groups = new Map<WindowKey, { terminalAppName: string; count: number }>();
  for (const session of this.#defaultSessions.values()) {
    const wk = windowKeyForIdentity(session.terminalWindowId, session.terminalOwnerPid);
    const existing = groups.get(wk);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(wk, { terminalAppName: session.terminalAppName ?? session.label, count: 1 });
    }
  }
  return [...groups.entries()].map(([windowKey, g]) => ({
    windowKey,
    terminalAppName: g.terminalAppName,
    sessionCount: g.count,
  }));
}
```

Note: `RegistrySessionInfo` needs `terminalAppName` if not already present. Check the type — it may need to be added. The lease data already carries it; `onSessionIdentified` receives it via the session info.

- [ ] **Step 4: Add `terminalAppName` to `RegistrySessionInfo` if missing**

Check the `RegistrySessionInfo` interface at the top of `window-pet-registry.ts`. If it lacks `terminalAppName?: string`, add it:

```typescript
export interface RegistrySessionInfo {
  // ... existing fields ...
  readonly terminalAppName?: string;
}
```

Then update the call site in `local-ipc.ts` where `RegistrySessionInfo` is constructed to pass `terminalAppName` from the lease.

- [ ] **Step 5: Run tests**

Run: `cd apps/desktop && npx tsc -p tsconfig.tests.json && node .test-dist/tests/window-pet-registry.test.js`
Expected: PASS

- [ ] **Step 6: Typecheck**

Run: `cd apps/desktop && npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/window-pet-registry.ts apps/desktop/tests/window-pet-registry.test.ts
git commit -m "feat: add defaultCoverageWindows() to WindowPetRegistry"
```

---

### Task 2: Add "Summon pet" submenu to default pet context menu

**Files:**
- Modify: `src/pet-window.ts` (`PetContextMenuAction` interface, `buildPetContextMenuTemplate`)
- Modify: `src/default-pet-controller.ts` (pass summon callback in `installPetContextMenu` call)
- Modify: `src/local-ipc.ts` (wire `defaultCoverageWindows` + `assignPetToWindow` into controller)

**Interfaces:**
- Consumes: `defaultCoverageWindows()` from Task 1, `assignPetToWindow()` (existing), installed pets from app state

- [ ] **Step 1: Extend `PetContextMenuAction` in `pet-window.ts`**

Add an optional summon callback:

```typescript
interface PetContextMenuAction {
  // ... existing fields ...
  /** Default pet only: provides windows under default coverage for the "Summon pet" submenu. */
  readonly getSummonTargets?: () => ReadonlyArray<{ windowKey: string; terminalAppName: string; sessionCount: number }>;
  /** Default pet only: list of pets available for summoning (id + displayName + inUse). */
  readonly getSummonablePets?: () => ReadonlyArray<{ id: string; displayName: string; inUse: boolean }>;
  /** Default pet only: called when user selects a pet for a window. */
  readonly onSummonPet?: (windowKey: string, petId: string) => void;
}
```

- [ ] **Step 2: Build the "Summon pet" submenu in `buildPetContextMenuTemplate`**

In the default-pet branch of `buildPetContextMenuTemplate` (after the existing session focus / plugin commands and before the bottom items), add:

```typescript
if (action.getSummonTargets && action.getSummonablePets && action.onSummonPet) {
  const targets = action.getSummonTargets();
  const pets = action.getSummonablePets();
  if (targets.length > 0 && pets.length > 0) {
    const summonSubmenu: Electron.MenuItemConstructorOptions[] = targets.map((target) => ({
      label: `${target.terminalAppName} (${target.sessionCount})`,
      submenu: pets.map((pet) => ({
        label: pet.inUse ? `${pet.displayName} (${t("pet.menu.summon.inUse")})` : pet.displayName,
        click: () => action.onSummonPet!(target.windowKey, pet.id),
      })),
    }));
    template.push({ type: "separator" }, { label: t("pet.menu.summon"), submenu: summonSubmenu });
  } else if (targets.length === 0) {
    template.push({ type: "separator" }, { label: t("pet.menu.summon"), enabled: false });
  }
}
```

Insert this before the existing bottom items (Scurry, Hide).

- [ ] **Step 3: Wire the callbacks in `default-pet-controller.ts`**

In `createDefaultPetWindow`, find the `installPetContextMenu` call (around line 182). The action object already has `focusSessionWindow`, `hasFocusableSessionTerminal`, `onToggleNotifications`. Add the summon callbacks:

```typescript
installPetContextMenu(window, {
  label: t("pet.menu.hidePet"),
  click: options.onHideRequested,
  defaultPet: true,
  focusSessionWindow: options.onFocusSessionWindow,
  hasFocusableSessionTerminal: options.hasFocusableSessionTerminal,
  onToggleNotifications: options.onToggleNotifications,
  getSummonTargets: options.getSummonTargets,
  getSummonablePets: options.getSummonablePets,
  onSummonPet: options.onSummonPet,
});
```

Then add the same callback types to the `CreateDefaultPetWindowOptions` interface (or whatever the options type is for `createDefaultPetWindow`).

- [ ] **Step 4: Inject the callbacks from `local-ipc.ts`**

In `local-ipc.ts`, where `createDefaultPetWindow` is called (or where the default pet options are assembled), provide:

```typescript
getSummonTargets: () => windowPetRegistry.defaultCoverageWindows(),
getSummonablePets: () => {
  const state = getAppStateSnapshot();
  const defaultPetId = state.preferences.defaultPetId;
  return state.pets.installed
    .filter((p) => !p.broken && p.id !== builtInPet.id && p.id !== defaultPetId)
    .map((p) => ({
      id: p.id,
      displayName: p.displayName,
      inUse: windowPetRegistry.windowForPet(p.id) !== null,
    }));
},
onSummonPet: (windowKey: string, petId: string) => {
  windowPetRegistry.assignPetToWindow(windowKey, petId);
},
```

- [ ] **Step 5: Add i18n keys to `src/i18n/locales/en.ts`**

```typescript
"pet.menu.summon": "Summon pet",
"pet.menu.summon.inUse": "in use",
"pet.menu.summon.allBound": "All windows have dedicated pets",
```

- [ ] **Step 6: Typecheck**

Run: `cd apps/desktop && npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/pet-window.ts apps/desktop/src/default-pet-controller.ts apps/desktop/src/local-ipc.ts apps/desktop/src/i18n/locales/en.ts
git commit -m "feat: add Summon Pet submenu to default pet context menu"
```

---

### Task 3: Add `liveStatus` to sessions snapshot

**Files:**
- Modify: `src/local-ipc.ts` (`getSessionsSnapshot` and `EnrichedSessionSnapshot`)
- Modify: `src/renderer/src/main.tsx` (`SessionLeaseSnapshot` type + rendering)

**Interfaces:**
- Consumes: `getSessionLiveStatuses()` from Phase 1, existing `getSessionsSnapshot()`
- Produces: `liveStatus` field on each session in the snapshot

- [ ] **Step 1: Add `liveStatus` to `EnrichedSessionSnapshot` in `local-ipc.ts`**

```typescript
export interface EnrichedSessionSnapshot extends LeaseSnapshot {
  // ... existing fields ...
  readonly liveStatus?: string;
}
```

- [ ] **Step 2: Populate `liveStatus` in `getSessionsSnapshot()`**

In the `rawLeases.map()` body (around line 1392), add:

```typescript
const liveStatus = sessionKey ? sessionLiveStatus.get(sessionKey) : undefined;
return { ...snap, unresolvedNotifications, confinementState, petVisible, petDismissed, canFocus, healthPct, displayPetId, displayPetName, displayPetOrigin, windowKey, liveStatus };
```

- [ ] **Step 3: Add `liveStatus` to renderer type in `main.tsx`**

Update the `SessionLeaseSnapshot` type at line 30:

```typescript
type SessionLeaseSnapshot = {
  // ... existing fields ...
  liveStatus?: string;
};
```

- [ ] **Step 4: Render live status dot in Sessions tab rows**

In `SessionsView` (around line 658), replace the health dot with a live status dot when available:

```typescript
<span className="sessions-cell-pet">
  <span className={`sessions-status-dot status-${s.liveStatus ?? "idle"}`} title={s.liveStatus ?? "idle"} />
  <span className="sessions-pet-name">{s.displayPetName ?? s.actualTargetPetName}</span>
```

- [ ] **Step 5: Add CSS for status dots in the Sessions tab**

In `src/renderer/src/styles.css`, add (or verify already exists from Task 9 Phase 1):

```css
.sessions-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
}
.sessions-status-dot.status-idle { background: #94a3b8; }
.sessions-status-dot.status-thinking { background: #3b82f6; }
.sessions-status-dot.status-editing { background: #f59e0b; }
.sessions-status-dot.status-running { background: #10b981; }
.sessions-status-dot.status-testing { background: #8b5cf6; }
.sessions-status-dot.status-waiting { background: #ef4444; animation: pulse-dot 1.5s ease-in-out infinite; }
```

Check if `@keyframes pulse-dot` already exists from Phase 1's pet notification CSS — if so, don't duplicate.

- [ ] **Step 6: Typecheck**

Run: `cd apps/desktop && npx tsc --noEmit`
Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.renderer.json`

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/local-ipc.ts apps/desktop/src/renderer/src/main.tsx apps/desktop/src/renderer/src/styles.css
git commit -m "feat: add live status dots to Sessions tab"
```

---

### Task 4: End-to-end typecheck and test pass

**Files:** None (verification only)

- [ ] **Step 1: Full typecheck**

Run: `cd apps/desktop && npx tsc --noEmit`
Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.renderer.json`

- [ ] **Step 2: Full test suite**

Run: `cd apps/desktop && npx tsc -p tsconfig.tests.json && node scripts/run-tests.mjs`

- [ ] **Step 3: Fix any failures**

Address typecheck errors or test failures. Known pre-existing Windows failures (claude-memory, plugin-package, plugin-service: EPERM; check-packaging-contract: missing artifact) should be ignored.

- [ ] **Step 4: Final commit if fixes were needed**

```bash
git add <fixed-files>
git commit -m "fix: resolve integration issues from hub mode phase 2"
```

---

## Task Summary

| Task | Description | Dependencies |
|------|-------------|-------------|
| 1 | Add `defaultCoverageWindows()` to WindowPetRegistry | None |
| 2 | Add "Summon pet" submenu to default pet context menu | 1 |
| 3 | Add `liveStatus` to sessions snapshot + Sessions tab dots | None |
| 4 | End-to-end typecheck and test pass | All |

**Parallelizable groups:**
- Tier 1 (parallel): Tasks 1, 3 — no shared files
- Tier 2 (sequential): Task 2 depends on Task 1
- Tier 3: Task 4 is the final gate

**Execution model:**
- Sonnet agents for implementation (Tasks 1-3)
- Fable agent for review (Task 4)
