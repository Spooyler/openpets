# VS Code Terminal-Tab Focus — Extension + Parked-Request Protocol

**Date:** 2026-07-16
**Status:** Approved in brainstorming
**Scope:** new `packages/vscode-extension`, protocol addition in `packages/client`, desktop wiring in `apps/desktop` (local-ipc, focus routing, Integrations UI)
**Predecessor:** `2026-07-16-vscode-integration-design.md` (MCP config-writer; this spec implements its "Deferred: VS Code extension" section)

## Goal

When the pet leads the user to a session running in a VS Code integrated-terminal tab, reveal the *tab*, not just the window. Today one VS Code window is one window key: window focus works (hardened by `window-select.ts`, commit `24526d2`), but with several sessions in several tabs the user still hunts for the right tab. Terminal tabs are invisible at the OS level (tab-level focus for regular terminals was tried and reverted in `0a1c33d`); only a VS Code extension can see and reveal them.

## Decisions (settled during design)

| Question | Decision |
|---|---|
| v1 scope | Focus only. No active-tab awareness streaming (deferred until a concrete feature needs it). |
| Distribution | VS Code Marketplace (`openpets.openpets-vscode`) + desktop-assisted install via `code --install-extension`. |
| Desktop→extension transport | Long-poll ("parked request") over the existing local IPC — no server-push protocol, no extension-side server. |
| Session→tab matching | In the extension, by PID: command carries the session's ancestor PID chain; each window's extension matches against its terminals' shell PIDs. Desktop keeps no per-window registry. |
| Fallback | Extension absent → behavior identical to today (window focus only). No errors surfaced. |

## Architecture

### 1. Package `packages/vscode-extension` (`openpets-vscode`)

Minimal extension, modeled on the Pi package's posture: fire-and-forget, privacy-first, IPC failures never disrupt the editor.

- Activates on `onStartupFinished`. No commands, no model tools, no UI beyond an output-channel log.
- Runs a **focus-wait loop**: discover the desktop app via `@open-pets/client` discovery → send `vscode.wait-focus` → on command, match and act → immediately re-arm. Desktop not running → bounded retry with backoff, idle otherwise.
- **Matching** (`pickTerminalForChain`, pure function, unit-testable without VS Code): for each `vscode.window.terminals[*]`, `await terminal.processId` (short cap for still-resolving PIDs) and check membership in the command's `sessionAncestorPids`. The session's agent/MCP process is a descendant of the shell VS Code spawned, so the shell PID appears in the chain. On match: `terminal.show(false)` (take focus). No match: ignore, re-arm.

### 2. Protocol addition (`packages/client` + `apps/desktop/src/local-ipc.ts`)

- New method `vscode.wait-focus` (extension→desktop), authenticated like every existing method.
- The server **parks** the request instead of answering: bounded per-connection map (cap on total parked sockets), ~60s server-side keepalive that completes with `{ command: null }` so the client re-arms and dead-socket detection keeps working. Dead connections are pruned from the map.
- Completion payload on user-triggered focus: `{ command: "reveal-terminal", sessionAncestorPids: number[] }`. PIDs only — no paths, titles, prompts, or secrets.
- The desktop completes **all** parked requests with the same payload; only the owning window's extension acts. Stateless and race-free on the desktop side.
- `packages/client` gains a long-timeout/no-timeout variant of `sendRequest` used only by this method (existing 3s response timeout stays the default for everything else).

### 3. Desktop focus routing (`apps/desktop/src/vscode-tab-focus.ts`)

New module owning the parked-request map, exposing:

- `parkFocusRequest(connection, respond)` — called by the local-ipc handler.
- `requestTabReveal(sessionAncestorPids): boolean` — completes all live parked requests; true if any were completed.
- `parkedWindowCount()` — for UI status.

Call-site changes are additive: `agent-pet-controller.ts` (:340, :375), `default-pet-controller.ts` (:59, :379), and `local-ipc.ts` (:1299) keep calling `focusTerminalWindow(...)` first (window to front), then also call `requestTabReveal(lease.clientAncestorPids)` when the chain is present. Leases already carry `clientAncestorPids` (`lease-manager.ts:40`) — no lease changes.

### 4. Desktop UI (Integrations page, VS Code detail dialog)

New "Extension (tab focus)" section:
- Status from `parkedWindowCount()`: "Connected — n window(s)" / "Not detected".
- Install button running `code --install-extension openpets.openpets-vscode` through the existing command-runner plumbing, plus a copyable manual command.
- i18n keys in all 7 locales.

## Error handling

- Extension side: every IPC failure is swallowed and logged to the output channel; retry with backoff. `terminal.show` failures ignored.
- Desktop side: parked map is bounded; over-cap park requests are answered immediately with `{ command: null, retryAfterMs }`. Completing a dead socket is a no-op (pruned).
- No behavior change anywhere when zero extensions are connected.

## Testing

- `packages/client`: contract test for the long-timeout request variant.
- Desktop unit tests: parked-map lifecycle (park → complete-all → keepalive re-arm → dead-connection pruning → cap behavior); focus routing still performs window focus when no extension is parked.
- `packages/vscode-extension`: `pickTerminalForChain` unit tests (match, no-match, unresolved processId, multiple terminals) with fake terminal objects — no VS Code host needed.
- Manual E2E: sideload the `.vsix`, run two sessions in two tabs of one VS Code window, click each session's notification, verify the correct tab is revealed; verify window-only fallback with the extension disabled.

## Release engineering (recorded, not part of the code plan)

Marketplace publishing needs a publisher account (`openpets`), `vsce package`/`vsce publish` wiring in CI, and icon/README assets. Until published, the desktop Install button is hidden behind the "not published yet" state and the dialog shows the sideload command instead.

## Deferred

- Active-tab awareness streaming (auto-resolving notifications for the visible session).
- Insiders/VSCodium reach (extension itself is editor-agnostic; the desktop install assist targets stable `code` CLI).
- Windsurf/Cursor terminal-tab focus via the same extension (both are VS Code forks and can sideload it; revisit after v1).
