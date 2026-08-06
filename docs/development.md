# Developer Experience (DX)

How to set up, build, run, and release the workspace. This doc is the practical
"how do I work in this repo" companion; testing and production-validity gates get
their own doc, [testing-and-validation.md](testing-and-validation.md).

## Layout & toolchain

- **Monorepo**: pnpm workspaces (`pnpm-workspace.yaml`) over `apps/*` and
  `packages/*`. Package manager pinned to `pnpm@11.x`; Node `>=20`.
- **ESM + TypeScript everywhere**: every package is `"type": "module"` with dual
  type exports; internal links use `workspace:*`.
- **`web/` uses Bun + Nuxt** and is a separate toolchain — its commands run from
  `web/` with `bun`, not pnpm. Only its data/catalog side is in scope here (see
  [catalog.md](catalog.md)).
- **Versioning**: packages align around SDK v3 / `manifestVersion 3`. The
  workspace version is in the root `package.json` (`3.1.0` at time of writing).

The authoritative structural map is the root `codemap.md` plus per-folder
`codemap.md` files; read those before editing a subsystem.

## Root command surface

All from the repo root unless noted (full list in root `package.json`):

| Command | What it does |
|---------|--------------|
| `pnpm build` | Build every package (`pnpm -r build`) |
| `pnpm typecheck` | Type-check every package |
| `pnpm check` | Per-package `check` (typecheck + build + contract checks) |
| `pnpm test` | Build, then run each package's tests |
| `pnpm dev:desktop` | Run the desktop app in dev |
| `pnpm dev:desktop:control-center` | Dev with renderer/Control Center focus |
| `pnpm dev:desktop:plugins` | Dev with official plugins hot-loaded |
| `pnpm package:desktop` / `:dir` | Build + package the desktop app (full / unpacked dir) |
| `pnpm release:desktop` | macOS-local release automation (GitHub draft) |
| `pnpm release:npm` | Publish npm packages |
| `pnpm plugins:*` | Plugin test/validate/package/publish/deploy (see below) |

### Plugin DX commands

| Command | Purpose |
|---------|---------|
| `openpets plugin new <name> --template <t>` | Scaffold an SDK v3 plugin |
| `openpets plugin validate <dir>` | Validate a plugin locally |
| `pnpm plugins:test` | Locale checks + official/community plugin harness tests |
| `pnpm plugins:locales` | Check plugin locale key coverage |
| `pnpm create-plugin <id>` | Scaffold a new plugin under `plugins/official/` |

Plugins are bundled with the app from `plugins/official/` and
`plugins/community/` — there is no separate release pipeline. See
[plugins.md](plugins.md) for the authoring workflow.

## Running the desktop app

- `pnpm dev:desktop` launches Electron against the TypeScript source with the
  Vite renderer dev server.
- Plugin authors using the installed app do not need this repo: open **Plugins →
  Developer Mode → Load unpacked plugin folder** to validate, snapshot, watch, and
  reload a standalone plugin folder.
- For plugin work, `pnpm dev:desktop:plugins` points the local loader at both
  `plugins/official` and `plugins/dev` (via `OPENPETS_DEV_PLUGIN_ROOTS`) so
  official plugins and in-progress dev plugins hot-load when working on OpenPets
  itself.
- Logs land in `userData/logs/openpets.log` (path varies by OS). Route renderer
  diagnostics into the app log, not just DevTools (per `AGENTS.md`).

### The CSP footgun

Any renderer-visible URL scheme, image source, dev endpoint, or internal
protocol must be added to the CSP in **both** `apps/desktop/vite.config.ts` and
`apps/desktop/src/renderer/index.html`. Symptom of forgetting: images fall back
to the default pet even though install/render logic is correct. See
[desktop.md](desktop.md).

## Logging-as-DX

When working on renderer/IPC/catalog/plugin/pet-window behavior, add **targeted,
scoped** logs as part of the change (data shapes, selected ids, load/error
states, boundary decisions). Avoid noisy permanent logs, secrets, full payload
dumps, or logging inside animation/render loops. The logger
(`apps/desktop/src/logger.ts`) provides scopes and redaction. This is an explicit
repo convention (`AGENTS.md`), not optional polish.

## Release flows

### npm packages

`pnpm release:npm` (`scripts/release-npm.mjs`) orchestrates publishing the
workspace packages. Packages must build and pass `check`/`test` first.

### Desktop app

`pnpm release:desktop` (`apps/desktop/scripts/release-local.mjs`) does a
macOS-local build + packaging and creates a GitHub draft release.
`electron-builder` handles cross-platform packaging; bundled mode unpacks the
integration CLIs and bundles `plugins/official` as extra resources (verified by
the packaging contract — see [testing-and-validation.md](testing-and-validation.md)).

### Web catalog

Pet catalog deploys run from `web/` with Bun (`bun run deploy`). Catalog
generation/verification is in [catalog.md](catalog.md) and the runbooks under
`web/docs/`.

## Cross-platform & Linux testing

- An **Ubuntu 24.04 ARM64 VMware/Vagrant VM** exists for Linux GUI testing.
  Details and host-side commands are in `AGENTS.md` (VM dir
  `/Volumes/external/vmware/ubuntu24`; guest checkout `/home/vagrant/src/openpets`;
  helpers `cdpets` + `openpets-dx`). Use the **isolated guest clone**, never the
  mounted macOS checkout (platform-specific `node_modules`).
- Use the VM to validate Linux/Wayland renderer, tray, pet-window drag, IPC,
  plugin, and packaging behavior.
- **WSL** cross-platform IPC (WSL client → Windows host over private TCP) is part
  of the protocol — see [ipc.md](ipc.md).

## Code intelligence

This repo has a **CodeGraph** index (`.codegraph/`) and an MCP server
(`codegraph_*` tools) — a tree-sitter knowledge graph of every symbol/edge/file.
Prefer it for structural questions (who calls X, what breaks if I change Y, where
is Z defined) over grep. Read-only dependency clones for inspecting Electron /
KWin behavior live under `.slim/clonedeps/repos/` (do not edit). Both are
described in `AGENTS.md`.

## Conventions checklist

- Match surrounding code style; keep comment density and naming idiomatic.
- Update the matching `docs/*.md` and `codemap.md` when behavior changes.
- Honor forward-only direction: no legacy compat in current runtime paths.
- Validate at boundaries; atomic writes; reject path traversal/symlinks.
- For plugin/catalog/i18n changes, follow the explicit "update docs / run
  validators" rules in `AGENTS.md`.
</content>
