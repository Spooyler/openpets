# Pet Attention Model — Design Spec

**Date:** 2026-07-14
**Status:** Approved in brainstorming; awaiting implementation plan
**Scope:** `apps/desktop` (pet lifecycle, notification centre, focus routing), small IPC protocol addition in `packages/client` / `packages/mcp`

## Goal

The pet is an ambient monitor for coding-agent sessions: it shows how each
session is progressing and whether one needs attention. When a session needs
you, the pet leads you to the right window — you never hunt for the session
that pinged.

Today, pets bind to *sessions*, but focus targets *windows* (tab-level focus
was tried and reverted in `0a1c33d`). Two sessions in tabs of one Windows
Terminal window can spawn two pets that both lead to the same place. This spec
rebinds pets to OS windows and adds a per-pet notification centre so one pet
can multiplex several sessions.

## Decisions (settled during design)

| Question | Decision |
|---|---|
| Pets per window | At most one pet per OS window (terminal window, VS Code window). |
| Default behavior | Single persistent default pet; dedicated pets only via `--pet` at start, `openpets_adopt` mid-run, or opt-in pool. |
| Pet pool | Kept as opt-in, **off by default**, rescoped from per-session to per-window assignment. |
| Notification persistence | Everything persists in v1; `kind → persistent \| fade \| off` policy map in state from day one, settings UI later. |
| Centre layout | Count badge on the pet + click-to-expand flyout list anchored to the pet. |
| Pet-body double-click | Oldest unresolved row's window; if none unresolved, most recently active session. |
| Session end | Pet closes. Window dead → instant. Window alive → post "session ended" to the default pet's centre, close after ~5s farewell. |
| Scurry | Right-click action; all visible pets walk to the nearest left/right edge of their current display. |
| Hide / Close | Hide available on all pets (binding keeps running); Close only on non-default pets (unbind + fall back to default coverage). |

## Architecture

Chosen approach: **window-binding registry layered over the existing lease
machinery**. Leases stay the per-session liveness primitive (TTL, heartbeats,
PID-reuse nonce, liveness checks — unchanged). A new registry owns pet
lifecycle keyed by window, replacing lease-count-driven pet spawning.

Rejected alternatives: a window-first rewrite of the lease layer (same
observable behavior, rewrites the most defensively-hardened code in the app)
and presentation-level collapse of per-session pets (permanent model/reality
mismatch).

### Terminology

- **Session** — a lease-holding coding-agent process tree (unchanged).
- **Window** — an OS window identified by a *window key*: `terminalWindowId`
  where available, else `terminalOwnerPid`.
- **Binding** — window key → pet; at most one per window.
- **Default pet** — persistent, never bound; covers every session whose window
  has no binding, and acts as the notification sink of last resort.

### New module: `window-pet-registry.ts`

Owns `Map<windowKey, { petId, sessions: Set<leaseId>, notificationStore }>`.

- First session into a binding → spawn the pet window.
- Last session out → teardown (see Lifecycle).
- Replaces `onFirstExplicitLease` / `onLastExplicitLease` callbacks in
  `lease-manager.ts` with registry membership events.
- `agent-pet-controller.ts` becomes registry-driven: pet windows are created
  and closed by binding events, not explicit-lease counts.

### How a window gets a pet

1. **Explicit:** a session starts with `--pet X` or calls `openpets_adopt` →
   its window binds to X. If the window already has a binding, it **re-binds**:
   sprite swaps to the new pet, the notification store carries over. Adopt
   means "this window's pet is now X".
2. **Pool (opt-in):** the first session in an unbound window draws the next
   pool pet from `petPoolOrder`; later sessions in that window join the
   existing binding. Disabling the pool despawns pool bindings and remembers
   their *windows* for respawn on re-enable (replacing the current PID-based
   suspend list in `local-ipc.ts`).

### Async-identity gap

Terminal identity resolves via PPID walk after lease acquire (~0.1–2s). The
pet spawns once identity resolves. If resolution has not landed after 3s, the
pet spawns unbound and merges into the binding when identity arrives. Sessions
whose identity never resolves stay under default-pet coverage — events are
never dropped, they route to the default pet.

### Lifecycle / teardown

Sessions leave a binding on lease release, TTL expiry, or PID death (all
existing mechanisms). When the last session leaves:

- **Window dead** (terminal PID gone) → pet closes instantly.
- **Window alive** (agent exited, terminal open) → pet posts
  "session ended in *X*" to the **default pet's** notification centre, then
  closes after a ~5s farewell state.

## Notification centre

### Store

Each binding — and the default pet — owns a notification store. Entry:

```
{ sessionKey, windowKey, kind, message, createdAt,
  state: unresolved | resolved | dismissed }
```

`sessionKey` = `clientPid` + `sessionNonce`, stable across lease re-acquires
for the same agent process (leaseIds rotate; the nonce pair does not).

The flyout shows **one live row per session**: a new event from that session
replaces the row content and re-marks it unresolved. Badge = count of
unresolved rows; hidden at zero.

### Persistence policy

v1 hardcodes all kinds persistent. The store consults a
`kind → persistent | fade | off` policy map (shape lives in `app-state.ts`
from day one) so per-kind configurability is later a settings page, not a
refactor. `fade` = row auto-resolves after a timeout; `off` = the event still
animates the pet but writes no row.

### Resolution

A row resolves when:

- (a) it is double-clicked (focus follows), or
- (b) its window gains OS focus anyway — the existing window tracker poll
  makes this a cheap check.

Right-click a row → dismiss. Fresh activity from a resolved session re-marks
its row unresolved.

### UI

Badge rendered on the pet sprite via the existing status-badge machinery,
extended with a count. Clicking the badge expands a flyout anchored to the
pet, rendered inside the pet's own transparent BrowserWindow by enlarging its
bounds while open — no new window type. Row contents: state dot, session
label, latest message, relative age.

### Session labels

The MCP client sends its `cwd` at lease acquire (small IPC protocol addition
in `packages/client` / `packages/mcp`; Claude hooks already receive `cwd` in
their input payloads). Row label = basename of `cwd` (e.g. `fraud_project`).
Fallback: terminal app name + pid.

## Focus routing

- **Double-click a flyout row** → focus that row's window via the existing
  `focusTerminalWindow` path; mark the row resolved.
- **Double-click the pet body** → oldest unresolved row's window; if none,
  most recently active session (generalize `getFocusableDefaultLease` to
  operate per notification-store scope).
- A bound pet routes only among its own window's sessions; the default pet
  routes across all sessions it covers.

## Menu actions

All pets: *Focus session window* (existing), *Notifications* (toggle flyout),
*Scurry to edge*, *Hide pet*. Non-default pets additionally: *Close pet*.

- **Scurry to edge** — global action: every visible pet walks (via
  `pet-motion-engine`) to the nearest left/right edge of the display it is on.
  Pure reposition; badges, flyouts, and events keep working. Pets stay until
  dragged or respawned.
- **Hide pet** — window hides; binding and notification store keep running.
  Unhide via tray menu (*Show hidden pets*) or Control Center. A hidden pet
  accumulating unresolved rows stays hidden.
- **Close pet** — unbinds the window, closes the pet window. Its sessions fall
  back to default-pet coverage immediately; their rows move to the default
  pet's store. The window is marked user-closed (successor of today's dismiss
  tokens) so heartbeats from still-active leases do not respawn the binding;
  a fresh `openpets_adopt` or a new `--pet` session in that window re-binds.

## Settings & state

- `petPoolEnabled` keeps its toggle; semantics become per-window.
- Notification policy map stored in `app-state.ts`, hardcoded all-persistent
  in v1; settings UI is additive later.
- Hidden-pet set persisted so hide survives restarts.

## Error handling

- Identity resolution failure → session stays on default-pet coverage.
- Focus call failure → row flashes an error state, stays unresolved.
- Window closed while flyout open → that window's rows get a "window gone"
  state; double-click becomes a no-op with a fading explanation.

## Testing

- **Unit:** window registry (bind / join / re-bind on adopt / leave /
  teardown; pool-per-window draw and respawn list), notification store (row
  lifecycle, resolution on focus, badge count, oldest-unresolved selection),
  lease-manager callback rewiring.
- **Contract:** the `cwd` param addition to the IPC acquire request.
- **Manual matrix (Windows):** multi-tab Windows Terminal (one pet, one row
  per tab-session); two terminal windows + VS Code (three pets max); session
  crash (row lands on default pet); scurry across two monitors; hide/unhide
  with pending badge.

## Out of scope

- Tab-level focus (stays reverted; window-level only).
- Per-kind notification settings UI (state shape ships, UI later).
- Linux focus support (`focusActionAvailable` stays false there).
- Any change to the plugin SDK pet surfaces (`plugin-pet-registry.ts`
  spawned pets are not session pets and are unaffected).
