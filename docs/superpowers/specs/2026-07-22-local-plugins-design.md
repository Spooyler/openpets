# Local-Only Plugin System

Remove the remote plugin catalog and make all plugins local/bundled. Add a scaffold script for creating new plugins.

## Scope

**In scope:**
- Remove remote plugin catalog (openpets.dev fetch, ZIP download/install)
- Replace hardcoded `bundledOfficialPluginIds` with directory auto-scan
- Add `plugins/community/` to the scan roots
- Remove catalog-related UI (filter tab, install button, footer count, deprecated/disabled badges)
- Remove catalog pipeline scripts (`plugins:publish`, `plugins:deploy`, `plugins:release`, `plugins:package`, `plugins:check`)
- Create `pnpm create-plugin` scaffold script

**Out of scope:**
- Pet/sprite catalog (unchanged)
- Local plugin loading via `OPENPETS_DEV_PLUGIN_ROOTS` / `OPENPETS_DEV_PLUGIN_PATHS` (unchanged)
- Plugin manifest format, permission model, runtime, SDK bridge (unchanged)
- `plugins:test`, `plugins:locales` scripts (unchanged)

## Part 1: Catalog removal

### Files to delete

- `apps/desktop/src/plugin-catalog.ts` — remote catalog fetch
- `apps/desktop/src/plugin-catalog-validation.ts` — catalog entry types and validation

### Files to modify

**`apps/desktop/src/plugin-service.ts`:**
- Remove imports from `plugin-catalog.ts` and `plugin-catalog-validation.ts`
- Remove `PluginCatalogOptions` from `PluginServiceOptions`
- Remove fields: `catalogDisabled`, `catalogDeprecated`, `catalogStatusReason` from plugin records
- Remove methods: `installOrUpdateFromCatalog()`, `#updateCatalogMetadata()`, `snapshotCatalog()`
- Remove `disableCatalog` option and `#disableCatalog` field
- Remove catalog-related checks in `setEnabled()` (the `catalogDisabled` guard)
- Clean up `#seedBundledPluginFromSource()` — new records use `source: "bundled"` instead of `"catalog"`. Existing state records with `source: "catalog"` are overwritten on next seed, so no migration needed

**`apps/desktop/src/plugin-package.ts`:**
- Remove `downloadCatalogPluginZip()`, `readCatalogPluginManifestFromZip()`, `installCatalogPluginPackage()`
- Remove `validatePluginZipUrl()`
- Keep `safeDeletePluginInstallDir()` and `resolveSafePluginInstallDir()` (used by uninstall and stale cleanup)
- Remove `yauzl` ZIP dependency if nothing else uses it

**`apps/desktop/src/main.ts`:**
- Remove `OPENPETS_DISABLE_PLUGIN_CATALOG` env var check
- The `disableCatalog` parameter to `initializePluginService()` is removed along with the option

**`apps/desktop/src/windows.ts`:**
- Remove `openpets:plugins-install-catalog` IPC handler
- Remove catalog-related analytics events

**`apps/desktop/src/plugin-runtime.ts`:**
- Remove `catalogDisabled` check in plugin reload logic

**`apps/desktop/src/renderer/src/main.tsx`:**
- Remove `PluginFilter` value `"catalog"`
- Remove catalog install/update buttons and handlers
- Remove `SafeCatalogPluginRecord` type usage
- Remove catalog footer count display
- Remove `catalogDisabled`/`catalogDeprecated`/`catalogStatusReason` badge rendering
- Remove `updateCatalogEntry()` call

**`apps/desktop/src/local-ipc.ts`:**
- Remove catalog install analytics events if present

**`apps/desktop/src/analytics.ts`:**
- Remove `desktop_plugin_catalog_opened`, `desktop_catalog_fetch_failed`, catalog install/update event types

### Scripts to remove from `package.json`

- `plugins:check` — `node web/scripts/sync-plugins.js --dry-run --skip-r2`
- `plugins:package` — `node web/scripts/sync-plugins.js --skip-r2`
- `plugins:publish` — `node web/scripts/sync-plugins.js`
- `plugins:deploy` — `pnpm --dir web deploy`
- `plugins:release` — the composed pipeline
- `plugins:validate-release` and `plugins:validate-live` — release validators

Delete the underlying script files — `web/scripts/sync-plugins.js` and `scripts/validate-plugin-release.mjs` — they have no callers outside the removed scripts. Update `docs/testing-and-validation.md` to remove the `validate-plugin-release.mjs` reference.

## Part 2: Auto-scan replaces hardcoded list

### Current flow

```
bundledOfficialPluginIds (hardcoded array of 5 IDs)
  -> seedBundledPlugins() iterates the list
  -> #findBundledSourceFolder() looks in bundledPluginSourceDirs
  -> copies to AppData/plugins/
```

### New flow

```
resolveBundledOfficialPluginRoots() returns dirs (unchanged)
  -> seedBundledPlugins() scans each dir for subfolders with openpets.plugin.json
  -> reads manifest to get the ID
  -> copies to AppData/plugins/
```

### Changes

- Delete `bundledOfficialPluginIds` constant
- `seedBundledPlugins()` becomes a directory scan: for each root in `bundledPluginSourceDirs`, list subdirectories, check for `openpets.plugin.json`, read the manifest, seed
- `bundledEnabledByDefault` stays as a curated `Set<string>` — plugins not in this set install disabled
- `staleBundledPluginIds` stays as a cleanup list for removed plugins
- `resolveBundledOfficialPluginRoots()` in `main.ts` adds `plugins/community/` paths alongside `plugins/official/`

### Community plugins

`plugins/community/` directories are added to the bundled source roots in `resolveBundledOfficialPluginRoots()`. They are scanned and seeded identically to official plugins. The `publisherType` field in their manifests already distinguishes them.

## Part 3: Scaffold script

### Invocation

```
pnpm create-plugin openpets.my-plugin
```

### Implementation

A Node.js script at `scripts/create-plugin.mjs` using `readline` for interactive prompts. No external dependencies.

### Prompts

1. **Display name** — e.g. "My Plugin" (used for `$t:plugin.name` in `en.json`)
2. **Description** — short sentence (used for `$t:plugin.description` in `en.json`)
3. **Permissions** — multi-select from known set: `pet:speak`, `pet:interact`, `pet:move`, `pet:pin`, `schedule`, `storage`, `commands`, `events`, `audio`, `network`
4. **Include config schema example?** — yes/no

### ID validation

- Must match pattern `openpets.<name>` where `<name>` is lowercase alphanumeric + hyphens
- Must match the existing ID regex: `/^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$/`
- Refuses to overwrite an existing folder

### Generated files

```
plugins/official/<id>/
  openpets.plugin.json    # manifest v3, sdkVersion 3.0.0, selected permissions
  index.js                # minimal: register(), start(ctx)/stop(), one example command
  test.js                 # skeleton using createTestHarness from SDK
  assets/<short-name>.svg # placeholder icon (simple circle SVG)
  locales/en.json         # plugin.name + plugin.description keys
  locales/es-419.json     # stub with same keys, English values as placeholders
  locales/ja.json
  locales/ko.json
  locales/pt-BR.json
  locales/zh-Hans.json
  locales/zh-Hant.json
```

### package.json entry

```json
"create-plugin": "node scripts/create-plugin.mjs"
```

## Testing

- All existing plugin tests must pass after catalog removal (`pnpm plugins:test`)
- Type-check must pass (`pnpm typecheck` or equivalent)
- The scaffold script should be tested by generating a plugin and running `pnpm plugins:test` to verify the generated plugin's test passes
- Verify the app launches and seeds all plugins from both `plugins/official/` and `plugins/community/`

## Future consideration

If the plugin count grows or third-party contributions become common, consider a separate git repository for plugins rather than bundling everything in the monorepo. A git-based plugin repo is the more likely future direction (not a return to the openpets.dev catalog service).
