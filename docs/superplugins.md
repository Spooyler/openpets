# SuperPlugins: Product Direction

"SuperPlugins" is the **companion-first** direction for OpenPets plugins. Where
[plugins.md](plugins.md) is the platform mechanics and [sdk.md](sdk.md) is the
author API, this doc is the *product* intent: what official plugins should feel
like, which ones ship, what's bundled by default, and how users invoke them.

This is required reading (with [plugins.md](plugins.md)) before plugin platform,
official-plugin, or plugin-UI work, per `AGENTS.md`. Keep the lineup and
bundling defaults here in sync with `apps/desktop/src/plugin-service.ts` and the
plugin folders when they change.

## The thesis

The pet is a companion, not a control panel. Plugins should make the pet *do
helpful things on its own* — remind you, nudge you, react to your day — using
host-rendered surfaces (bubbles, alerts, pinned HUDs, status text, right-click
commands), not by bolting bespoke windows onto the pet. Concretely:

- **Host-rendered, descriptor-driven.** Plugins describe; the host renders. No
  injecting UI into pet windows. (Enforced by the SDK — see [sdk.md](sdk.md).)
- **Zero-JSON configuration.** Every setting is a typed `configSchema` field
  rendered as a form. Users never edit JSON.
- **Localized by default.** Manifests use `$t:` and code uses `ctx.t()`; ship
  `locales/en.json`. See [i18n.md](i18n.md).
- **Stateful and resilient.** Reminders, routines, focus sessions, and virtual-pet
  stats live in `ctx.storage` and reconcile after restart/sleep.
- **Appliance, not platform knob.** Prefer many small, enable-and-go plugins over
  one big configurable one. (This is a standing product preference — a single
  plugin should explain itself by name and do one thing well.)

## Right-click action strategy

The primary way users invoke plugins is the **default pet's right-click menu**.
Enabled plugins surface their registered `commands` under a Plugins submenu, so a
plugin's value is one click away on the pet itself. Plugins should register
clear, verb-first commands (e.g. "Start focus session", "Add reminder") rather
than burying everything in settings. Bubble buttons and pinned HUDs handle
in-the-moment interactions (snooze, done, feed).

## Official plugin lineup

Official plugins live in `plugins/official/` and are the reviewed, bundled set.
Current lineup (verified 2026-07-10 against the folder + manifests):

| Plugin id | What it is |
|-----------|------------|
| `openpets.reminders` | Quick reminders with due/missed alerts, snooze/done, status, optional notify/sound |
| `openpets.virtual-pet` | Tamagotchi-style state machine (hunger/energy/happiness/affection), pinned HUD, click handling |
| `openpets.focus-buddy` | Focus-session timers with status and completion/break feedback |
| `openpets.water-reminder` | Hydration reminder loop with configurable cadence |
| `openpets.day-routine` | Morning/evening daily check-ins |
| `openpets.mood-check-in` | Mood logging/check-in companion |
| `openpets.launch-buddy` | Launch/checklist companion for shipping moments |
| `openpets.magic-8-ball` | Command-driven decision/fortune responses |
| `openpets.fortune-cookie` | Periodic or command-triggered fortunes |
| `openpets.calendar-airmail` | Google primary-calendar reminders delivered by a selected bundled courier sprite ten minutes before and at event start |
| `openpets.claude-usage` | Always-on Claude usage HUD: weekly limits plus the 5-hour session broken down by model, with a details panel and an optional standalone widget pet |

`plugins/official/codemap.md` carries the per-plugin SDK-surface breakdown.

## Community plugin lineup

Community plugins live in `plugins/community/`. They pass the same manifest,
locale, and `test.js` checks as official plugins (`pnpm plugins:test`) and are
auto-scanned and seeded like official plugins, but none is enabled by default.

Current community lineup:

| Plugin id | What it is |
|-----------|------------|
| `openpets.walkabout` | Makes the pet roam the screen, follow the cursor, or patrol back and forth |
| `openpets.spotify-buddy` | Reacts to Spotify, syncs lyrics in real time, and controls playback |

## Bundling & default-enabled

Defaults are defined in `apps/desktop/src/plugin-service.ts`; the bundled roots
are resolved in `apps/desktop/src/main.ts`, and packaging ships
`plugins/official` as an extra resource (`apps/desktop/electron-builder.yml`,
enforced by `check-packaging-contract.ts`):

- **Bundled with the app**: every valid plugin folder in `plugins/official/` and
  `plugins/community/` is auto-scanned and seeded on launch; there is no
  hard-coded bundled list. The packaged extra resources currently copy only
  `plugins/official`.
- **Enabled by default**: `openpets.reminders`, `openpets.focus-buddy`,
  `openpets.launch-buddy` (`bundledEnabledByDefault`).
- **Bundled but disabled by default**: everything else; users enable it from the
  Plugins page.
- **`staleBundledPluginIds`**: an explicit cleanup list of plugin ids that were
  bundled in past builds and must be removed on upgrade (e.g. `ambient-companion`,
  `break-buddy`, `github-notifications`, `pomodoro`, `pet-pal`, `wander-buddy`,
  …). This is how the forward-only direction is enforced for plugins: old
  bundled state is actively reaped, not left to rot.

> If you change what's bundled or enabled by default, update both the constants
> in `plugin-service.ts` and this doc, and verify the packaging contract still
> passes ([testing-and-validation.md](testing-and-validation.md)).

## No plugin catalog

There is no remote plugin catalog, ZIP hosting, or plugin release pipeline;
plugins ship only as bundled folders (see [plugins.md](plugins.md)). The plugin
quality gates are in [testing-and-validation.md](testing-and-validation.md).
</content>
