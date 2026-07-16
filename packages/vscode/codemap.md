# Package: @open-pets/vscode

## Responsibility

Pure Node.js package for VS Code editor integration file management. Manages the OpenPets MCP entry in VS Code's user-level `mcp.json` configuration (read by Copilot agent mode and other MCP-aware agents). Provides safe, atomic file operations with validation, backup, and redaction capabilities. Mirror of `@open-pets/cursor` adapted to VS Code's config schema and paths (no rules file; a shared mcp-json core may be extracted once Windsurf/Zed integrations arrive).

## Design/Patterns

### Config Path Resolution
- **Global config** (per platform):
  - Windows: `%APPDATA%\Code\User\mcp.json`
  - macOS: `~/Library/Application Support/Code/User/mcp.json`
  - Linux: `~/.config/Code/User/mcp.json`
- **Workspace config**: `<workspaceDir>/.vscode/mcp.json`
- Stable VS Code only (no Insiders/VSCodium paths)
- All APIs accept explicit `configPath` for custom locations

### Schema difference vs Cursor
- Top-level key is `servers` (Cursor uses `mcpServers`)
- Entry shape is identical: `{ "type": "stdio", "command", "args" }`
- Other top-level keys (`inputs`, `sandbox`) are preserved untouched on install/replace/remove

### Safety-First File Operations
- Strict JSON only (no JSONC comments)
- Maximum config size: 256 KiB
- Reject symlinks at any path level (config file, parent directories, ancestors)
- Reject non-regular files and unsafe parent paths
- Atomic writes using temp files and atomic rename
- Automatic backup creation before modifications
- Private file permissions (0o600) where supported

### Status Classification
- `missing`: No config file or no OpenPets entry exists
- `installed`: Matching OpenPets entry present and up-to-date
- `needs-update`: Old version or different pet
- `conflict`: Non-OpenPets `openpets` entry blocking installation
- `invalid`: Parse error, oversized, unsafe path, malformed schema
- `error`: Unexpected I/O failure

### Managed Entry Detection
- Published mode: `npx -y @open-pets/mcp@SEMVER [--pet PET]`
- Local mode: `node <absolute-path> [--pet PET]`
- Validates semantic versioning and pet ID format; rejects unpinned versions

### Sensitive Data Redaction
Recursive, case-insensitive redaction of `env`, `headers`, `auth`, `authorization`, `token`, `secret`, `password`, `credentials` keys, sensitive URL query parameters, and token-like string values (covers `inputs` entries too).

## Flow

1. **Read** existing config via `readVsCodeMcpConfig(path)`
2. **Classify** status via `classifyVsCodeMcpStatus(result, path, expected)`
3. **Plan** operation via `planVsCodeMcpInstall` / `planVsCodeMcpReplace` / `planVsCodeMcpRemove`
4. **Execute** write via `executeVsCodeMcpWrite(plan)` (temp file + backup + atomic rename)

## Integration

### Entry Points
- `src/index.ts`: Public API exports
- `src/vscode-mcp.ts`: MCP entry builders, validation, and path utilities
- `src/vscode-status.ts`: Status classification and config read/write operations
- `src/vscode-previews.ts`: Config preview and redaction helpers
- `src/check-vscode.ts`: Contract validation tests (runs via `npm test`; symlink-rejection cases auto-skip where symlink creation is unavailable, e.g. Windows without Developer Mode)

### Exported APIs
- `buildVsCodeMcpEntry(options)` / `formatVsCodeMcpConfig(options)`
- `getVsCodeGlobalMcpPath(platform, homeDir, appDataDir?)` / `getVsCodeWorkspaceMcpPath(workspaceDir)`
- `validateOpenPetsPetId(id)` / `isValidPetId(id)` / `validateOpenPetsPackageVersion(v)`
- `readVsCodeMcpConfig(path)` / `classifyVsCodeMcpStatus(result, path, expected)`
- `planVsCodeMcpInstall(path, options, allowReplace?)` / `planVsCodeMcpReplace(path, options)` / `planVsCodeMcpRemove(path)`
- `executeVsCodeMcpWrite(plan)` / `isManagedOpenPetsMcpEntry(value)` / `maxVsCodeConfigBytes`
- `buildOpenPetsOnlyPreview(options)` / `redactVsCodeConfig(config)`

### Downstream Consumers
- Desktop app (`apps/desktop/src/agent-setup.ts`): status/preview for the Integrations page and install/replace/remove actions
