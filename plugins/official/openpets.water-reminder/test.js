// Golden test for openpets.water-reminder v2.
import assert from "node:assert/strict";
import {
  MINUTE_MS,
  DAY_MS,
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
assert.equal(escalationDelayMs(1, 30), Math.round(30 * 0.66) * MINUTE_MS);
assert.equal(escalationDelayMs(2, 30), Math.round(30 * 0.33) * MINUTE_MS);
assert.equal(escalationDelayMs(3, 30), MINUTE_MS);
assert.equal(escalationDelayMs(4, 30), MINUTE_MS);
// Works with non-default base.
assert.equal(escalationDelayMs(0, 60), 60 * MINUTE_MS);
assert.equal(escalationDelayMs(1, 60), Math.round(60 * 0.66) * MINUTE_MS);

// bubbleKeyForLevel: maps to locale keys.
assert.equal(bubbleKeyForLevel(0), "bubble.gentle");
assert.equal(bubbleKeyForLevel(1), "bubble.nudge");
assert.equal(bubbleKeyForLevel(2), "bubble.insistent");
assert.equal(bubbleKeyForLevel(3), "bubble.urgent");
assert.equal(bubbleKeyForLevel(4), "bubble.relentless");

console.log("pure-function tests passed.");

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

console.log("level 0-3 tests passed.");

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
  await h.ctx.storage.set("state", { escalationLevel: 4, lastDrinkAt: 13_000_000 - 60_000 });
  await h.start();
  await h.clock.advance("2m");
  const bubble = h.calls.bubbles[h.calls.bubbles.length - 1];
  assert.ok(bubble.pinned, "should show pinned bubble");

  await h.fireBubbleAction(bubble.handle.id, "done");
  h.expectStored("state", (v) => v.escalationLevel === 0 && v.lastDrinkAt > 0);
  h.expectStored("state", (v) => v.nextDueAt > Date.now() + 14 * MINUTE_MS);
  h.expectNoErrors();
}

// 14) Level 4 caps — dismiss keeps at 4.
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
  const bubble = h.calls.bubbles[h.calls.bubbles.length - 1];
  await h.dismissBubble(bubble.handle.id, "click");
  h.expectStored("state", (v) => v.escalationLevel === 4);
  h.expectNoErrors();
}

// 15) test-reminder command fires at current escalation level.
{
  const h = createHarness(register, {
    permissions: PERMISSIONS,
    config: { intervalMinutes: 30 },
    locales: LOCALES,
    nowMs: 15_000_000,
  });
  await h.ctx.storage.set("state", { escalationLevel: 2 });
  await h.start();
  await h.runCommand("test-reminder");
  h.expectSpoke("Your pet is getting worried. Drink water!");
  h.expectNoErrors();
}

Date.now = realDateNow;
console.log("openpets.water-reminder v2: all checks passed.");
