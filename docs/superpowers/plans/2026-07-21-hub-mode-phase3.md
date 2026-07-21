# Hub Mode Phase 3 — Notification Settings UI Implementation Plan

> **For agentic workers:** Use sonnet for implementation, haiku for exploration, fable for review/advice. Do NOT use superpowers:subagent-driven-development.

**Goal:** Add a "Notifications" settings section to the Control Center Settings page with per-kind notification policy dropdowns (persistent / auto-dismiss / hidden).

**Architecture:** The notification policy map already exists in app state and is consumed live by `NotificationStore`. We plumb it through the settings snapshot, add a validation path in `preference-patch.ts`, and render a dropdown per kind in the Settings view.

**Tech Stack:** TypeScript, React (Control Center renderer), Electron IPC. No new dependencies.

## Global Constraints

- All paths are relative to `apps/desktop/` unless stated otherwise.
- i18n keys in `src/i18n/locales/en.ts` only (other locales fall back to English).
- `npx tsc --noEmit` must pass after each task.
- Commit format: conventional commits (`feat:`, `fix:`).
- **Shared checkout warning:** Commit ONLY your files with explicit `git add`. Never `git add -A`.

---

### Task 1: Plumb notificationPolicy through settings snapshot and preference-patch

**Files:**
- Modify: `src/windows.ts` (`getSettingsStateSnapshot` — add `notificationPolicy`)
- Modify: `src/preference-patch.ts` (`PreferencePatch` type + validation)
- Test: `tests/preference-patch.test.ts` (existing — add `notificationPolicy` cases)

**Interfaces:**
- Produces: `notificationPolicy` in SettingsState.preferences, `notificationPolicy` accepted by `validatePreferencePatch`

- [ ] **Step 1: Read existing test file**

Read `tests/preference-patch.test.ts` to understand the test pattern.

- [ ] **Step 2: Write failing tests for notificationPolicy validation**

Add to `tests/preference-patch.test.ts`:

```typescript
// notificationPolicy validation
{
  const result = validatePreferencePatch({ notificationPolicy: { permission: "persistent", complete: "fade", error: "off" } });
  assert.deepStrictEqual(result.notificationPolicy, { permission: "persistent", complete: "fade", error: "off" });
}
{
  const result = validatePreferencePatch({ notificationPolicy: { permission: "invalid" } });
  assert.deepStrictEqual(result.notificationPolicy, {}, "invalid modes are stripped");
}
{
  const result = validatePreferencePatch({ notificationPolicy: "not-an-object" });
  assert.strictEqual(result.notificationPolicy, undefined, "non-object ignored");
}
{
  const result = validatePreferencePatch({});
  assert.strictEqual(result.notificationPolicy, undefined, "absent key not added");
}
```

- [ ] **Step 3: Add `notificationPolicy` to `PreferencePatch` in `preference-patch.ts`**

```typescript
export type PreferencePatch = {
  // ... existing fields ...
  notificationPolicy?: Record<string, "persistent" | "fade" | "off">;
};
```

- [ ] **Step 4: Add validation in `validatePreferencePatch`**

```typescript
if ("notificationPolicy" in value) {
  if (isRecord(value.notificationPolicy)) {
    const validModes = new Set(["persistent", "fade", "off"]);
    const policy: Record<string, "persistent" | "fade" | "off"> = {};
    for (const [key, mode] of Object.entries(value.notificationPolicy)) {
      if (typeof key === "string" && typeof mode === "string" && validModes.has(mode)) {
        policy[key] = mode as "persistent" | "fade" | "off";
      }
    }
    patch.notificationPolicy = policy;
  }
}
```

- [ ] **Step 5: Add `notificationPolicy` to `getSettingsStateSnapshot` in `windows.ts`**

In the `preferences` object returned by `getSettingsStateSnapshot()`, add:

```typescript
notificationPolicy: state.preferences.notificationPolicy,
```

Also update the `Pick<>` type on line 80 to include `"notificationPolicy"`:

```typescript
preferences: Pick<..., "openDefaultPetOnLaunch" | ... | "idleChatAutoCompactEnabled" | "notificationPolicy">;
```

- [ ] **Step 6: Run tests**

Run: `cd apps/desktop && npx tsc -p tsconfig.tests.json && node .test-dist/tests/preference-patch.test.js`
Expected: PASS

- [ ] **Step 7: Typecheck**

Run: `cd apps/desktop && npx tsc --noEmit`

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/preference-patch.ts apps/desktop/src/windows.ts apps/desktop/tests/preference-patch.test.ts
git commit -m "feat: plumb notificationPolicy through settings snapshot and preference-patch"
```

---

### Task 2: Add notification settings UI to the Control Center Settings page

**Files:**
- Modify: `src/renderer/src/main.tsx` (SettingsState type + NotificationSettings section in SettingsView)
- Modify: `src/i18n/locales/en.ts` (new i18n keys)

**Interfaces:**
- Consumes: `notificationPolicy` from SettingsState.preferences (Task 1), `patchPreferences` from existing SettingsView

- [ ] **Step 1: Add `notificationPolicy` to `SettingsState` type in `main.tsx`**

On line 29, add to the preferences type within `SettingsState`:

```typescript
notificationPolicy?: Record<string, string>;
```

- [ ] **Step 2: Define notification kind rows**

Add a constant near the top of `SettingsView` or as a module-level array:

```typescript
const notificationKindRows = [
  { label: "settings.notifications.needsApproval", keys: ["permission"] },
  { label: "settings.notifications.taskComplete", keys: ["complete"] },
  { label: "settings.notifications.taskFailed", keys: ["error"] },
  { label: "settings.notifications.reactions", keys: ["thinking", "editing", "running", "testing", "waiting", "waving", "success", "idle", "working"] },
] as const;

const notificationModeOptions = [
  { value: "persistent", label: "settings.notifications.mode.persistent" },
  { value: "fade", label: "settings.notifications.mode.fade" },
  { value: "off", label: "settings.notifications.mode.off" },
] as const;
```

- [ ] **Step 3: Add the notification settings section in SettingsView**

Inside `{activeTab === "general" && ( ... )}`, after the last existing `settings-section`, add:

```tsx
<div className="settings-section">
  <p className="eyebrow">{t("settings.notifications.eyebrow")}</p>
  <h2 className="settings-section-title">{t("settings.notifications.title")}</h2>

  <div className="settings-group">
    {notificationKindRows.map((row) => {
      const currentMode = row.keys.length === 1
        ? (settings?.preferences.notificationPolicy?.[row.keys[0]] ?? "persistent")
        : (settings?.preferences.notificationPolicy?.[row.keys[0]] ?? "persistent");
      return (
        <div key={row.keys[0]} className="settings-row">
          <div className="settings-row-text">
            <span className="settings-row-title">{t(row.label)}</span>
          </div>
          <select
            className="settings-select"
            value={currentMode}
            disabled={!settings || !!busy}
            onChange={(e) => {
              const mode = e.target.value;
              const policyPatch: Record<string, string> = {};
              for (const key of row.keys) policyPatch[key] = mode;
              patchPreferences(
                { notificationPolicy: { ...(settings?.preferences.notificationPolicy ?? {}), ...policyPatch } },
                t("settings.notifications.toast.saved"),
              );
            }}
          >
            {notificationModeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{t(opt.label)}</option>
            ))}
          </select>
        </div>
      );
    })}
  </div>
</div>
```

- [ ] **Step 4: Add i18n keys to `en.ts`**

```typescript
"settings.notifications.eyebrow": "NOTIFICATIONS",
"settings.notifications.title": "Notification Preferences",
"settings.notifications.needsApproval": "Needs approval",
"settings.notifications.taskComplete": "Task complete",
"settings.notifications.taskFailed": "Task failed",
"settings.notifications.reactions": "Reactions",
"settings.notifications.mode.persistent": "Always show",
"settings.notifications.mode.fade": "Auto-dismiss",
"settings.notifications.mode.off": "Hidden",
"settings.notifications.toast.saved": "Notification preferences saved",
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/desktop && npx tsc --noEmit`
Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.renderer.json`

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/main.tsx apps/desktop/src/i18n/locales/en.ts
git commit -m "feat: add notification settings UI to Control Center"
```

---

### Task 3: End-to-end typecheck and test pass (fable review)

**Files:** None (verification only)

- [ ] **Step 1: Full typecheck**

Run: `cd apps/desktop && npx tsc --noEmit`
Run: `cd apps/desktop && npx tsc --noEmit -p tsconfig.renderer.json`

- [ ] **Step 2: Full test suite**

Run: `cd apps/desktop && npx tsc -p tsconfig.tests.json && node scripts/run-tests.mjs`

- [ ] **Step 3: Spec coverage**

Verify against `docs/superpowers/specs/2026-07-21-hub-mode-phase3-design.md`:
- notificationPolicy in settings snapshot
- preference-patch validation
- 4 rows with correct kind keys
- 3 dropdown options (persistent/fade/off)
- Reactions row writes to all reaction keys

- [ ] **Step 4: Spot-check**

- `src/preference-patch.ts` — notificationPolicy validation present
- `src/windows.ts` — notificationPolicy in getSettingsStateSnapshot
- `src/renderer/src/main.tsx` — notification section renders, patchPreferences wired correctly

- [ ] **Step 5: Fix any failures and commit**

```bash
git commit -m "fix: resolve integration issues from hub mode phase 3"
```

---

## Task Summary

| Task | Description | Dependencies |
|------|-------------|-------------|
| 1 | Plumb notificationPolicy through settings snapshot + preference-patch | None |
| 2 | Add notification settings UI to Settings page | 1 |
| 3 | End-to-end typecheck and test pass (fable) | All |

**Execution:** Task 1 first, then Task 2, then Task 3 (fable). Sequential — small scope, no parallelism needed.
