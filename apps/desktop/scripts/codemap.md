# apps/desktop/scripts/

## Responsibility

Build and release automation scripts for the OpenPets desktop application. Handles packaging cleanup and local release orchestration (macOS-focused).

## Design

- **Node.js Scripts**: CommonJS (`.cjs`) for sync fs operations, ESM (`.mjs`) for modern async flow
- **Safety-First**: Path validation before `rmSync`, git state verification, dry-run support
- **GitHub Integration**: Uses `gh` CLI for draft release creation and artifact upload
- **Cross-Platform Builds**: Orchestrates `electron-builder` for macOS, Windows, Linux from macOS host

## Flow

**Clean Package Output** (`clean-package-output.cjs`):
```
Resolve dist-electron path → Validate path components → rmSync recursive
```

**Local Release** (`release-local.mjs`):
```
Preflight checks (git clean, remote sync, version validity)
→ Build and test (unless --skip-checks)
→ Clean output directory
→ Execute electron-builder for each target in build plan
→ Generate SHA256SUMS
→ (if --yes) Create GitHub draft release + upload artifacts
```

**Desktop Tests** (`run-tests.mjs`):
```
Check preload syntax → Compile tests to .test-dist → Run behavior tests → Run contract tests → Run remaining dist checks
```

## Integration Points

- **File System**: `apps/desktop/dist-electron/` (build output), `apps/desktop/dist/` (compiled JS)
- **Git**: Working tree status, remote sync verification, tag existence checks
- **GitHub**: `gh release create`, `gh release upload` to `alvinunreal/openpets`
- **Build Tools**: `pnpm`, `electron-builder`, `node --check`
- **Node APIs**: `crypto` (SHA256), `fs`, `path`, `child_process.spawnSync`

## Key Scripts

- `clean-package-output.cjs`: Removes `dist-electron` directory with path safety checks
- `release-local.mjs`: Full release orchestration with preflight validation, multi-platform builds, and GitHub draft creation
- `run-tests.mjs`: Desktop test runner for preload syntax checks, `.test-dist` behavior/contract tests, and remaining runtime checks

## Build Plan (release-local.mjs)

Default targets:
- macOS DMG (x64+arm64 universal)
- Windows NSIS installer (x64)
- Linux AppImage (x64)
- Linux DEB (x64)
- Linux RPM (x64)
- Linux tar.gz (x64)

Optional flags:
- `--include-mac-zip`: macOS ZIP archive
- `--include-linux-deb`: Debian package
- `--include-linux-targz`: Linux tar.gz archive
- `--include-experimental-arm`: Windows/Linux ARM64 builds
