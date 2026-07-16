# VS Code Integration — MCP Config-Writer

**Date:** 2026-07-16
**Status:** Approved in brainstorming
**Scope:** new `packages/vscode` (`@open-pets/vscode`), desktop wiring in `apps/desktop` (agent-setup, Integrations UI, i18n, checks)

## Summary

Promote the "Coming soon" VS Code card on the Integrations page to a live integration. The desktop app writes an `openpets` MCP server entry into VS Code's user-level `mcp.json`, so Copilot agent mode (and any MCP-aware agent inside VS Code) gets the `openpets_say` / `openpets_react` / `openpets_status` / `openpets_adopt` tools. The MCP server acquires leases as usual; the window-binding attention model already treats a VS Code window as a bindable OS window (window key via `terminalOwnerPid`), so pet binding and click-to-focus work with no attention-model changes.

## Decisions (settled during design)

| Question | Decision |
|---|---|
| Integration mechanism | Global MCP config write only — mirror of the Cursor integration. No VS Code extension, no Copilot instructions file. |
| VS Code variants | Stable only. Insiders/VSCodium users configure manually. |
| Package structure | New `@open-pets/vscode` package copied from `@open-pets/cursor`. No shared mcp-json core yet — second usage of the pattern; extract when Windsurf/Zed make it 3+ (KISS > DRY). |
| Surfaces | Desktop app Integrations page only. No CLI command in this iteration. |
| Rules/instructions file | Skipped. Cursor ships a project rules file; the VS Code analogue (Copilot instructions) is deferred. |

## VS Code specifics (vs Cursor)

- **Config path:** VS Code user profile dir — Windows `%APPDATA%\Code\User\mcp.json`, macOS `~/Library/Application Support/Code/User/mcp.json`, Linux `~/.config/Code/User/mcp.json`. (Cursor: `~/.cursor/mcp.json`.)
- **Schema:** top-level key is `servers` (not `mcpServers`). Stdio entry `{ "type": "stdio", "command", "args" }` is identical to Cursor's. Other top-level keys (`inputs`, `sandbox`) must survive install/replace/remove untouched.
- No app-presence detection: like Cursor, status is derived purely from the config file state (`missing | installed | needs-update | conflict | invalid | error`).

## Architecture

`packages/vscode` mirrors `packages/cursor` file-for-file (minus rules):

- `vscode-mcp.ts` — server name (`openpets`), entry building for published (`npx -y @open-pets/mcp@<version> [--pet <id>]`) and local/bundled (`node <abs path>`) modes, pet-id/version validation, per-OS global path helper.
- `vscode-status.ts` — hardened config read (256 KiB cap; symlink, non-regular-file, and parent-traversal rejection), status classification against the expected entry, plan/execute for install, replace, remove with timestamped backup and atomic temp-file rename.
- `vscode-previews.ts` — OpenPets-only preview and recursive secret redaction for the UI's advanced preview.
- `check-vscode.ts` — assert-based self-test in a temp dir, including preservation of `inputs`/`sandbox` and unrelated servers.

Desktop wiring mirrors Cursor's: `vscode-install|replace|remove` actions in `agent-setup.ts`, `vscodeStatus`/`vscodePreview` on the snapshot, a live card plus detail dialog in the Integrations page, and a `check-vscode-desktop.ts` companion check.

## Deferred: VS Code extension (terminal-tab awareness)

VS Code terminal tabs are invisible at the OS level — one VS Code window is one window key, and tab-level focus for terminals was previously tried and reverted (`0a1c33d`). A future marketplace extension could use `vscode.window.terminals`, `onDidChangeActiveTerminal`, and `Terminal.processId` to match tabs to OpenPets sessions by shell PID, stream active-tab events, and accept focus commands (`terminal.show()`) over the same `@open-pets/client` IPC used by the Pi/OpenCode integrations. That is a separate package, new IPC protocol messages, and focus-routing changes — its own design cycle.

## Testing

- Package self-test `check-vscode.ts` (port of `check-cursor.ts`): validation, classification for every status, atomic write/backup, preservation of unrelated config, symlink/oversize/non-regular rejection.
- Desktop check `check-vscode-desktop.ts` (port of `check-cursor-desktop.ts`): path shape, status→state/label mapping, action availability matrix.
- Manual end-to-end on Windows: install from the Integrations page, confirm `mcp.json` content, see the tools in VS Code (`MCP: List Servers`), exercise conflict and remove paths.
