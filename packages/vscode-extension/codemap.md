# Package: openpets-vscode

## Responsibility

VS Code extension for terminal-tab focus. Keeps one `vscode.wait-focus` request parked at the OpenPets desktop app (a long-poll over the existing local IPC). When the pet focuses a session and the desktop resolves the winning window's lease, this extension reveals the specific integrated terminal TAB whose shell process is an ancestor of that session's agent/MCP process — not just the OS window. Fire-and-forget posture: every failure is swallowed into an output channel and retried with bounded backoff; the editor is never disrupted. PIDs are the only data exchanged.

## Design/Patterns

### Wait-Loop (long-poll)
- `readDiscoveryFile()` + `sendRequest<VsCodeFocusCommand>(discovery, "vscode.wait-focus", {}, { responseTimeoutMs: 70_000 })` from `@open-pets/client` (timeout exceeds the desktop's 60s keepalive)
- Response is one of:
  - `{ command: "reveal-terminal", sessionAncestorPids }` — attempt a reveal
  - `{ command: null, retryAfterMs? }` — keepalive/over-cap; delay if given, then re-arm immediately otherwise
- On any error (desktop not running, socket closed, timeout without response), log and retry after an exponential backoff (1s → 30s cap), reset to 1s on next success

### Matching (pure, unit-testable)
- `src/match.ts`'s `pickTerminalForChain(terminals, sessionAncestorPids, capMs)` takes no `vscode` imports — only a `MatchableTerminal` shape (`processId: Thenable<number | undefined>`)
- Resolves all terminals' `processId` in parallel, each raced against a `capMs` timeout (2s) so one slow/hung terminal can't stall the match
- Returns the index of the first terminal whose PID appears in the session's ancestor PID chain, or `null` if none match (another window owns the session, or lookup timed out)

### Safety/Privacy
- No source code, file paths, or session content ever crosses the wire — only process ancestor PID chains
- All failures (park rejection, IPC errors, reveal errors) are caught and written to a Claude-branded `OutputChannel`, never surfaced to the user as errors or notifications
- `deactivate()` flips a `running` flag so the wait-loop exits cleanly instead of throwing on extension unload

## Flow

1. `activate()` creates the output channel and starts `waitLoop()` (fire-and-forget, not awaited)
2. `waitLoop()` parks a `vscode.wait-focus` request, awaiting either a reveal command or an idle/keepalive response
3. On `reveal-terminal`, `revealMatchingTerminal(sessionAncestorPids)` calls `pickTerminalForChain(vscode.window.terminals, sessionAncestorPids, capMs)`
4. If a match is found, `terminals[index].show(false)` brings that tab to the foreground without stealing OS focus from other apps
5. Loop re-arms immediately after every outcome (match, no-match, or keepalive)

## Integration

### Entry Points
- `src/extension.ts`: `activate`/`deactivate`, wait-loop, output-channel logging, backoff
- `src/match.ts`: pure `pickTerminalForChain` and `MatchableTerminal` type

### Exported APIs (for tests)
- `pickTerminalForChain(terminals, sessionAncestorPids, capMs)`

### Upstream Dependencies
- `@open-pets/client`: `readDiscoveryFile`, `sendRequest`, `VsCodeFocusCommand` type — same discovery/IPC transport used by other OpenPets integrations

### Downstream Producer
- Desktop app (`apps/desktop/src/vscode-tab-focus.ts` via `local-ipc.ts`): parks and completes the `vscode.wait-focus` requests this extension sends
