# Plugin Platform

OpenPets plugins are small companion programs that extend the pet: reminders,
focus timers, a Tamagotchi-style virtual pet, a Claude usage HUD, and so on.
This doc is the platform architecture — the manifest contract, the permission
model, the runtime and sandbox, install paths, and packaging. For the
*author-facing* API see [sdk.md](sdk.md); for the product direction and the
official lineup see [superplugins.md](superplugins.md).

This doc is required reading before changing plugin platform code, official
plugins, packaging, runtime behavior, or plugin-facing UI
(per `AGENTS.md`). When you change behavior, update this doc in the same change.

Source maps: `apps/desktop/src/codemap.md` (the `plugin-*.ts` modules),
`plugins/codemap.md`, `plugins/official/codemap.md`, `packages/sdk/codemap.md`.

## Source lanes

Plugin source is split by intent:

- `plugins/official/` — first-party, reviewed OpenPets plugins. Auto-scanned and
  bundled on launch.
- `plugins/community/` — community plugins. Also auto-scanned and bundled on
  launch through the same bundled-root resolution in `apps/desktop/src/main.ts`.
  Note that the packaged app's extra resources (`apps/desktop/electron-builder.yml`)
  currently copy only `plugins/official`.
- `plugins/dev/` — local experiments only. Not auto-scanned; use
  `OPENPETS_DEV_PLUGIN_ROOTS` to load these during development.

## Mental model

A plugin is a **package** validated by a **manifest**, run inside a **sandbox**,
talking to the host only through a **permission-checked SDK bridge**. The host
owns every side effect — the plugin only *describes* what it wants (a bubble, an
alert, a scheduled job, a stored value), and the host validates and renders it.
This is the "companion-first" stance: plugins never inject UI into pet windows
directly; they hand the host descriptors and the host owns layout and lifecycle.

```
openpets.plugin.json ──validate──▶ plugin-service ──▶ plugin-runtime
                                                          │
                              ┌───────────────────────────┤
                              ▼                            ▼
                    declarative timers           plugin-js-host (sandbox)
                              │                            │  SDK calls (IPC, tokened)
                              └────────────┬───────────────┘
                                           ▼
                                  plugin-sdk-bridge
                          (permission + quota checks, then dispatch)
                                           ▼
              pet · schedule · storage · ui · audio · events · bus · ai · …
```

## The manifest — `openpets.plugin.json`

The manifest is the contract the host validates before *any* plugin code runs
(`plugin-manifest.ts`, schema versions v1/v2/v3). Current plugins are
`manifestVersion: 3` / `sdkVersion: 3.x`. Key fields:

- `manifestVersion`, `id` (e.g. `openpets.reminders`), `name`, `description`,
  `version`, `sdkVersion`.
- `runtime`: `javascript` for SDK plugins (declarative timer-only plugins also
  exist for the simplest cases).
- `entry`: the JS entry file (e.g. `index.js`).
- `permissions`: the capabilities the plugin requests (see below).
- `configSchema`: typed config fields rendered as a no-JSON settings form.
  Fields include text, number, boolean, select, time, date, secret, and sound;
  a select can opt into the host's `sprite-grid` presentation when every option
  references a declared sprite preview.
- `assets`: declared icon/image/svg/sprite/sound refs (validated, see below).
- `commands`, `status`, `panels`, `network` hosts, and timer triggers as
  applicable.
- Localization: `name`/`description`/labels can be `$t:` keys resolved from
  `locales/en.json` (see [i18n.md](i18n.md)).

`name`/`description`/labels in the manifest use `$t:` references; a key missing
from `locales/en.json` shows up raw on the Plugins page.

Plugin card icons can use bundled SVG assets. A plugin declares the SVG under
`assets.icons`; `plugin-service.ts` reads the declared, size-capped SVG from the
installed plugin and hands it to the Plugins page as `iconDataUrl`. Do **not**
use external SVG URLs for plugin icons — the icon must be part of the plugin
folder.

### Manifest reading is hardened

`plugin-manifest-reader.ts` enforces realpath/allowed-root checks, requires the
manifest to be the root file, caps size, and matches the expected id/version.
The manifest is never trusted blindly.

## Permission model

### Sprite-grid configuration

`sprite-grid` is a presentation for a `select` field, not a general renderer
surface. Each option names a manifest-declared sprite as its preview; manifest
validation rejects undeclared previews. The Control Center renders those choices
as accessible radio cards, with animation only for the selected, hovered, or
keyboard-focused card. `prefers-reduced-motion` keeps the first frame static.

Calendar Airmail uses this for its courier choice. The couriers are bundled
plugin assets, not installed pets: changing the selection never reads the pet
catalog, changes the default pet, or depends on a user-installed companion.

Permissions are declared in the manifest, **approved** by the user at install,
persisted in plugin state, and **re-checked on every SDK call** by the bridge.
The permission surface (from `plugin-manifest.ts`):

`timer`/`schedule`, `pet:*`, `pets:*`, `audio`, `events`, `ui:*`, `notify`,
`bus`, `ai`, `secrets`, `voice:*`, `auth`, `files`, `system:*`, `clipboard`,
`network:*`.

A plugin that calls a namespace it didn't declare (or wasn't approved for) is
denied and the block is recorded in diagnostics. `network:*` is further
constrained to declared hosts. This is defense in depth: manifest validation,
user approval, runtime permission check, and quotas all apply.

### Display deliveries

`ui:delivery` is a dedicated permission for the generic, host-owned delivery
surface. It lets a plugin request a short, plain-text delivery with one of its
own declared courier sprites; it is not permission to position windows, inject
markup, select arbitrary files, or control animation. The host chooses the cursor
display, renders the courier and banner together, queues competing deliveries,
enforces expiry and quotas, and owns the window lifecycle. The returned handle
can be dismissed and can observe `click`, `manual`, `expired`, or
`plugin-stopped` dismissal. Plugin teardown
removes that plugin's pending and active deliveries without calling handlers in
the stopped host. See [sdk.md](sdk.md) for the author contract.

This surface is intended for time-sensitive companion messages such as Calendar
Airmail, not as a general custom-overlay API.

## Runtime & sandbox

`plugin-runtime.ts` is the engine:

- Compiles **declarative timer triggers** for enabled manifests and schedules
  cancellable timers.
- Starts/stops a **JavaScript host** per JS plugin and verifies approved
  permissions before dispatching actions.
- Exposes public **command/status** state to the UI, validates actions, and
  **marks a plugin broken** on validation/action failure (surfaced in the
  inspector/health UI).

`plugin-js-host.ts` is the sandbox: a hidden `BrowserWindow` with a per-plugin
session partition, navigation/window-open hardening, an SDK IPC **token**, a
registration handshake at startup, config-listener cleanup, and teardown. The
plugin's `index.js` runs here, isolated from the renderer and the main process.

`plugin-sdk-bridge.ts` is the gate between the sandbox and the host. It
validates routes, builds the per-plugin context, enforces permissions + quotas,
and delegates to focused namespace modules (`plugin-sdk-audio`, `-bus`,
`-config`, `-events`, `-quotas`, `-routes`, `-state`, `-storage`, `-ui`, plus
`plugin-voice`, `plugin-oauth`, `plugin-secrets`, `plugin-ai-gateway`,
`plugin-panels`, `plugin-pet-api`/`plugin-pet-registry`). The split keeps each
capability's permission check and host effect localized. The author-facing
mirror of all this is the SDK in [sdk.md](sdk.md).

### Supporting modules

- `plugin-state.ts` — atomic JSON store (`userData/openpets-plugin-state.json`):
  installed plugins, enabled flag, approved permissions, config, source, broken
  reason, update metadata.
- `plugin-config.ts` — default/effective config validation and reference
  resolution.
- `plugin-assets.ts` — validates/resolves declared assets (formats + size caps)
  for SDK refs and plugin cards. Courier sprites are WebP strips with bounded,
  declared frame metadata; their dimensions are checked at package/install time.
- `plugin-bubble-arbiter.ts` — priority/coalescing of transient vs pinned bubble
  slots.
- `plugin-diagnostics.ts` — per-plugin error/quota/settings-block collector for
  the inspector and health UI.
- `plugin-platform-settings.ts` — global gates for audio, voice, speech,
  microphone, quiet hours, and AI provider choices.
- `plugin-user-sound-store.ts` — stores imported user sounds as opaque refs, not
  raw filesystem paths.
- `plugin-i18n.ts` — resolves plugin locales, manifest `$t:`, and `ctx.t()`.

## Install paths

### Bundled seeding

There is no remote plugin catalog or download path. On launch (outside dev
plugin mode) `plugin-service.ts` scans each bundled root that `main.ts`
resolves, validates every plugin folder's manifest, and copies the manifest,
entry, and declared files into `userData/plugins/{id}`, recording the plugin as
bundled. Bundled plugins cannot be uninstalled, only disabled; a re-seed keeps
the user's existing enabled flag and config, and first-seen plugins get their
default from `bundledEnabledByDefault`. Ids in `staleBundledPluginIds` are
pruned from the profile. `plugin-package.ts` owns safe install-directory
resolution and deletion.

### Local development

`plugin-local-loader.ts` validates a selected local folder and snapshots the
manifest, entry file, and declared assets into `userData/plugins-dev/{id}`, with
symlink/path/size protections. In the installed desktop app, authors use
**Plugins → Developer Mode → Load unpacked plugin folder**; OpenPets persists the
original source folder, watches it, and re-snapshots/reloads after edits. The
repo dev build still supports maintainer-only env paths with
`OPENPETS_DEV_PLUGIN_ROOTS` / `OPENPETS_DEV_PLUGIN_PATHS` and
`pnpm dev:desktop:plugins`. See [development.md](development.md).

## Authoring workflow (end to end)

1. **Scaffold**: `openpets plugin new <name> --template <blank|reminder|ambient|ai-chat|tamagotchi|calendar>`
   generates a `manifestVersion: 3` package with `index.js`, `test.js`, README,
   and `locales/en.json`. (`packages/cli/src/plugin-templates.ts`.)
2. **Develop**: write against the SDK ([sdk.md](sdk.md)); hot-load via dev mode.
3. **Test**: `test.js` uses `@open-pets/plugin-sdk/testing` to fake time/events
   and assert descriptor-level effects — no Electron. See [sdk.md](sdk.md).
4. **Validate**: `openpets plugin validate <dir>` checks manifest, permissions,
   SDK compatibility, config field types, network hosts, asset formats/size
   caps, entry files, and HTML panels. (`packages/cli/src/plugin-validate.ts`.)
5. **Ship**: commit the folder; it is bundled with the app (see below).

### Calendar Airmail

`openpets.calendar-airmail` is the official Google Calendar companion. Its
configuration selects one of its bundled courier sprites in an animated,
reduced-motion-aware sprite grid; the default is AirDog. This replaces the
previous installed-pet selection: legacy `pet` configuration is ignored, and a
missing or invalid courier resolves to the declared default rather than a pet
fallback. It reads the user's **primary calendar** only, expands recurring
instances, and deliberately omits all-day events in this first release. It
delivers an airmail reminder ten minutes before an event and again at its start.

Connection begins only from the plugin's explicit sign-in command. The official
Google Cloud **Desktop app** OAuth credential used for the release includes its
client ID and the client secret required by Google's token endpoint; the user
then selects the plugin's Connect command and completes the host-managed
browser/loopback PKCE flow. The plugin requests only Google Calendar's event
read-only scope and may contact only `www.googleapis.com`. The host persists
the OAuth session, including this credential when supplied, in encrypted
plugin-scoped secret storage. While Google's
consent screen is in Testing, add intended users as test users. Broad external
distribution requires Google consent-screen verification.

Calendar Airmail reconciles a bounded rolling view of the primary calendar and
keeps durable occurrence and delivery state so reminders recover across app
restart, sleep, configuration changes, and reconnection. Temporary network
failures retain the last known schedule. If authorization is revoked or expires
and cannot be refreshed, the plugin clears its Google session and outstanding
delivery schedule, reports that reconnection is required, and the user should
run its sign-in command again.
If Google Calendar API access is denied, it keeps the connection and existing
deliveries, shows an API/account-access warning, and records only the bounded,
sanitized HTTP status and Google error classification in plugin diagnostics.
Its status shows the synced upcoming-event count and the next event's local
start and Airmail reminder times (or that no timed events were found), so users
can confirm the calendar data it sees. When future timed events remain today,
the pet menu also shows disabled summary rows for the remaining-today count and
the next event's local time and relative countdown; it hides those rows when
there are none. The pet menu exposes **Connect Google Calendar** only while
disconnected; once connected, it instead exposes **Sync now**, **Test
delivery**, and **Disconnect Google Calendar**.
Its manifest requests only `ui:delivery`, `auth`, `network`, `schedule`,
`storage`, `commands`, and `status`.

## Packaging & validation

Plugins ship with the app: on launch the desktop auto-scans `plugins/official/`
and `plugins/community/` and seeds every valid plugin into the user profile —
there is no remote catalog, download step, or release pipeline. See
[plugins-quickstart.md](plugins-quickstart.md) for the day-to-day workflow.

| Command | Purpose |
|---------|---------|
| `pnpm create-plugin <id>` | Scaffold a new plugin under `plugins/official/` |
| `pnpm plugins:locales` | Check plugin locale key coverage |
| `pnpm plugins:test` | Locale checks + all official/community plugin test harnesses |

Run `pnpm plugins:test` before committing plugin changes — it validates
manifests, locale coverage (`locales/en.json` plus locale stubs), and runs
each plugin's `test.js`. The source folder (`plugins/official/` vs
`plugins/community/`) distinguishes first-party plugins from community ones.

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Plugin marked "broken" | Manifest/action validation failed — check `plugin-diagnostics` / the inspector |
| SDK call silently does nothing | Permission not declared or not approved; or blocked by a global platform setting (audio/voice/quiet hours) |
| Network call rejected | Host not in declared `network` hosts |
| Plugin card shows raw `$t:...` | Missing locale key — `pnpm plugins:locales` catches it |
| Local plugin won't load | Local loader rejected the folder (symlink/path/size) or manifest isn't at root |
| Icon/image missing | Asset not declared in `assets`, wrong format, or over size cap |

## Where to look first

| Concern | File |
|---------|------|
| Manifest schema/validation | `plugin-manifest.ts`, `plugin-manifest-reader.ts` |
| Orchestration / UI actions | `plugin-service.ts` |
| Runtime / scheduling / broken-state | `plugin-runtime.ts` |
| Sandbox host | `plugin-js-host.ts` |
| Permission + dispatch | `plugin-sdk-bridge.ts` + `plugin-sdk-*.ts` |
| Bundled seeding / uninstall safety | `plugin-service.ts`, `plugin-package.ts` |
| Local dev load | `plugin-local-loader.ts` |
| Official plugin examples | `plugins/official/*` |
</content>
