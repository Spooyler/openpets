# Hub Mode Phase 3 — Notification Settings UI

**Date:** 2026-07-21
**Status:** Approved in brainstorming
**Scope:** `apps/desktop` (Control Center renderer, preference-patch, windows.ts)
**Builds on:** `2026-07-14-pet-attention-model-design.md` (notification policy state shape), `2026-07-21-hub-mode-enhanced-flyout-design.md` (hook-event notification kinds)

## Purpose

The notification policy map (`notificationPolicy: Record<string, "persistent" | "fade" | "off">`)
already exists in app state and is consumed by `NotificationStore` at record time. This spec adds
a Settings UI so users can configure which notification kinds persist, auto-fade, or are hidden.

## UI Location

A new "Notifications" section within the existing Settings page's "general" tab,
below the existing toggles (show on launch, launch at login, analytics, etc.).

## Configurable Kinds

Four rows, each with a three-option dropdown:

| Row Label | Policy Key(s) | Default |
|---|---|---|
| Needs approval | `permission` | `persistent` |
| Task complete | `complete` | `persistent` |
| Task failed | `error` | `persistent` |
| Reactions | `thinking`, `editing`, `running`, `testing`, `waiting`, `waving`, `success`, `idle`, `working` (all reaction kinds grouped) | `persistent` |

The "Reactions" row writes the same mode to all reaction kind keys at once.

### Dropdown Options

| Option | Label | Behavior |
|---|---|---|
| `persistent` | "Always show" | Row stays in flyout until manually resolved |
| `fade` | "Auto-dismiss" | Row auto-resolves after 60s (existing `fadeMs`) |
| `off` | "Hidden" | No row created; pet animation still plays |

## Data Flow

1. User changes dropdown → renderer calls `api.updatePreferences({ notificationPolicy: { ...current, [key]: mode } })`
2. `preference-patch.ts` validates the patch (new `notificationPolicy` key in `PreferencePatch`)
3. `updatePreferences` in `app-state.ts` merges into persisted state via `normalizeNotificationPolicy`
4. `NotificationStore` already reads the policy live: `policy: (kind) => getAppStateSnapshot().preferences.notificationPolicy?.[kind] ?? "persistent"`

No restart needed — policy changes take effect on the next notification event.

## State Plumbing

- `getSettingsStateSnapshot()` in `windows.ts` must include `notificationPolicy` in the returned preferences
- `SettingsState` type in `main.tsx` must include `notificationPolicy?: Record<string, string>`
- `PreferencePatch` in `preference-patch.ts` must accept `notificationPolicy`

## Testing

- **Unit — preference-patch**: `notificationPolicy` validation — accepts valid policy maps, rejects non-object/invalid modes
- **Manual**: change "Task complete" to "Auto-dismiss" → complete a task → flyout row auto-resolves after ~60s; change "Reactions" to "Hidden" → reactions still animate the pet but create no flyout rows

## Out of scope

- Per-session or per-window notification overrides
- Custom fade duration UI (hardcoded 60s via `fadeMs`)
- Notification sound/toast integration
