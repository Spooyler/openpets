# Hub Mode Phase 2 — Summoning & Sessions Tab

**Date:** 2026-07-21
**Status:** Approved in brainstorming
**Scope:** `apps/desktop` (tray menu, right-click menu, Control Center Sessions tab, window-pet-registry, app-state)
**Builds on:** `2026-07-21-hub-mode-enhanced-flyout-design.md` (Phase 1), `2026-07-16-session-pet-assignment-design.md` (Sessions tab grouping & picker)

## Purpose

Phase 1 established hub mode as the default: all sessions go to the default
pet, with a grouped notification flyout. Phase 2 adds the mechanisms for
users to **break out** of single-pet mode by summoning dedicated pets for
specific windows — via the right-click context menu and the Control Center
Sessions tab.

## Decisions (settled during design)

| Question | Decision |
|---|---|
| Pet picker for right-click summon | Inline native OS submenu (no popup dialog) |
| MCP openpets_summon tool | Not needed — `openpets_adopt` already covers this |
| Control Center assignment page | Sessions tab picker (07-16 spec) is sufficient |
| Per-kind notification settings UI | Deferred to Phase 3 |

## 1. Right-click menu "Summon pet for [window]"

### Menu structure

The default pet's right-click context menu gains a **"Summon pet"** submenu.
The submenu lists each terminal window currently tracked under default
coverage, labeled by terminal app name + session count:

```
Right-click default pet →
  Focus session window
  Notifications
  ─────────────
  Summon pet ▸
    Windows Terminal (2 sessions) ▸
      🐱 Cat
      🐶 Dog
      🦉 Owl
    VS Code (1 session) ▸
      🐱 Cat
      🐶 Dog
      🦉 Owl
  ─────────────
  Scurry to edge
  Hide pet
```

### Pet list

Each window's submenu lists all installed, non-broken pets that are:
- Not the built-in pet
- Not the current default pet

Pets already bound to another window show an "(in use)" suffix but remain
selectable (selecting steals the binding — same semantics as `openpets_adopt`
and the Sessions tab picker from 07-16).

### Behavior on selection

Selecting a pet for a window calls `WindowPetRegistry.#bindExplicit` (or its
public equivalent `assignWindowPet` from the 07-16 spec). This:
- Creates a new binding for the window with the selected pet
- Moves the window's sessions from default coverage to the new binding
- Transfers notification rows from the default store to the new pet's store
- Spawns the pet window
- Writes project memory for each session's cwd

### When the submenu is empty

If no windows are under default coverage (all have bindings already), the
"Summon pet" item is disabled with a tooltip: "All windows have dedicated
pets."

### Implementation notes

The tray/context menu is built in `apps/desktop/src/tray.ts` and
`apps/desktop/src/agent-pet-controller.ts`. Electron's `Menu.buildFromTemplate`
supports nested submenus natively. The menu builder needs access to:
- `windowPetRegistry.defaultCoverageWindows()` — new method returning
  windows under default coverage with their terminal app name and session
  count
- Installed pets list (already available via app state)

## 2. Sessions tab — grouping & pet picker

This implements the 07-16 spec's Sessions tab design with minor adjustments
for Phase 1's hub mode context.

### Layout

The Sessions tab in Control Center shows sessions grouped by terminal window:

```
┌──────────────────────────────────────────────────┐
│ Windows Terminal          [Default ▾]            │
│ ┌──────────────────────────────────────────────┐ │
│ │ ● thinking  openpets     3m   [Focus] [Hide] │ │
│ │ ○ idle      my-api       12m  [Focus]        │ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ VS Code                   [🦉 Owl ▾]            │
│ ┌──────────────────────────────────────────────┐ │
│ │ ● editing   frontend     1m   [Focus] [Hide] │ │
│ └──────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

### Group header

- Terminal app name (left)
- Pet picker dropdown (right): lists all installed pets + "Default". Current
  pet is pre-selected. Pets bound elsewhere show "(in use)" but are
  selectable.

### Pet picker behavior

- **Pick pet X** → calls `assignWindowPet(windowKey, petId)` — rebind with
  adopt/steal semantics. Notification store carries over on swap. Project
  memory written for each session's cwd. User-closed flag cleared.
- **Pick Default** → calls `assignWindowPet(windowKey, null)` — unbind.
  Pet closes, sessions fall to default coverage. Memory entries cleared.
  Window marked user-closed (pool won't re-draw).

### Session rows

Each row shows:
- Live status dot (from `SessionLiveStatusTracker`)
- Session label (cwd basename)
- Uptime
- Action buttons: Focus (focuses terminal window), Hide/Disconnect (existing)

### Plumbing

One new preload/API method: `assignWindowPet(windowKey, petId | null)`.
Drives `WindowPetRegistry`'s existing bind/unbind machinery. The picker
reuses the installed-pets list already loaded in the Control Center.

### Data source

`getSessionsSnapshot()` (already in `local-ipc.ts`) needs to include
`windowKey` and `liveStatus` per session. The renderer groups rows by
`windowKey` and renders the picker per group.

## Error handling

- Right-click menu built with stale window list (window closed between menu
  build and selection) → `assignWindowPet` no-ops gracefully; pet is not
  spawned for a dead window.
- Picker selects a pet that was uninstalled between render and click →
  toast error in Control Center.
- `assignWindowPet` for an unidentified session (no windowKey yet) → no-op,
  row shows "identifying..." with picker disabled.

## Testing

- **Unit — right-click menu**: `defaultCoverageWindows()` returns correct
  windows with app names and session counts; empty when all windows bound.
- **Unit — assignWindowPet**: bind creates binding + moves sessions + writes
  memory; unbind closes pet + clears memory + marks user-closed; steal
  semantics (pet already bound elsewhere) closes old binding.
- **Unit — sessions snapshot**: `windowKey` and `liveStatus` present in
  snapshot entries.
- **Manual (Windows)**: right-click default pet → summon submenu lists
  windows → pick a pet → pet spawns, sessions move, flyout updates; Sessions
  tab shows grouped view with picker; picker Default returns sessions to
  default pet.

## Out of scope (Phase 3)

- Per-kind notification settings UI (state shape already ships)
- Drag-and-drop session assignment
- Per-session pet assignment within a window (one-pet-per-window stands)
