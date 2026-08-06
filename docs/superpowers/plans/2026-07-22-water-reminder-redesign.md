# Water Reminder Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the water reminder plugin with configurable intervals, escalating aggression on ignore, and an opt-in extra aggressive wandering mode.

**Architecture:** Level-based state machine (0–4) tracking escalation. Each "Later"/dismiss increments the level and shortens the next reminder delay. "Done" always resets to level 0. Level 4 (opt-in) pins a persistent bubble and starts a wander loop.

**Tech Stack:** OpenPets Plugin SDK v3 (JavaScript), `@open-pets/plugin-sdk/testing` harness.

## Global Constraints

- Plugin is `plugins/official/openpets.water-reminder/`
- SDK v3, `manifestVersion: 3`, plain JS (no TS, no build step)
- Tests use `node:assert/strict` + `createTestHarness` from SDK
- Locale fallback: `ctx.t` resolves active locale → `en` → raw key
- Non-English locale files get new keys with English text as placeholders (translators fill later)
- Test command: `node --experimental-vm-modules plugins/official/openpets.water-reminder/test.js` (from repo root, or `node test.js` from plugin dir)

---

### Task 1: Manifest, locale files, and config

**Files:**
- Modify: `plugins/official/openpets.water-reminder/openpets.plugin.json`
- Modify: `plugins/official/openpets.water-reminder/locales/en.json`
- Modify: `plugins/official/openpets.water-reminder/locales/es-419.json`
- Modify: `plugins/official/openpets.water-reminder/locales/ja.json`
- Modify: `plugins/official/openpets.water-reminder/locales/ko.json`
- Modify: `plugins/official/openpets.water-reminder/locales/pt-BR.json`
- Modify: `plugins/official/openpets.water-reminder/locales/zh-Hans.json`
- Modify: `plugins/official/openpets.water-reminder/locales/zh-Hant.json`

**Interfaces:**
- Produces: manifest with `configSchema.intervalMinutes` (number, default 30, min 5, max 120), `configSchema.extraAggressive` (boolean, default false), `configSchema.customSound` (sound, unchanged); permissions `["pet:speak", "pet:interact", "pet:move", "pet:pin", "audio", "schedule", "storage", "commands", "events"]`
- Produces: locale keys `bubble.gentle`, `bubble.nudge`, `bubble.insistent`, `bubble.urgent`, `bubble.relentless`, `config.intervalMinutes.label`, `config.intervalMinutes.description`, `config.extraAggressive.label`, `config.extraAggressive.description`, `speech.done`, `speech.reset`

- [ ] **Step 1: Update `openpets.plugin.json`**

Replace the entire manifest content:

```json
{
  "manifestVersion": 3,
  "id": "openpets.water-reminder",
  "name": "$t:plugin.name",
  "description": "$t:plugin.description",
  "version": "2.0.0",
  "runtime": "javascript",
  "icon": "droplet",
  "sdkVersion": "3.0.0",
  "entry": "index.js",
  "assets": {
    "icons": {
      "water": "assets/water.svg"
    }
  },
  "permissions": [
    "pet:speak",
    "pet:interact",
    "pet:move",
    "pet:pin",
    "audio",
    "schedule",
    "storage",
    "commands",
    "events"
  ],
  "configSchema": {
    "intervalMinutes": {
      "type": "number",
      "default": 30,
      "min": 5,
      "max": 120,
      "label": "$t:config.intervalMinutes.label",
      "description": "$t:config.intervalMinutes.description"
    },
    "extraAggressive": {
      "type": "boolean",
      "default": false,
      "label": "$t:config.extraAggressive.label",
      "description": "$t:config.extraAggressive.description"
    },
    "customSound": {
      "type": "sound",
      "label": "$t:config.customSound.label",
      "description": "$t:config.customSound.description"
    }
  }
}
```

- [ ] **Step 2: Update `locales/en.json`**

Replace the entire file:

```json
{
  "plugin.name": "Water Reminder",
  "plugin.description": "A pet nudge to take a water break — gets pushier if you ignore it.",
  "config.intervalMinutes.label": "Reminder interval (minutes)",
  "config.intervalMinutes.description": "How often to remind you to drink water.",
  "config.extraAggressive.label": "Extra aggressive mode",
  "config.extraAggressive.description": "At maximum escalation, your pet wanders the screen with a permanent drink-water bubble.",
  "config.customSound.label": "Custom sound",
  "config.customSound.description": "Optional sound to play with the reminder.",
  "indicator.water": "Water reminder",
  "command.testReminder.title": "Test reminder",
  "command.testReminder.description": "Show a water reminder now at the current escalation level.",
  "command.drinkNow.title": "I drank water",
  "command.drinkNow.description": "Mark a water break and reset escalation.",
  "command.pauseToday.title": "Pause for today",
  "command.pauseToday.description": "Skip water reminders until tomorrow.",
  "bubble.gentle": "Water break? A few sips would be nice.",
  "bubble.nudge": "Hey, you should really drink some water.",
  "bubble.insistent": "Your pet is getting worried. Drink water!",
  "bubble.urgent": "DRINK. WATER. NOW.",
  "bubble.relentless": "I'm not going away. Drink water.",
  "action.done": "Done",
  "action.later": "Later",
  "speech.done": "Nice. I'll check in again later.",
  "speech.reset": "Good. Resetting the reminder.",
  "speech.paused": "Paused for today. I'll remind you tomorrow."
}
```

- [ ] **Step 3: Update non-English locale files**

For each of `es-419.json`, `ja.json`, `ko.json`, `pt-BR.json`, `zh-Hans.json`, `zh-Hant.json`:

1. Remove old keys: `config.pace.label`, `config.pace.description`, `config.pace.gentle`, `config.pace.normal`, `config.pace.often`, `bubble.reminder`
2. Add new keys with English placeholder values: `config.intervalMinutes.label`, `config.intervalMinutes.description`, `config.extraAggressive.label`, `config.extraAggressive.description`, `bubble.gentle`, `bubble.nudge`, `bubble.insistent`, `bubble.urgent`, `bubble.relentless`, `speech.reset`
3. Keep existing translated keys: `plugin.name`, `plugin.description`, `config.customSound.*`, `indicator.water`, `command.*`, `action.*`, `speech.done`, `speech.paused`

The `ctx.t` fallback chain (active locale → `en`) means English placeholders still resolve; translators can fill in localized versions later.

- [ ] **Step 4: Commit**

```bash
git add plugins/official/openpets.water-reminder/openpets.plugin.json plugins/official/openpets.water-reminder/locales/
git commit -m "water-reminder: update manifest and locales for v2 redesign

New config: intervalMinutes (number), extraAggressive (boolean).
New permissions: pet:move, pet:pin, events.
Escalating bubble keys: gentle/nudge/insistent/urgent/relentless.
Non-English locales get English placeholders for new keys."
```

---

### Task 2: Core escalation logic (levels 0–3)

**Files:**
- Modify: `plugins/official/openpets.water-reminder/index.js` (complete rewrite)
- Modify: `plugins/official/openpets.water-reminder/test.js` (complete rewrite)

**Interfaces:**
- Consumes: manifest `configSchema` fields (`intervalMinutes`, `extraAggressive`, `customSound`), locale keys from Task 1
- Produces: exported `MINUTE_MS`, `DAY_MS`, `SCHEDULE_ID`, `MAX_LEVEL`, `ESCALATION_MULTIPLIERS`, `cleanState(value)`, `escalationDelayMs(level, baseMinutes)`, `bubbleKeyForLevel(level)`, `fireReminder(ctx)`, `pauseToday(ctx)`, `reconcile(ctx)`, `register(OpenPetsPlugin)`

- [ ] **Step 1: Write pure-function tests in `test.js`**

Replace the entire `test.js` with this initial version that tests the pure functions only:

```js
// Golden test for openpets.water-reminder v2.
import assert from "node:assert/strict";
import {
  MINUTE_MS,
  DAY_MS,
  SCHEDULE_ID,
  MAX_LEVEL,
  ESCALATION_MULTIPLIERS,
  cleanState,
  escalationDelayMs,
  bubbleKeyForLevel,
  register,
} from "./index.js";

let createTestHarness;
try {
  ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing"));
} catch {
  ({ createTestHarness } = await import(
    new URL("../../../packages/sdk/dist/testing.js", import.meta.url)
  ));
}

const realDateNow = Date.now;
let activeClock;
function createHarness(...args) {
  const harness = createTestHarness(...args);
  activeClock = harness.clock;
  return harness;
}
Date.now = () => activeClock?.now() ?? realDateNow();

const PERMISSIONS = [
  "pet:speak", "pet:interact", "pet:move", "pet:pin",
  "audio", "schedule", "storage", "commands", "events",
];
const LOCALES = {
  en: JSON.parse(
    await (await import("node:fs/promises")).readFile(
      new URL("./locales/en.json", import.meta.url),
      "utf8",
    ),
  ),
};

// --- Pure function tests ---

// cleanState: new shape with escalationLevel, no streaks.
assert.deepEqual(cleanState({}), {
  lastDrinkAt: 0,
  pausedUntil: 0,
  nextDueAt: 0,
  escalationLevel: 0,
});
assert.deepEqual(cleanState({ lastDrinkAt: 10, escalationLevel: 2, junk: true }), {
  lastDrinkAt: 10,
  pausedUntil: 0,
  nextDueAt: 0,
  escalationLevel: 2,
});
// Old v1 fields silently dropped.
assert.deepEqual(cleanState({ streakDays: 5, lastStreakCelebratedDate: "2026-01-01" }), {
  lastDrinkAt: 0,
  pausedUntil: 0,
  nextDueAt: 0,
  escalationLevel: 0,
});
// Clamps escalationLevel to valid range.
assert.equal(cleanState({ escalationLevel: -1 }).escalationLevel, 0);
assert.equal(cleanState({ escalationLevel: 99 }).escalationLevel, MAX_LEVEL);

// escalationDelayMs: base → 66% → 33% → 1min.
assert.equal(escalationDelayMs(0, 30), 30 * MINUTE_MS);
assert.equal(escalationDelayMs(1, 30), Math.round(30 * 0.66) * MINUTE_MS); // 20min
assert.equal(escalationDelayMs(2, 30), Math.round(30 * 0.33) * MINUTE_MS); // 10min
assert.equal(escalationDelayMs(3, 30), MINUTE_MS);
assert.equal(escalationDelayMs(4, 30), MINUTE_MS);
// Works with non-default base.
assert.equal(escalationDelayMs(0, 60), 60 * MINUTE_MS);
assert.equal(escalationDelayMs(1, 60), Math.round(60 * 0.66) * MINUTE_MS); // 40min

// bubbleKeyForLevel: maps to locale keys.
assert.equal(bubbleKeyForLevel(0), "bubble.gentle");
assert.equal(bubbleKeyForLevel(1), "bubble.nudge");
assert.equal(bubbleKeyForLevel(2), "bubble.insistent");
assert.equal(bubbleKeyForLevel(3), "bubble.urgent");
assert.equal(bubbleKeyForLevel(4), "bubble.relentless");

console.log("pure-function tests passed.");
```

- [ ] **Step 2: Run tests — expect failure (functions not defined)**

Run: `cd openpets && node --experimental-vm-modules plugins/official/openpets.water-reminder/test.js`
Expected: Import error — `ESCALATION_MULTIPLIERS`, `escalationDelayMs`, `bubbleKeyForLevel` not exported from `index.js`.

- [ ] **Step 3: Rewrite `index.js` — pure functions and core logic**

Replace the entire `index.js`:

```js
// Water Reminder v2 (openpets.water-reminder) — escalating reminders.

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * 60_000;
export const SCHEDULE_ID = "water-reminder-next";
export const MAX_LEVEL = 4;
export const ESCALATION_MULTIPLIERS = [1, 0.66, 0.33];

export function escalationDelayMs(level, baseMinutes) {
  if (level >= 3) return MINUTE_MS;
  const multiplier = ESCALATION_MULTIPLIERS[level] ?? 1;
  return Math.round(baseMinutes * multiplier) * MINUTE_MS;
}

const BUBBLE_KEYS = ["bubble.gentle", "bubble.nudge", "bubble.insistent", "bubble.urgent", "bubble.relentless"];

export function bubbleKeyForLevel(level) {
  return BUBBLE_KEYS[Math.min(level, BUBBLE_KEYS.length - 1)];
}

function nextLocalDayMs(ms = Date.now()) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

export function cleanState(value = {}) {
  const state = value && typeof value === "object" ? value : {};
  const rawLevel = Number.isFinite(state.escalationLevel) ? Math.floor(state.escalationLevel) : 0;
  return {
    lastDrinkAt: Number.isFinite(state.lastDrinkAt) ? state.lastDrinkAt : 0,
    pausedUntil: Number.isFinite(state.pausedUntil) ? state.pausedUntil : 0,
    nextDueAt: Number.isFinite(state.nextDueAt) ? state.nextDueAt : 0,
    escalationLevel: Math.max(0, Math.min(rawLevel, MAX_LEVEL)),
  };
}

async function getState(ctx) {
  return cleanState(await ctx.storage.get("state"));
}

async function saveState(ctx, state) {
  const cleaned = cleanState(state);
  await ctx.storage.set("state", cleaned);
  return cleaned;
}

async function getConfig(ctx) {
  const cfg = (await ctx.config.get()) ?? {};
  const intervalMinutes = Number.isFinite(cfg.intervalMinutes) && cfg.intervalMinutes >= 5
    ? Math.min(cfg.intervalMinutes, 120)
    : 30;
  return { intervalMinutes, extraAggressive: !!cfg.extraAggressive, customSound: cfg.customSound };
}

async function scheduleAt(ctx, target, state) {
  state ??= await getState(ctx);
  const now = Date.now();
  await ctx.schedule.cancel(SCHEDULE_ID);
  await saveState(ctx, { ...state, nextDueAt: target });
  await ctx.schedule.once(SCHEDULE_ID, Math.max(1, target - now), () => fireScheduledReminder(ctx, target));
}

async function scheduleNext(ctx, delayMs) {
  const state = await getState(ctx);
  const now = Date.now();
  const target = Math.max(now + Math.max(1, delayMs), state.pausedUntil || 0);
  await scheduleAt(ctx, target, state);
}

async function fireScheduledReminder(ctx, dueAt) {
  const state = await getState(ctx);
  if (state.nextDueAt !== dueAt) return false;
  const now = Date.now();
  if (now < dueAt) {
    await scheduleAt(ctx, dueAt, state);
    return false;
  }
  return fireReminder(ctx);
}

async function scheduleFromState(ctx) {
  const state = await getState(ctx);
  const cfg = await getConfig(ctx);
  const now = Date.now();
  const delay = escalationDelayMs(state.escalationLevel, cfg.intervalMinutes);
  const base = state.pausedUntil && state.pausedUntil > now ? state.pausedUntil : now + delay;
  await scheduleNext(ctx, Math.max(1, base - now));
}

async function recordDrink(ctx, speechKey = null) {
  const now = Date.now();
  const state = await getState(ctx);
  const cfg = await getConfig(ctx);
  const newState = { ...state, lastDrinkAt: now, pausedUntil: 0, escalationLevel: 0 };
  await scheduleAt(ctx, now + escalationDelayMs(0, cfg.intervalMinutes), newState);
  if (speechKey) await ctx.pet.speak(ctx.t(speechKey));
  return cleanState(newState);
}

export async function pauseToday(ctx) {
  const pausedUntil = nextLocalDayMs();
  const state = { ...(await getState(ctx)), pausedUntil, nextDueAt: pausedUntil, escalationLevel: 0 };
  await scheduleAt(ctx, pausedUntil, state);
  return cleanState(state);
}

let activeAlert = null;

export async function fireReminder(ctx) {
  const state = await getState(ctx);
  const now = Date.now();
  if (state.pausedUntil && state.pausedUntil > now) {
    await scheduleNext(ctx, state.pausedUntil - now);
    return false;
  }
  if (activeAlert) {
    await scheduleNext(ctx, MINUTE_MS);
    return false;
  }

  const cfg = await getConfig(ctx);
  const level = state.escalationLevel;
  const maxLevel = cfg.extraAggressive ? MAX_LEVEL : MAX_LEVEL - 1;
  const waterIcon = ctx.assets.icon("water");
  const alertSpec = {
    text: ctx.t(bubbleKeyForLevel(level)),
    indicator: {
      icon: waterIcon,
      label: ctx.t("indicator.water"),
      tone: "info",
      color: "#0ea5e9",
      background: "#e0f2fe",
      borderColor: "#7dd3fc",
    },
    tone: "info",
    dismissOn: ["action", "petClick", "click"],
    actions: [
      { id: "done", label: ctx.t("action.done"), style: "primary" },
      { id: "later", label: ctx.t("action.later") },
    ],
  };
  if (cfg.customSound) alertSpec.sound = cfg.customSound;

  try {
    activeAlert = await ctx.ui.alert(alertSpec);
    activeAlert.onDismiss(async () => {
      if (!activeAlert) return;
      activeAlert = null;
      const nextLevel = Math.min(level + 1, maxLevel);
      await saveState(ctx, { ...state, escalationLevel: nextLevel });
      await scheduleNext(ctx, escalationDelayMs(nextLevel, cfg.intervalMinutes));
    });
    activeAlert.onAction(async (actionId) => {
      activeAlert = null;
      if (actionId === "done") {
        await recordDrink(ctx);
      } else if (actionId === "later") {
        const nextLevel = Math.min(level + 1, maxLevel);
        const delay = escalationDelayMs(nextLevel, cfg.intervalMinutes);
        await saveState(ctx, { ...state, escalationLevel: nextLevel });
        await scheduleNext(ctx, delay);
      }
    });
  } catch {
    activeAlert = null;
    await scheduleNext(ctx, escalationDelayMs(level, cfg.intervalMinutes));
    try {
      await ctx.pet.speak(ctx.t(bubbleKeyForLevel(level)));
    } catch {}
  }
  return true;
}

export async function reconcile(ctx) {
  await ctx.schedule.cancel(SCHEDULE_ID);
  activeAlert = null;
  await scheduleFromState(ctx);
}

export function register(OpenPetsPlugin) {
  OpenPetsPlugin.register({
    async start(ctx) {
      await reconcile(ctx);

      await ctx.commands.register(
        {
          id: "test-reminder",
          title: "$t:command.testReminder.title",
          description: "$t:command.testReminder.description",
          icon: "droplet",
        },
        () => fireReminder(ctx),
      );

      await ctx.commands.register(
        {
          id: "drink-now",
          title: "$t:command.drinkNow.title",
          description: "$t:command.drinkNow.description",
          icon: "check",
        },
        () => recordDrink(ctx, "speech.done"),
      );

      await ctx.commands.register(
        {
          id: "pause-today",
          title: "$t:command.pauseToday.title",
          description: "$t:command.pauseToday.description",
          icon: "pause",
        },
        async () => {
          await pauseToday(ctx);
          await ctx.pet.speak(ctx.t("speech.paused"));
        },
      );
    },
    async stop() {
      activeAlert = null;
    },
  });
}
```

- [ ] **Step 4: Run pure-function tests — expect pass**

Run: `cd openpets && node --experimental-vm-modules plugins/official/openpets.water-reminder/test.js`
Expected: `pure-function tests passed.`

- [ ] **Step 5: Add harness integration tests to `test.js`**

Append these tests after the `console.log("pure-function tests passed.")` line:

```js
// --- Harness integration tests ---

// 1) Start schedules at configured interval.
{
  const h = createHarness(register, {
    permissions: PERMISSIONS,
    config: { intervalMinutes: 20 },
    locales: LOCALES,
    nowMs: 1_000_000,
  });
  await h.start();
  assert.equal(h.calls.schedules.size, 1, "expected one active schedule");
  h.expectStored("state", (v) => v.nextDueAt > Date.now() && v.nextDueAt <= Date.now() + 20 * MINUTE_MS + 1_000);
  h.expectStored("state", (v) => v.escalationLevel === 0);
  h.expectNoErrors();
}

// 2) Reminder fires at base interval, shows gentle text.
{
  const h = createHarness(register, {
    permissions: PERMISSIONS,
    config: { intervalMinutes: 20 },
    locales: LOCALES,
    nowMs: 2_000_000,
  });
  await h.start();
  await h.clock.advance("21m");
  h.expectBubble({
    indicator: {
      icon: { kind: "icon", name: "water" },
      label: "Water reminder",
      tone: "info",
      color: "#0ea5e9",
      background: "#e0f2fe",
      borderColor: "#7dd3fc",
    },
    tone: "info",
    sticky: true,
    priority: "high",
  });
  h.expectSpoke("Water break? A few sips would be nice.");
  const bubble = h.calls.bubbles[h.calls.bubbles.length - 1];
  assert.deepEqual(bubble.spec.actions?.map((a) => a.id), ["done", "later"]);
  assert.equal(h.calls.sounds.length, 0, "no sound without customSound");
  h.expectNoErrors();
}

// 3) "Later" escalates level 0→1 and schedules at ~66% of base.
{
  const h = createHarness(register, {
    permissions: PERMISSIONS,
    config: { intervalMinutes: 30 },
    locales: LOCALES,
    nowMs: 3_000_000,
  });
  await h.start();
  await h.clock.advance("31m");
  const bubble = h.calls.bubbles[h.calls.bubbles.length - 1];
  await h.fireBubbleAction(bubble.handle.id, "later");
  h.expectStored("state", (v) => v.escalationLevel === 1);
  const expected = Math.round(30 * 0.66) * MINUTE_MS;
  h.expectStored("state", (v) => v.nextDueAt > Date.now() && v.nextDueAt <= Date.now() + expected + 1_000);
  h.expectNoErrors();
}

// 4) Escalation chain: 0→1→2→3, each with different bubble text.
{
  const h = createHarness(register, {
    permissions: PERMISSIONS,
    config: { intervalMinutes: 30 },
    locales: LOCALES,
    nowMs: 4_000_000,
  });
  await h.start();

  // Level 0 → gentle
  await h.clock.advance("31m");
  h.expectSpoke("Water break? A few sips would be nice.");
  await h.fireBubbleAction(h.calls.bubbles[h.calls.bubbles.length - 1].handle.id, "later");
  h.expectStored("state", (v) => v.escalationLevel === 1);

  // Level 1 → nudge
  await h.clock.advance("21m");
  h.expectSpoke("Hey, you should really drink some water.");
  await h.fireBubbleAction(h.calls.bubbles[h.calls.bubbles.length - 1].handle.id, "later");
  h.expectStored("state", (v) => v.escalationLevel === 2);

  // Level 2 → insistent
  await h.clock.advance("11m");
  h.expectSpoke("Your pet is getting worried. Drink water!");
  await h.fireBubbleAction(h.calls.bubbles[h.calls.bubbles.length - 1].handle.id, "later");
  h.expectStored("state", (v) => v.escalationLevel === 3);

  // Level 3 → urgent, caps at 3 (extraAggressive off)
  await h.clock.advance("2m");
  h.expectSpoke("DRINK. WATER. NOW.");
  await h.fireBubbleAction(h.calls.bubbles[h.calls.bubbles.length - 1].handle.id, "later");
  h.expectStored("state", (v) => v.escalationLevel === 3);

  h.expectNoErrors();
}

// 5) "Done" at any level resets to 0 and schedules base interval.
{
  const h = createHarness(register, {
    permissions: PERMISSIONS,
    config: { intervalMinutes: 15 },
    locales: LOCALES,
    nowMs: 5_000_000,
  });
  await h.start();

  // Escalate to level 2
  await h.clock.advance("16m");
  await h.fireBubbleAction(h.calls.bubbles[h.calls.bubbles.length - 1].handle.id, "later");
  await h.clock.advance("11m");
  await h.fireBubbleAction(h.calls.bubbles[h.calls.bubbles.length - 1].handle.id, "later");
  h.expectStored("state", (v) => v.escalationLevel === 2);

  // Hit Done
  await h.clock.advance("6m");
  await h.fireBubbleAction(h.calls.bubbles[h.calls.bubbles.length - 1].handle.id, "done");
  h.expectStored("state", (v) => v.escalationLevel === 0 && v.lastDrinkAt > 0);
  h.expectStored("state", (v) => v.nextDueAt > Date.now() + 14 * MINUTE_MS);
  h.expectNoErrors();
}

// 6) Pause-today resets escalation level.
{
  const h = createHarness(register, {
    permissions: PERMISSIONS,
    config: { intervalMinutes: 30 },
    locales: LOCALES,
  });
  await h.start();
  await h.runCommand("pause-today");
  h.expectStored("state", (v) => v.pausedUntil > Date.now() && v.escalationLevel === 0);
  h.expectSpoke(/Paused for today/);
  h.expectNoErrors();
}

// 7) drink-now command resets and speaks.
{
  const h = createHarness(register, {
    permissions: PERMISSIONS,
    config: { intervalMinutes: 45 },
    locales: LOCALES,
    nowMs: 7_000_000,
  });
  await h.start();
  await h.runCommand("drink-now");
  h.expectSpoke(/Nice/);
  h.expectStored("state", (v) => v.lastDrinkAt > 0 && v.escalationLevel === 0);
  h.expectStored("state", (v) => v.nextDueAt > Date.now() + 44 * MINUTE_MS);
  h.expectNoErrors();
}

// 8) Custom sound plays when configured.
{
  const h = createHarness(register, {
    permissions: PERMISSIONS,
    config: { intervalMinutes: 20, customSound: "chime" },
    locales: LOCALES,
    nowMs: 8_000_000,
  });
  await h.start();
  await h.clock.advance("21m");
  assert.ok(h.calls.sounds.some((s) => s.sound === "chime"), "expected configured sound");
  h.expectNoErrors();
}

// 9) Stale due times reset on launch.
{
  const nowMs = 9_000_000;
  const h = createHarness(register, {
    permissions: PERMISSIONS,
    config: { intervalMinutes: 20 },
    locales: LOCALES,
    nowMs,
  });
  await h.ctx.storage.set("state", { nextDueAt: nowMs - 1, lastDrinkAt: nowMs - 21 * MINUTE_MS, escalationLevel: 0 });
  await h.start();
  h.expectStored("state", (v) => v.nextDueAt > Date.now() + 19 * MINUTE_MS);
  await h.clock.advance("1s");
  assert.equal(h.calls.alerts.length, 0, "stale launch state should not fire immediately");
  h.expectNoErrors();
}

// 10) Reconcile preserves escalation level.
{
  const nowMs = 10_000_000;
  const h = createHarness(register, {
    permissions: PERMISSIONS,
    config: { intervalMinutes: 30 },
    locales: LOCALES,
    nowMs,
  });
  await h.ctx.storage.set("state", { escalationLevel: 2, lastDrinkAt: nowMs - 5 * MINUTE_MS });
  await h.start();
  h.expectStored("state", (v) => v.escalationLevel === 2);
  // Should schedule at level 2 delay (~33% of 30 = 10 min)
  const expected = Math.round(30 * 0.33) * MINUTE_MS;
  h.expectStored("state", (v) => v.nextDueAt <= Date.now() + expected + 1_000);
  h.expectNoErrors();
}

// 11) Dismiss (not action) also escalates.
{
  const h = createHarness(register, {
    permissions: PERMISSIONS,
    config: { intervalMinutes: 30 },
    locales: LOCALES,
    nowMs: 11_000_000,
  });
  await h.start();
  await h.clock.advance("31m");
  const bubble = h.calls.bubbles[h.calls.bubbles.length - 1];
  await h.dismissBubble(bubble.handle.id, "click");
  h.expectStored("state", (v) => v.escalationLevel === 1);
  h.expectNoErrors();
}

Date.now = realDateNow;
console.log("openpets.water-reminder v2: all level 0-3 tests passed.");
```

- [ ] **Step 6: Run all tests — expect pass**

Run: `cd openpets && node --experimental-vm-modules plugins/official/openpets.water-reminder/test.js`
Expected: Both `pure-function tests passed.` and `openpets.water-reminder v2: all level 0-3 tests passed.`

- [ ] **Step 7: Commit**

```bash
git add plugins/official/openpets.water-reminder/index.js plugins/official/openpets.water-reminder/test.js
git commit -m "water-reminder: rewrite with escalating reminders (levels 0-3)

Configurable interval replaces pace presets.
Later/dismiss escalates: base → 66% → 33% → 1min.
Done resets to level 0. Streaks removed."
```

---

### Task 3: Extra aggressive mode (level 4)

**Files:**
- Modify: `plugins/official/openpets.water-reminder/index.js`
- Modify: `plugins/official/openpets.water-reminder/test.js`

**Interfaces:**
- Consumes: `fireReminder(ctx)` from Task 2 (level 0–3 path), `cleanState`, `escalationDelayMs`, `bubbleKeyForLevel`, `MAX_LEVEL`, `getConfig` (internal), `recordDrink` (internal)
- Produces: level 4 behavior in `fireReminder`: pinned bubble (Done only, no Later), wander loop via `onTick`, cleanup on Done (dismiss, stop wander, `moveToHome`, reset level 0)

- [ ] **Step 1: Add level 4 tests to `test.js`**

Append after the `console.log("openpets.water-reminder v2: all level 0-3 tests passed.")` line (before `Date.now = realDateNow`; move that line and the final console.log to the very end):

```js
// --- Extra aggressive mode (level 4) tests ---

// 12) With extraAggressive ON, level escalates to 4.
{
  const h = createHarness(register, {
    permissions: PERMISSIONS,
    config: { intervalMinutes: 15, extraAggressive: true },
    locales: LOCALES,
    nowMs: 12_000_000,
  });
  await h.start();

  // Escalate through 0→1→2→3
  await h.clock.advance("16m");
  await h.fireBubbleAction(h.calls.bubbles[h.calls.bubbles.length - 1].handle.id, "later");
  await h.clock.advance("11m");
  await h.fireBubbleAction(h.calls.bubbles[h.calls.bubbles.length - 1].handle.id, "later");
  await h.clock.advance("6m");
  await h.fireBubbleAction(h.calls.bubbles[h.calls.bubbles.length - 1].handle.id, "later");
  h.expectStored("state", (v) => v.escalationLevel === 3);

  // Level 3 → 4 on next Later
  await h.clock.advance("2m");
  await h.fireBubbleAction(h.calls.bubbles[h.calls.bubbles.length - 1].handle.id, "later");
  h.expectStored("state", (v) => v.escalationLevel === 4);

  // Level 4 fires — should show pinned bubble with relentless text, only Done action
  await h.clock.advance("2m");
  const lastBubble = h.calls.bubbles[h.calls.bubbles.length - 1];
  assert.ok(lastBubble.pinned, "level 4 bubble should be pinned");
  assert.equal(lastBubble.spec.text, "I'm not going away. Drink water.");
  assert.deepEqual(lastBubble.spec.actions?.map((a) => a.id), ["done"], "level 4 should only have Done");
  assert.deepEqual(lastBubble.spec.dismissOn, ["action"], "level 4 should only dismiss on action");

  h.expectNoErrors();
}

// 13) Done at level 4 resets everything.
{
  const h = createHarness(register, {
    permissions: PERMISSIONS,
    config: { intervalMinutes: 15, extraAggressive: true },
    locales: LOCALES,
    nowMs: 13_000_000,
  });
  // Pre-set state to level 4.
  await h.ctx.storage.set("state", { escalationLevel: 4, lastDrinkAt: 13_000_000 - 60_000 });
  await h.start();
  await h.clock.advance("2m");
  // Should fire level 4 reminder
  const bubble = h.calls.bubbles[h.calls.bubbles.length - 1];
  assert.ok(bubble.pinned, "should show pinned bubble");

  // Click Done
  await h.fireBubbleAction(bubble.handle.id, "done");
  h.expectStored("state", (v) => v.escalationLevel === 0 && v.lastDrinkAt > 0);
  h.expectStored("state", (v) => v.nextDueAt > Date.now() + 14 * MINUTE_MS);
  h.expectNoErrors();
}

// 14) Level 4 caps — doesn't go to 5.
{
  const h = createHarness(register, {
    permissions: PERMISSIONS,
    config: { intervalMinutes: 15, extraAggressive: true },
    locales: LOCALES,
    nowMs: 14_000_000,
  });
  await h.ctx.storage.set("state", { escalationLevel: 4 });
  await h.start();
  await h.clock.advance("2m");
  // Dismiss level 4 (via click, but dismissOn is ["action"] so we use fireBubbleAction with a fallback)
  const bubble = h.calls.bubbles[h.calls.bubbles.length - 1];
  // The dismiss handler should keep at 4
  await h.dismissBubble(bubble.handle.id, "click");
  h.expectStored("state", (v) => v.escalationLevel === 4);
  h.expectNoErrors();
}
```

- [ ] **Step 2: Run tests — expect failure (level 4 not implemented)**

Run: `cd openpets && node --experimental-vm-modules plugins/official/openpets.water-reminder/test.js`
Expected: Test 12 fails — level 4 bubble is not pinned (current `fireReminder` uses standard alert for all levels).

- [ ] **Step 3: Update `fireReminder` in `index.js` for level 4**

In `index.js`, replace the `fireReminder` function with the version that handles level 4 differently:

```js
let activeAlert = null;
let wanderUnsub = null;

export async function fireReminder(ctx) {
  const state = await getState(ctx);
  const now = Date.now();
  if (state.pausedUntil && state.pausedUntil > now) {
    await scheduleNext(ctx, state.pausedUntil - now);
    return false;
  }
  if (activeAlert) {
    await scheduleNext(ctx, MINUTE_MS);
    return false;
  }

  const cfg = await getConfig(ctx);
  const level = state.escalationLevel;
  const maxLevel = cfg.extraAggressive ? MAX_LEVEL : MAX_LEVEL - 1;
  const waterIcon = ctx.assets.icon("water");

  if (level >= MAX_LEVEL && cfg.extraAggressive) {
    return fireAggressiveReminder(ctx, state, cfg, waterIcon, maxLevel);
  }

  const alertSpec = {
    text: ctx.t(bubbleKeyForLevel(level)),
    indicator: {
      icon: waterIcon,
      label: ctx.t("indicator.water"),
      tone: "info",
      color: "#0ea5e9",
      background: "#e0f2fe",
      borderColor: "#7dd3fc",
    },
    tone: "info",
    dismissOn: ["action", "petClick", "click"],
    actions: [
      { id: "done", label: ctx.t("action.done"), style: "primary" },
      { id: "later", label: ctx.t("action.later") },
    ],
  };
  if (cfg.customSound) alertSpec.sound = cfg.customSound;

  try {
    activeAlert = await ctx.ui.alert(alertSpec);
    activeAlert.onDismiss(async () => {
      if (!activeAlert) return;
      activeAlert = null;
      const nextLevel = Math.min(level + 1, maxLevel);
      await saveState(ctx, { ...state, escalationLevel: nextLevel });
      await scheduleNext(ctx, escalationDelayMs(nextLevel, cfg.intervalMinutes));
    });
    activeAlert.onAction(async (actionId) => {
      activeAlert = null;
      if (actionId === "done") {
        await recordDrink(ctx);
      } else if (actionId === "later") {
        const nextLevel = Math.min(level + 1, maxLevel);
        const delay = escalationDelayMs(nextLevel, cfg.intervalMinutes);
        await saveState(ctx, { ...state, escalationLevel: nextLevel });
        await scheduleNext(ctx, delay);
      }
    });
  } catch {
    activeAlert = null;
    await scheduleNext(ctx, escalationDelayMs(level, cfg.intervalMinutes));
    try {
      await ctx.pet.speak(ctx.t(bubbleKeyForLevel(level)));
    } catch {}
  }
  return true;
}

async function fireAggressiveReminder(ctx, state, cfg, waterIcon, maxLevel) {
  const alertSpec = {
    text: ctx.t(bubbleKeyForLevel(MAX_LEVEL)),
    indicator: {
      icon: waterIcon,
      label: ctx.t("indicator.water"),
      tone: "info",
      color: "#0ea5e9",
      background: "#e0f2fe",
      borderColor: "#7dd3fc",
    },
    tone: "info",
    pin: true,
    dismissOn: ["action"],
    actions: [
      { id: "done", label: ctx.t("action.done"), style: "primary" },
    ],
  };
  if (cfg.customSound) alertSpec.sound = cfg.customSound;

  try {
    activeAlert = await ctx.ui.alert(alertSpec);
    startWander(ctx);
    activeAlert.onDismiss(async () => {
      if (!activeAlert) return;
      activeAlert = null;
      stopWander();
      await saveState(ctx, { ...state, escalationLevel: maxLevel });
      await scheduleNext(ctx, MINUTE_MS);
    });
    activeAlert.onAction(async (actionId) => {
      activeAlert = null;
      stopWander();
      if (actionId === "done") {
        await ctx.pets.default.moveToHome();
        await recordDrink(ctx);
      }
    });
  } catch {
    activeAlert = null;
    stopWander();
    await scheduleNext(ctx, MINUTE_MS);
    try {
      await ctx.pet.speak(ctx.t(bubbleKeyForLevel(MAX_LEVEL)));
    } catch {}
  }
  return true;
}

function startWander(ctx) {
  stopWander();
  let elapsed = 0;
  wanderUnsub = ctx.pets.default.onTick((dtMs) => {
    elapsed += dtMs;
    if (elapsed >= 5_000) {
      elapsed = 0;
      ctx.pets.default.wander().catch(() => {});
    }
  });
}

function stopWander() {
  if (wanderUnsub) {
    wanderUnsub();
    wanderUnsub = null;
  }
}
```

Also update the `stop` handler in `register` to clean up the wander:

```js
    async stop() {
      activeAlert = null;
      stopWander();
    },
```

- [ ] **Step 4: Run all tests — expect pass**

Run: `cd openpets && node --experimental-vm-modules plugins/official/openpets.water-reminder/test.js`
Expected: All tests pass including level 4 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/official/openpets.water-reminder/index.js plugins/official/openpets.water-reminder/test.js
git commit -m "water-reminder: add extra aggressive mode (level 4)

Level 4 (opt-in): pinned bubble with Done only, pet wanders via
onTick every 5s. Done dismisses, stops wander, moveToHome, resets."
```

- [ ] **Step 6: Run full plugin test suite to check for regressions**

Run: `cd openpets && pnpm plugins:test`
Expected: All plugin tests pass, including the water-reminder tests.
