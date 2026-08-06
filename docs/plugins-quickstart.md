# Plugins — Quick Reference

For the full platform architecture, see [plugins.md](plugins.md).
For the SDK API, see [sdk.md](sdk.md).

## Where plugins live

```
plugins/
  official/          ← first-party plugins, auto-loaded on launch
    openpets.water-reminder/
    openpets.reminders/
    ...
  community/         ← community plugins, also auto-loaded
    openpets.walkabout/
    ...
  dev/               ← local experiments (not auto-loaded)
```

On launch the app scans `plugins/official/` and `plugins/community/`, finds
every folder with an `openpets.plugin.json`, and copies it to the user's
AppData. That's the entire install mechanism — no remote catalog, no downloads.

## Plugin anatomy

```
openpets.my-plugin/
  openpets.plugin.json   ← manifest (id, permissions, config, assets)
  index.js               ← entry point: register(), start(ctx), stop()
  test.js                ← tests using the SDK test harness
  assets/my-plugin.svg   ← icon
  locales/
    en.json              ← English strings ($t: references)
    es-419.json           ← locale stubs (7 locales total)
    ja.json
    ko.json
    pt-BR.json
    zh-Hans.json
    zh-Hant.json
```

## Creating a new plugin

```bash
pnpm create-plugin openpets.my-plugin
```

Prompts for display name, description, permissions, and whether to include a
config schema example. Generates the full folder in `plugins/official/`.

## Developing

Set the env var for hot-reload (changes take effect without restart):

```bash
OPENPETS_DEV_PLUGIN_ROOTS=plugins/official
```

Or rebuild + restart the app (the bundled seeding copies your source on launch).

## Testing

```bash
pnpm plugins:test        # all plugin test suites + locale checks
```

Each plugin has a `test.js` that uses the SDK test harness:

```javascript
import { register } from "./index.js";

let createTestHarness;
try {
  ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing"));
} catch {
  ({ createTestHarness } = await import(
    new URL("../../../packages/sdk/dist/testing.js", import.meta.url)
  ));
}

const harness = createTestHarness({ permissions: [...], locales: { en: ... } });
register(harness.OpenPetsPlugin);
await harness.start();
// assertions here
await harness.stop();
```

## Key concepts

**Manifest** (`openpets.plugin.json`): Declares id, version, permissions,
config schema, assets. Validated before any code runs.

**Permissions**: Plugins only get capabilities they declare — `pet:speak`,
`schedule`, `storage`, `commands`, `audio`, `network`, etc.

**Config schema**: Typed fields (`boolean`, `number`, `select`, `text`, `sound`,
etc.) rendered as a settings form in the Control Center. Use `$t:` references
for labels.

**Localization**: All user-facing strings go through `$t:key` references
resolved from `locales/*.json`.

**Lifecycle**: `register()` is called once. Inside it, call
`OpenPetsPlugin.register({ start(ctx), stop() })`. The `ctx` object provides
the SDK — `ctx.pet.speak()`, `ctx.schedule.once()`, `ctx.storage.get()`,
`ctx.commands.register()`, `ctx.ui.alert()`, etc.
