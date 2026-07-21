# Hub Mode & Enhanced Flyout — Design Spec

**Date:** 2026-07-21
**Status:** Approved in brainstorming
**Scope:** `apps/desktop` (window-pet-registry, notification-store, notification-view, pet-window, agent-pet-controller, default-pet-controller, app-state, hooks classifier), `packages/claude` (hook event routing)
**Builds on:** `2026-07-14-pet-attention-model-design.md` (window bindings, notification centre, focus routing), `2026-07-16-session-pet-assignment-design.md` (project memory, resolution chain, sessions tab)

## Purpose

The two prior specs establish the window-binding registry, notification store,
and session assignment model. This spec adds the **hub operating mode** as the
default experience, enriches the notification flyout into a live session
dashboard, and wires hook events into notification rows so the pet surfaces
actionable session states without the user hunting through terminals.

Phase 1 only — summoning mechanisms (right-click menu, MCP command, Control
Center assignment page) are deferred to Phase 2.

## Modifications to prior specs

### 07-14: Pet-body double-click target

Changed from "oldest unresolved row's window; if none, most recently active"
to **most recently active session's window, unconditionally**. Unresolved
notifications are surfaced through the flyout badge and rows, not through the
click target. Rationale: the primary click gesture should feel like "go back
to where I was working", not "deal with the queue."

### 07-14: Notification flyout grouping

The 07-14 flyout is flat (one row per session). This spec changes it to
**group rows by terminal window** with clickable group headers. The sessions
tab (07-16) already groups by window — the flyout mirrors that structure in
compact form.

### 07-16: `petPoolEnabled` reframing

`petPoolEnabled` is reframed as a `sessionAssignment` setting with two modes.
The pool toggle remains but is exposed only within the `auto-spawn` mode's
sub-settings. See Section 1 below.

## 1. Session assignment setting

### New state

`preferences.sessionAssignment: "hub" | "auto-spawn"` — default `"hub"`.

- **`hub`**: All new sessions go to the default pet unless their window
  already has a binding (explicit `--pet`, `openpets_adopt`, or prior project
  memory). The pool is inactive regardless of `petPoolEnabled`. The default
  pet is the primary notification surface.

- **`auto-spawn`**: The 07-16 resolution chain runs fully: window binding →
  project memory → pool draw → default. `petPoolEnabled` and
  `petPoolOrder` become active sub-settings.

### Pet selection strategy (auto-spawn sub-setting)

`preferences.petSelectionStrategy: "random" | "ordered"` — default `"random"`.

- **`random`**: current pool draw behavior (random from installed).
- **`ordered`**: round-robin through `petPoolOrder`; position tracked in
  transient state (resets on restart).

Only effective when `sessionAssignment` is `"auto-spawn"` and
`petPoolEnabled` is `true`.

### Migration

Existing installs with `petPoolEnabled: true` get
`sessionAssignment: "auto-spawn"` on first load. Fresh installs get `"hub"`.
No destructive migration — the pool toggle and order list are preserved.

## 2. Hook events → notification rows

### Event mapping

Three hook events create persistent notification rows on the session's pet
(or the default pet in hub mode):

| Hook Event | Row Kind | Row Label | Urgency |
|---|---|---|---|
| `PermissionRequest` | `permission` | "Needs approval" | urgent |
| `Stop` | `complete` | "Task complete" | normal |
| `StopFailure` | `error` | "Task failed" | urgent |

`PreToolUse` events do **not** create rows. They update the session's live
status badge (Section 3) and trigger transient pet animations as today.

### Urgency

Urgent rows trigger:
- A persistent speech bubble on the pet (queued if multiple; see Section 4).
- The pet's attention animation (existing `waiting` / `error` reactions).
- Badge count increment.

Urgent rows do **not** auto-focus the terminal window. Focus happens only when
the user double-clicks the pet or the notification row.

### Row creation from hooks

The hook process (`packages/claude`) already sends events via the IPC client.
The desktop app's IPC handler creates a notification row when it receives a
hook event with one of the three mapped event names. The row is keyed by
`sessionKey` (clientPid + sessionNonce) so a new event from the same session
replaces the previous row content and re-marks it unresolved — matching the
07-14 "one live row per session" model.

### Row content

Each row stores:
- `sessionKey`, `windowKey`
- `kind`: `permission` | `complete` | `error` | `activity` (from `openpets_say`)
- `message`: the row label from the table above, or the `openpets_say` text
- `liveStatus`: the session's live activity status (see Section 3)
- `createdAt`
- `state`: `unresolved` | `resolved` | `dismissed`

## 3. Enhanced flyout

### Window-grouped layout

The flyout renders rows grouped by terminal window:

```
┌──────────────────────────────────┐
│ ■ Windows Terminal (2 sessions) ▸│  ← group header (clickable → focus window)
│   ● thinking  openpets  "Needs approval" │  ← session row
│   ○ idle      my-api    "Task complete"  │
│                                          │
│ ■ VS Code (1 session)          ▸│
│   ● editing   frontend  —               │
└──────────────────────────────────┘
```

- **Group header**: terminal app name (e.g., "Windows Terminal", "VS Code"),
  session count, pet name (if bound to a non-default pet). Clicking the
  header focuses that terminal window.
- **Session row**: live status dot, session label (cwd basename), latest
  notification message (or "—" if no notifications). Clicking a row focuses
  the session's terminal window and resolves the row.

### Session labels

Basename of `cwd` (e.g., `openpets`, `my-api`). Fallback: terminal app name
+ PID. Matches 07-14 decision.

### Live status badges

Each session row shows a colored status dot updated by `PreToolUse` and other
hook events:

| Status | Color | Source |
|---|---|---|
| idle | gray | no recent hook event (>30s since last) |
| thinking | blue | `PreToolUse` with Read/Grep/Glob |
| editing | amber | `PreToolUse` with Edit/Write/MultiEdit |
| running | green | `PreToolUse` with Bash (non-test) |
| testing | purple | `PreToolUse` with Bash (test command) |
| waiting | red (pulsing) | `PermissionRequest` |

Status decays to `idle` after 30 seconds of no hook events from that session.
The decay timer resets on each hook event.

### Row limit

Raised from 12 to 50 rows. In practice, the flyout is windowed — only rows
in the visible scroll area are rendered.

## 4. Queued speech bubbles with session labels

In hub mode, the default pet tracks multiple sessions. Speech bubbles
(from `openpets_say` or hook speech events) are queued:

- One bubble visible at a time.
- Each bubble is prefixed with the session label in bold:
  **openpets** "Needs your approval!"
- A new bubble from the same session replaces the current one immediately.
- A new bubble from a different session queues behind the current one.
- Bubbles auto-dismiss after the existing timeout (configurable per-kind in
  the 07-14 persistence policy).
- Queue depth cap: 5 bubbles. Oldest queued bubble is dropped if exceeded.

## 5. Focus behavior summary

| Action | Target |
|---|---|
| Double-click pet body | Most recently active session's terminal window |
| Click notification row | That row's session's terminal window; row resolves |
| Click group header | That group's terminal window |
| Right-click → "Focus session window" | Same as double-click pet body |

No action auto-focuses a window. All focus is user-initiated.

## Error handling

- Hook event arrives for unknown session → row created under default pet
  coverage; session will be associated when lease identity resolves.
- Live status update for a closed session → ignored.
- Flyout open when pet moves (drag/scurry) → flyout repositions anchored to
  pet.
- Focus call fails → row flashes error state, stays unresolved (inherited
  from 07-14).

## Testing

- **Unit — notification store**: hook-event-to-row mapping for all three
  event types; row replacement on same sessionKey; urgency triggers; status
  decay timer; queue depth cap.
- **Unit — flyout renderer**: window grouping; group header click routing;
  session row status dot colors; label rendering from cwd; row limit
  windowing.
- **Unit — speech bubble queue**: single-session replacement; cross-session
  queuing; queue cap; label prefix rendering.
- **Unit — assignment setting**: hub mode skips pool; auto-spawn mode runs
  full chain; migration from petPoolEnabled; selection strategy
  random/ordered.
- **Contract**: hook event payloads include `hook_event_name` values that map
  to notification row kinds.
- **Manual matrix (Windows)**: 3+ sessions across 2 windows in hub mode →
  default pet shows grouped flyout; PermissionRequest creates urgent row;
  Stop creates normal row; click row focuses correct window; double-click pet
  focuses most recent; speech bubbles queue with labels.

## Out of scope (Phase 2)

- Right-click menu "Summon pet for [window]" on the default pet.
- MCP `openpets_summon` command for agent-initiated pet spawning.
- Control Center pet-to-window assignment management page.
- Per-kind notification settings UI (state shape ships in 07-14, UI later).
