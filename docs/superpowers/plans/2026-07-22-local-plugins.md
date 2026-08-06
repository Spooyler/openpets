# Local-Only Plugin System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the remote plugin catalog, auto-scan all plugins from `plugins/official/` and `plugins/community/`, and add a `pnpm create-plugin` scaffold script.

**Architecture:** The remote catalog fetch, ZIP download/install, and all catalog-related UI are deleted. `bundledOfficialPluginIds` is replaced by directory auto-scan in `seedBundledPlugins()`. A new `scripts/create-plugin.mjs` generates plugin scaffolds interactively.

**Tech Stack:** TypeScript (Electron main process), React (renderer), Node.js (scaffold script)

## Global Constraints

- `yauzl` stays — used by pet installation, not plugin-only
- Pet/sprite catalog (`catalog.ts`, `catalog-validation.ts`, `petdex-catalog*.ts`) is untouched
- Local plugin loading via `OPENPETS_DEV_PLUGIN_ROOTS`/`OPENPETS_DEV_PLUGIN_PATHS` is untouched
- `plugins:test` and `plugins:locales` scripts are untouched
- `bundledEnabledByDefault` set stays as-is (curated list of auto-enabled plugins)
- `staleBundledPluginIds` stays as a cleanup mechanism for removed plugins

---

### Task 1: Remove catalog from plugin-state and plugin-service backend

**Files:**
- Modify: `apps/desktop/src/plugin-state.ts:8,16-36,182,207-209,219,238-240`
- Modify: `apps/desktop/src/plugin-service.ts:1-50,63-130,160-170,186-195,263-477,495-534,544-545`
- Delete: `apps/desktop/src/plugin-catalog.ts`
- Delete: `apps/desktop/src/plugin-catalog-validation.ts`

**Interfaces:**
- Produces: `PluginSource` changes from `"catalog" | "local"` to `"bundled" | "local"`. `PluginStateRecord` drops `catalogDisabled`, `catalogDeprecated`, `catalogStatusReason`. `SafePluginRecord` drops same three fields plus `SafeCatalogPluginRecord` and `PluginCatalogSnapshot` types are deleted. `PluginService` drops `getCatalogSnapshot()`, `installCatalog()`, `updateCatalog()`, `#installOrUpdateCatalog()`, `#updateCatalogMetadata()`. `PluginServiceOptions` drops `catalogOptions`, `disableCatalog`, `fetchImpl`. `initializePluginService()` drops `disableCatalog` param.

- [ ] **Step 1: Delete catalog files**

Delete `apps/desktop/src/plugin-catalog.ts` and `apps/desktop/src/plugin-catalog-validation.ts`.

- [ ] **Step 2: Update PluginSource type**

In `apps/desktop/src/plugin-state.ts:8`, change:
```typescript
export type PluginSource = "bundled" | "local";
```

- [ ] **Step 3: Remove catalog fields from PluginStateRecord**

In `apps/desktop/src/plugin-state.ts`, remove `catalogDisabled`, `catalogDeprecated`, `catalogStatusReason` from the `PluginStateRecord` type (lines 32-34), and remove the `PluginUpdateMetadata` type and `update` field (lines 10-14, 35) if it only served catalog updates.

- [ ] **Step 4: Remove catalog field parsing from plugin-state.ts**

Remove the `catalogDisabled`, `catalogDeprecated`, `catalogStatusReason` parsing in the deserialization function (around lines 207-209) and the serialization function (around lines 238-240). Update the source validation at line 182 (returns `null` on invalid) and line 219 (throws on invalid) to accept `"bundled"` instead of `"catalog"`.

Line 182 — deserialization (returns null for invalid records). Add backwards compat for existing state files:
```typescript
const source = value.source === "catalog" ? "bundled" : value.source;
if (source !== "bundled" && source !== "local") return null;
```
Then use `source` instead of `value.source` when building the record.

Line 219 — serialization (throws on invalid):
```typescript
if (record.source !== "bundled" && record.source !== "local") throw new Error("Invalid plugin state record.");
```

- [ ] **Step 5: Remove catalog imports and types from plugin-service.ts**

Remove lines 4-5 (imports from `plugin-catalog.ts` and `plugin-catalog-validation.ts`). Remove `downloadCatalogPluginZip`, `installCatalogPluginPackage`, `readCatalogPluginManifestFromZip` from the `plugin-package.ts` import (line 14) — keep only `resolveSafePluginInstallDir`. Remove `catalogDisabled`, `catalogDeprecated`, `catalogStatusReason` from `SafePluginRecord` (lines 36-38). Delete `SafeCatalogPluginRecord` type (line 49) and `PluginCatalogSnapshot` type (line 50).

- [ ] **Step 6: Remove catalog options from PluginServiceOptions and constructor**

Remove `catalogOptions` (line 69), `disableCatalog` (line 74), and `fetchImpl` (line 70) from `PluginServiceOptions`. Remove corresponding private fields `#catalogOptions` (line 95), `#disableCatalog` (line 98) and their constructor assignments (lines 113, 116). Remove `#fetchImpl` field and assignment only if it's not used elsewhere (check — it's used in catalog methods which are being removed).

- [ ] **Step 7: Remove catalog methods from PluginService**

Delete these methods entirely:
- `getCatalogSnapshot()` (lines 263-273)
- `installCatalog()` (lines 275-277)
- `updateCatalog()` (lines 279-283)
- `#installOrUpdateCatalog()` (lines 413-453)
- `#updateCatalogMetadata()` (lines 471-477)

- [ ] **Step 8: Remove catalog guard in setEnabled()**

In `setEnabled()` (around line 191), remove:
```typescript
if (enabled && record.catalogDisabled) return this.#error("Plugin is disabled in the catalog.");
```

- [ ] **Step 9: Remove catalog guard in loadLocalPath()**

In `loadLocalPath()` (around line 327), remove:
```typescript
if (existing?.source === "catalog") return this.#error("A catalog plugin with this id is already installed.");
```

- [ ] **Step 10: Update #safeRecord to drop catalog fields**

In `#safeRecord()` (line 457), remove `catalogDisabled`, `catalogDeprecated`, `catalogStatusReason` from the `base` object.

- [ ] **Step 11: Change seedBundledPluginFromSource to use source: "bundled"**

In `#seedBundledPluginFromSource()` (line 533), change `source: "catalog"` to `source: "bundled"` in the `upsertRecord` call.

- [ ] **Step 12: Update initializePluginService signature**

In `initializePluginService()` (line 544), remove the `disableCatalog` parameter. Update the call site in `main.ts` (line 93) — remove the `process.env.OPENPETS_DISABLE_PLUGIN_CATALOG === "1" || devPluginMode` argument.

- [ ] **Step 13: Remove catalogDisabled check from plugin-runtime.ts**

In `apps/desktop/src/plugin-runtime.ts:109`, change:
```typescript
if (!record || !record.enabled || record.catalogDisabled) { ... }
```
to:
```typescript
if (!record || !record.enabled) { ... }
```
Update the reason ternary to remove the `"catalog-disabled"` branch.

- [ ] **Step 14: Type-check**

Run: `npx tsc --noEmit -p apps/desktop/tsconfig.json` (or the project's typecheck command)
Expected: PASS with no type errors

- [ ] **Step 15: Commit**

```bash
git add -A apps/desktop/src/plugin-catalog.ts apps/desktop/src/plugin-catalog-validation.ts apps/desktop/src/plugin-state.ts apps/desktop/src/plugin-service.ts apps/desktop/src/plugin-runtime.ts apps/desktop/src/main.ts
git commit -m "Remove remote plugin catalog backend"
```

---

### Task 2: Remove catalog from plugin-package.ts, windows.ts, analytics, and IPC

**Files:**
- Modify: `apps/desktop/src/plugin-package.ts:1-90`
- Modify: `apps/desktop/src/windows.ts:330-357,707-720`
- Modify: `apps/desktop/src/analytics.ts:1-40`
- Modify: `apps/desktop/src/local-ipc.ts` (catalog analytics)

**Interfaces:**
- Consumes: `PluginService` no longer has `installCatalog()`, `updateCatalog()`, `getCatalogSnapshot()` (Task 1)
- Produces: `pluginTelemetryForSnapshot()` and plugin IPC handlers remain for non-catalog operations (enable/disable/uninstall/local)

- [ ] **Step 1: Remove catalog functions from plugin-package.ts**

Remove these functions:
- `downloadCatalogPluginZip()` (line 20-25)
- `validatePluginZipUrl()` (line 27)
- `readCatalogPluginManifestFromZip()` (lines 29-53)
- `installCatalogPluginPackage()` (lines 56 onward — keep `safeDeletePluginInstallDir`, `resolveSafePluginInstallDir`)

Remove the `PluginCatalogEntry`/`PluginCatalogEntryV2` type import from `plugin-catalog-validation.ts` (line 7) and the `AnyPluginCatalogEntry` type alias (line 18). Remove the `SUPPORTED_LOCALES` import from `i18n/catalog.js` (line 6) if only used by catalog functions. Keep the `yauzl` import if `readPluginZipFiles` is still used by remaining code; otherwise remove.

Check: does anything else in `plugin-package.ts` import from `plugin-catalog-validation.ts`? If `readPluginZipFiles` is only used by `readCatalogPluginManifestFromZip` and `installCatalogPluginPackage`, it can be removed too.

- [ ] **Step 2: Remove catalog IPC handlers from windows.ts**

Remove these three IPC handlers (lines 330-357):
- `openpets:plugins-catalog-snapshot`
- `openpets:plugins-install-catalog`
- `openpets:plugins-update-catalog`

Remove `isCatalogPluginInstalled()` helper (line 717-720) if it's only used by the catalog handlers.

Remove the catalog-related imports (getCatalogSnapshot, etc.) if they become unused.

- [ ] **Step 3: Remove catalog analytics events**

In `apps/desktop/src/analytics.ts`, remove these event types from the `DesktopAnalyticsEvent` union:
- `"desktop_plugin_catalog_opened"` (line 28)
- `"desktop_catalog_fetch_failed"` (line 38)

Keep `"desktop_plugin_install_started"`, `"desktop_plugin_installed"`, `"desktop_plugin_install_failed"` — these are still used for local plugin install tracking.

- [ ] **Step 4: Remove catalog analytics from local-ipc.ts**

Check `apps/desktop/src/local-ipc.ts` for any catalog-specific analytics calls (lines 649-655 reference `source: "catalog"` for pet installs — those are pet catalog, not plugin catalog, so leave them). Only remove plugin-catalog-specific events if any exist.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p apps/desktop/tsconfig.json`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/plugin-package.ts apps/desktop/src/windows.ts apps/desktop/src/analytics.ts apps/desktop/src/local-ipc.ts
git commit -m "Remove catalog IPC handlers, analytics events, and ZIP download"
```

---

### Task 3: Remove catalog from renderer UI

**Files:**
- Modify: `apps/desktop/src/renderer/src/main.tsx:39,65-70,91,760,1236,1999-2027,2033-2038,2898-2933,3021,3038-3082,3103-3168,3205,3261,3367,3521,3716`

**Interfaces:**
- Consumes: `SafeCatalogPluginRecord`, `PluginCatalogSnapshot` types no longer exist (Task 1). IPC handlers `plugins-catalog-snapshot`, `plugins-install-catalog`, `plugins-update-catalog` no longer exist (Task 2).

- [ ] **Step 1: Remove catalog types and API method**

Remove `SafeCatalogPluginRecord` type (line 65), `PluginCatalogSnapshot` type (line 67). Simplify `PluginEntry` type (line 70) — remove `catalog?: SafeCatalogPluginRecord` field:
```typescript
type PluginEntry = { id: string; installed?: SafePluginRecord };
```
Remove `getPluginCatalogSnapshot` from the API interface (line 91).

- [ ] **Step 2: Remove catalog filter**

Change `PluginFilter` type (line 39) — remove `"catalog"`:
```typescript
type PluginFilter = "all" | "installed" | "local" | "broken";
```

Remove the `"catalog"` option from the filter tab rendering (around line 3021).

- [ ] **Step 3: Remove catalog state and fetching**

Remove the `catalog` state (`useState<PluginCatalogSnapshot | null>`) around line 2898. Remove the `getPluginCatalogSnapshot` call in the data-fetching effect (around line 2913). Remove `catalogPlugin` variable assignment (around line 2933).

- [ ] **Step 4: Simplify mergePluginEntries**

In `mergePluginEntries()` (line 2033), remove the catalog merging loop (lines 2036-2038). The function now just maps installed plugins:
```typescript
function mergePluginEntries(snapshot: PluginServiceSnapshot | null): PluginEntry[] {
  const merged = new Map<string, PluginEntry>();
  for (const plugin of snapshot?.plugins ?? []) {
    merged.set(plugin.id, { id: plugin.id, installed: plugin });
  }
  return Array.from(merged.values());
}
```

- [ ] **Step 5: Remove catalog display helpers**

Remove all `catalogPlugin` references in the detail/inspector pane:
- The version fallback (`installed?.version ?? catalogPlugin?.version`) — just use `installed?.version` (line 3103)
- The community badge (`catalogPlugin?.publisherType`) (line 3105)
- The deprecated badge (`catalogPlugin?.deprecated`) (line 3107)
- The status strip (`catalogPlugin?.statusReason`) (lines 3109-3111)
- The catalog update button (line 3161)
- The catalog permissions display (line 3167)
- The catalog install button (line 3168)
- `catalogDisabled`/`catalogDeprecated`/`catalogStatusReason` badge rendering (lines 2019, 2027, 3056, 3117-3118)

- [ ] **Step 6: Remove catalog footer count**

Remove the catalog count from the footer (around line 3082) — change to just show installed count.

- [ ] **Step 7: Remove install-from-catalog and update-catalog handlers**

Remove the `installCatalogEntry()` and `updateCatalogEntry()` handler functions. These call the deleted IPC channels.

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit -p apps/desktop/tsconfig.json`
Expected: PASS

- [ ] **Step 9: Run plugin tests**

Run: `pnpm plugins:test`
Expected: All tests pass (plugin tests don't test the catalog UI)

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/renderer/src/main.tsx
git commit -m "Remove catalog UI from control center"
```

---

### Task 4: Auto-scan plugins instead of hardcoded bundled list

**Files:**
- Modify: `apps/desktop/src/plugin-service.ts:82-84,160-170,495-501`
- Modify: `apps/desktop/src/main.ts:139-141`

**Interfaces:**
- Consumes: `OPENPETS_PLUGIN_MANIFEST_FILENAME` from `plugin-manifest.ts`, `readLocalPluginSourceManifest` from `plugin-local-loader.ts`
- Produces: `seedBundledPlugins()` now auto-scans directories instead of iterating a hardcoded list. `resolveBundledOfficialPluginRoots()` returns roots for both `plugins/official/` and `plugins/community/`.

- [ ] **Step 1: Remove bundledOfficialPluginIds**

Delete the `bundledOfficialPluginIds` constant and its export (line 82). Keep `bundledEnabledByDefault` (line 83) and `staleBundledPluginIds` (line 84) — add any previously-catalog-only plugin IDs to `staleBundledPluginIds` if needed.

- [ ] **Step 2: Rewrite seedBundledPlugins() to auto-scan**

Replace the current `seedBundledPlugins()` (lines 160-169) with directory scanning:

```typescript
async seedBundledPlugins(): Promise<void> {
  if (!this.#userDataPath) return;
  await this.#pruneStaleBundledPlugins();
  for (const root of this.#bundledPluginSourceDirs) {
    let entries: string[];
    try {
      const dirents = await fs.readdir(root, { withFileTypes: true });
      entries = dirents
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => join(root, d.name));
    } catch { continue; }
    for (const sourceFolder of entries) {
      if (!existsSync(join(sourceFolder, OPENPETS_PLUGIN_MANIFEST_FILENAME))) continue;
      try {
        const source = await readLocalPluginSourceManifest({ sourceFolder, maxManifestBytes: this.#maxManifestBytes });
        await this.#seedBundledPluginFromSource(sourceFolder, source.manifest.id);
      } catch (error) {
        this.#log("warn", "Bundled plugin seed failed.", { sourceFolder, reason: safeError(error) });
      }
    }
  }
}
```

- [ ] **Step 3: Remove #findBundledSourceFolder**

Delete the `#findBundledSourceFolder()` method (lines 495-501) — it's no longer used since `seedBundledPlugins()` now scans directly.

- [ ] **Step 4: Add community roots to resolveBundledOfficialPluginRoots**

In `apps/desktop/src/main.ts:139-141`, add `plugins/community` candidates:

```typescript
function resolveBundledOfficialPluginRoots(): string[] {
  const candidates = [
    join(process.resourcesPath, "plugins", "official"),
    resolve(process.cwd(), "plugins", "official"),
    resolve(app.getAppPath(), "..", "..", "plugins", "official"),
    join(process.resourcesPath, "plugins", "community"),
    resolve(process.cwd(), "plugins", "community"),
    resolve(app.getAppPath(), "..", "..", "plugins", "community"),
  ];
  return Array.from(new Set(candidates.filter((candidate) => existsSync(candidate))));
}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p apps/desktop/tsconfig.json`
Expected: PASS

- [ ] **Step 6: Run plugin tests**

Run: `pnpm plugins:test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/plugin-service.ts apps/desktop/src/main.ts
git commit -m "Auto-scan plugin directories instead of hardcoded bundled list"
```

---

### Task 5: Remove catalog pipeline scripts and docs references

**Files:**
- Modify: `package.json` (remove 7 scripts)
- Delete: `scripts/validate-plugin-release.mjs`
- Modify: `docs/testing-and-validation.md` (remove validate-plugin-release reference)
- Modify: `docs/plugins.md` (remove catalog/publishing references)

**Interfaces:**
- No code dependencies — these are scripts and docs only.

- [ ] **Step 1: Remove scripts from package.json**

Remove these entries from the `"scripts"` section:
- `"plugins:check"`
- `"plugins:package"`
- `"plugins:publish"`
- `"plugins:deploy"`
- `"plugins:release"`
- `"plugins:validate-release"`
- `"plugins:validate-live"`

Keep `"plugins:test"` and `"plugins:locales"`.

- [ ] **Step 2: Delete validate-plugin-release.mjs**

Delete `scripts/validate-plugin-release.mjs`.

- [ ] **Step 3: Update docs/testing-and-validation.md**

Remove the "Plugin release validation (production gate)" section (around line 92) that references `scripts/validate-plugin-release.mjs`. Replace with a note that plugin validation happens at build time via `plugins:test` and `plugins:locales`.

- [ ] **Step 4: Update docs/plugins.md**

In the "Source lanes" section (lines 19-27), update to reflect the new model:
- `plugins/official/` — first-party plugins, auto-scanned and bundled on launch
- `plugins/community/` — community plugins, also auto-scanned and bundled
- `plugins/dev/` — local experiments only

Remove any references to the catalog generator, ZIP/SHA/catalog pipeline, or publishing to openpets.dev. Keep the rest of the doc (manifest format, permissions, runtime, etc.) unchanged.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/validate-plugin-release.mjs docs/testing-and-validation.md docs/plugins.md
git commit -m "Remove catalog pipeline scripts and update docs"
```

---

### Task 6: Create the scaffold script

**Files:**
- Create: `scripts/create-plugin.mjs`
- Modify: `package.json` (add `create-plugin` script)

**Interfaces:**
- Produces: A working plugin scaffold in `plugins/official/<id>/` that passes `pnpm plugins:test`

- [ ] **Step 1: Write the scaffold script**

Create `scripts/create-plugin.mjs`:

```javascript
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv } from "node:process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const KNOWN_PERMISSIONS = [
  "pet:speak", "pet:interact", "pet:move", "pet:pin",
  "schedule", "storage", "commands", "events", "audio", "network",
];

const LOCALES = ["en", "es-419", "ja", "ko", "pt-BR", "zh-Hans", "zh-Hant"];

const ID_PATTERN = /^openpets\.[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

async function main() {
  const id = argv[2];
  if (!id) { console.error("Usage: pnpm create-plugin <id>\nExample: pnpm create-plugin openpets.my-plugin"); process.exit(1); }
  if (!ID_PATTERN.test(id)) { console.error(`Invalid plugin ID: "${id}". Must match openpets.<lowercase-alphanumeric-hyphens>.`); process.exit(1); }

  const pluginDir = resolve("plugins/official", id);
  if (existsSync(pluginDir)) { console.error(`Plugin directory already exists: ${pluginDir}`); process.exit(1); }

  const rl = createInterface({ input: stdin, output: stdout });
  const shortName = id.replace("openpets.", "");

  const displayName = await rl.question("Display name: ");
  if (!displayName.trim()) { console.error("Display name is required."); process.exit(1); }

  const description = await rl.question("Description: ");
  if (!description.trim()) { console.error("Description is required."); process.exit(1); }

  console.log(`\nAvailable permissions: ${KNOWN_PERMISSIONS.join(", ")}`);
  const permInput = await rl.question("Permissions (comma-separated, or empty for none): ");
  const permissions = permInput.trim()
    ? permInput.split(",").map((p) => p.trim()).filter((p) => KNOWN_PERMISSIONS.includes(p))
    : [];

  const includeConfig = (await rl.question("Include config schema example? (y/N): ")).trim().toLowerCase() === "y";
  rl.close();

  const manifest = {
    manifestVersion: 3,
    id,
    name: "$t:plugin.name",
    description: "$t:plugin.description",
    version: "1.0.0",
    runtime: "javascript",
    icon: "plugin",
    sdkVersion: "3.0.0",
    entry: "index.js",
    assets: { icons: { [shortName]: `assets/${shortName}.svg` } },
    permissions: ["pet:speak", "commands", ...permissions.filter((p) => p !== "pet:speak" && p !== "commands")],
  };
  if (includeConfig) {
    manifest.configSchema = {
      exampleToggle: {
        type: "boolean",
        default: false,
        label: "$t:config.exampleToggle.label",
        description: "$t:config.exampleToggle.description",
      },
    };
  }

  const indexJs = `export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      await ctx.commands.register(
        {
          id: "hello",
          title: "$t:command.hello.title",
          description: "$t:command.hello.description",
          icon: "${shortName}",
        },
        async () => {
          await ctx.pet.speak(ctx.t("speech.hello"));
        },
      );
    },
    async stop() {},
  });
}
`;

  const testJs = `import assert from "node:assert/strict";
import { register } from "./index.js";

let createTestHarness;
try {
  ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing"));
} catch {
  ({ createTestHarness } = await import(
    new URL("../../../packages/sdk/dist/testing.js", import.meta.url)
  ));
}

const PERMISSIONS = ${JSON.stringify(manifest.permissions)};
const LOCALES = {
  en: JSON.parse(
    await (await import("node:fs/promises")).readFile(
      new URL("./locales/en.json", import.meta.url),
      "utf8",
    ),
  ),
};

const harness = createTestHarness({ permissions: PERMISSIONS, locales: LOCALES });
register(harness.OpenPetsPlugin);
await harness.start();

assert.ok(harness.commands.has("hello"), "hello command should be registered");

await harness.stop();
console.log("All tests passed.");
`;

  const enLocale = {
    "plugin.name": displayName,
    "plugin.description": description,
    "command.hello.title": "Say hello",
    "command.hello.description": "Make the pet say hello.",
    "speech.hello": "Hello from ${displayName}!",
  };
  if (includeConfig) {
    enLocale["config.exampleToggle.label"] = "Example toggle";
    enLocale["config.exampleToggle.description"] = "An example configuration toggle.";
  }

  const stubLocale = { "plugin.name": displayName, "plugin.description": description };

  const placeholderSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>`;

  await mkdir(join(pluginDir, "assets"), { recursive: true });
  await mkdir(join(pluginDir, "locales"), { recursive: true });
  await writeFile(join(pluginDir, "openpets.plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(pluginDir, "index.js"), indexJs);
  await writeFile(join(pluginDir, "test.js"), testJs);
  await writeFile(join(pluginDir, `assets/${shortName}.svg`), placeholderSvg);
  for (const locale of LOCALES) {
    const content = locale === "en" ? enLocale : stubLocale;
    await writeFile(join(pluginDir, `locales/${locale}.json`), JSON.stringify(content, null, 2) + "\n");
  }

  console.log(`\nPlugin scaffolded at ${pluginDir}`);
  console.log("Next steps:");
  console.log("  1. Edit index.js to add your plugin logic");
  console.log("  2. Run: pnpm plugins:test");
  console.log("  3. Set OPENPETS_DEV_PLUGIN_ROOTS to plugins/official for hot-reload");
}

main().catch((error) => { console.error(error.message); process.exit(1); });
```

- [ ] **Step 2: Add script to package.json**

Add to `"scripts"`:
```json
"create-plugin": "node scripts/create-plugin.mjs"
```

- [ ] **Step 3: Test the scaffold**

Run:
```bash
pnpm create-plugin openpets.test-scaffold
```
Enter: display name "Test Scaffold", description "A test plugin.", permissions "pet:speak,commands", no config.

Verify the generated files exist and the test passes:
```bash
pnpm plugins:test
```

- [ ] **Step 4: Clean up test scaffold**

Delete the generated test plugin:
```bash
rm -rf plugins/official/openpets.test-scaffold
```

- [ ] **Step 5: Commit**

```bash
git add scripts/create-plugin.mjs package.json
git commit -m "Add pnpm create-plugin scaffold script"
```

---

### Task 7: Update codemap and final verification

**Files:**
- Modify: `apps/desktop/src/codemap.md` (remove catalog references)
- Modify: `docs/plugins.md` (if not fully updated in Task 5)

- [ ] **Step 1: Update codemap.md**

In `apps/desktop/src/codemap.md`, remove references to `plugin-catalog.ts`, `plugin-catalog-validation.ts`, the catalog fetch URL, and plugin ZIP download from openpets.dev. Update the plugin-service description to mention auto-scan instead of bundled list.

- [ ] **Step 2: Full test suite**

Run:
```bash
pnpm plugins:test
```
Expected: All tests pass

- [ ] **Step 3: Type-check entire project**

Run the project's typecheck command.
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/codemap.md
git commit -m "Update codemap for local-only plugin system"
```
