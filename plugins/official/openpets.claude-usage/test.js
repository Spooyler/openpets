// Golden test for openpets.claude-usage.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  toneForUtilization,
  hudItemsFromPayload,
  modelDisplayName,
  formatTokens,
  register,
} from "./index.js";

let createTestHarness;
try {
  ({ createTestHarness } = await import("@open-pets/plugin-sdk/testing"));
} catch {
  ({ createTestHarness } = await import(new URL("../../../packages/sdk/dist/testing.js", import.meta.url)));
}

const PERMISSIONS = ["events", "pet:speak", "pet:pin", "ui:panel", "commands", "storage", "pets:manage"];
// agent:usage handling is fire-and-forget; let the plugin's async chain settle.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const LOCALES = { en: JSON.parse(await readFile(new URL("./locales/en.json", import.meta.url), "utf8")) };

const samplePayload = {
  updatedAt: 1_753_600_000_000,
  stale: false,
  buckets: [
    { id: "session", label: "Session", utilization: 72, resetsAt: "2026-07-27T11:10:00Z" },
    { id: "weekly_all", label: "Week (all)", utilization: 24, resetsAt: "2026-07-31T07:00:00Z" },
    { id: "weekly_scoped:Fable", label: "Week (Fable)", utilization: 91 },
  ],
  models: [
    { model: "claude-fable-5", inputTokens: 1500, outputTokens: 42_000, cacheCreationTokens: 250_000, cacheReadTokens: 3_100_000, weightedShare: 0.91 },
    { model: "claude-haiku-4-5-20251001", inputTokens: 200, outputTokens: 900, cacheCreationTokens: 0, cacheReadTokens: 12_000, weightedShare: 0.09 },
  ],
};

// 1) Pure helpers
{
  // toneForUtilization: severity coloring, slate when stale
  assert.equal(toneForUtilization(24, false), "blue");
  assert.equal(toneForUtilization(72, false), "amber");
  assert.equal(toneForUtilization(91, false), "red");
  assert.equal(toneForUtilization(91, true), "slate");

  // hudItemsFromPayload: bucket order preserved, icons by bucket kind
  const items = hudItemsFromPayload(samplePayload);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { icon: "timer", value: 72, tone: "amber", label: "Session" });
  assert.deepEqual(items[1], { icon: "sun", value: 24, tone: "blue", label: "Week (all)" });
  assert.deepEqual(items[2], { icon: "star", value: 91, tone: "red", label: "Week (Fable)" });

  // utilization is rounded and clamped to the HUD's 0-100 range
  const rounded = hudItemsFromPayload({ stale: false, buckets: [{ id: "session", label: "Session", utilization: 71.6 }], models: [] });
  assert.equal(rounded[0].value, 72);
  const clamped = hudItemsFromPayload({ stale: false, buckets: [{ id: "session", label: "Session", utilization: 130 }], models: [] });
  assert.equal(clamped[0].value, 100);

  // at most 4 HUD items; stale turns every tone slate
  const many = hudItemsFromPayload({
    stale: true,
    buckets: [1, 2, 3, 4, 5].map((n) => ({ id: `weekly_scoped:${n}`, label: `W${n}`, utilization: 10 * n })),
    models: [],
  });
  assert.equal(many.length, 4);
  assert.ok(many.every((item) => item.tone === "slate"));

  // garbage payloads degrade to no items
  assert.deepEqual(hudItemsFromPayload(null), []);
  assert.deepEqual(hudItemsFromPayload({ buckets: "nope" }), []);

  // modelDisplayName: strip claude- prefix and date suffix, dot the version
  assert.equal(modelDisplayName("claude-fable-5"), "Fable 5");
  assert.equal(modelDisplayName("claude-opus-4-8"), "Opus 4.8");
  assert.equal(modelDisplayName("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(modelDisplayName("something-else"), "something-else");

  // formatTokens: compact k/M formatting
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(12_400), "12.4k");
  assert.equal(formatTokens(5_100_000), "5.1M");
}

// 2) Start subscribes; first payload pins the HUD, later payloads update it
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 100_000_000_000 });
  await h.start();
  assert.equal(h.calls.bubbles.length, 0, "no HUD before the first agent:usage payload");

  await h.emit("agent:usage", samplePayload);
  await tick();
  assert.equal(h.calls.bubbles.length, 1);
  const hud = h.calls.bubbles[0];
  assert.equal(hud.spec.sticky, true);
  assert.equal(hud.spec.pin, true);
  assert.deepEqual(hud.spec.dismissOn, [], "HUD must not dismiss on click");
  assert.equal(hud.spec.hud.items.length, 3);
  assert.deepEqual(hud.spec.hud.items[0], { icon: "timer", value: 72, tone: "amber", label: "Session" });

  // A later payload updates the pinned bubble in place instead of stacking a new one.
  await h.emit("agent:usage", { ...samplePayload, buckets: [{ id: "session", label: "Session", utilization: 80 }] });
  await tick();
  assert.equal(h.calls.bubbles.length, 1, "HUD bubble is updated, not re-created");
  assert.equal(h.calls.bubbles[0].spec.hud.items[0].value, 80);

  h.expectNoErrors();
}

// 3) Details command opens the panel and feeds it usage messages
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 100_000_000_000 });
  await h.start();
  await h.emit("agent:usage", samplePayload);
  await tick();

  await h.runCommand("details");
  assert.ok(h.calls.panelMessages.length >= 1, "panel receives the current payload on open");
  const first = h.calls.panelMessages[h.calls.panelMessages.length - 1];
  assert.equal(first.type, "usage");
  assert.equal(first.payload.buckets.length, 3);
  assert.equal(first.payload.models[0].model, "claude-fable-5");
  assert.ok(first.theme === "light" || first.theme === "dark");

  // Panel announces readiness -> plugin re-sends the latest payload.
  const before = h.calls.panelMessages.length;
  h.panel.sendToPlugin({ type: "ready" });
  await tick();
  assert.ok(h.calls.panelMessages.length > before, "ready triggers a usage re-send");

  // New payloads stream to the open panel.
  const beforeEmit = h.calls.panelMessages.length;
  await h.emit("agent:usage", { ...samplePayload, stale: true });
  await tick();
  assert.ok(h.calls.panelMessages.length > beforeEmit, "payload updates reach the open panel");
  const last = h.calls.panelMessages[h.calls.panelMessages.length - 1];
  assert.equal(last.payload.stale, true);

  h.expectNoErrors();
}

// 4) Stale payloads grey out the HUD
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 100_000_000_000 });
  await h.start();
  await h.emit("agent:usage", { ...samplePayload, stale: true });
  await tick();
  const hud = h.calls.bubbles[0];
  assert.ok(hud.spec.hud.items.every((item) => item.tone === "slate"));
  h.expectNoErrors();
}

// 5) Toggle command hides the HUD while the plugin keeps running
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 100_000_000_000 });
  await h.start();
  await h.emit("agent:usage", samplePayload);
  await tick();
  assert.equal(h.calls.bubbles.length, 1);

  await h.runCommand("toggle-widget");
  await tick();
  assert.equal(h.calls.bubbles[0].dismissed, true, "toggle dismisses the pinned HUD");
  assert.equal(h.calls.storage.get("hudHidden"), true, "hidden state is persisted");

  // Payloads keep flowing but no HUD reappears while hidden.
  await h.emit("agent:usage", { ...samplePayload, buckets: [{ id: "session", label: "Session", utilization: 55 }] });
  await tick();
  assert.equal(h.calls.bubbles.length, 1, "no HUD while hidden");

  // The right-click details panel still works while hidden.
  await h.runCommand("details");
  assert.ok(h.calls.panelMessages.length >= 1, "details panel available while HUD is hidden");
  assert.equal(h.calls.panelMessages[h.calls.panelMessages.length - 1].payload.buckets[0].utilization, 55, "panel gets the latest payload");

  // Toggling back re-pins the HUD with the latest data.
  await h.runCommand("toggle-widget");
  await tick();
  assert.equal(h.calls.bubbles.length, 2, "HUD re-pinned after toggling back");
  assert.equal(h.calls.bubbles[1].spec.hud.items[0].value, 55);
  assert.equal(h.calls.storage.get("hudHidden"), false);

  h.expectNoErrors();
}

// 5b) Hidden state survives a restart
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 100_000_000_000 });
  await h.ctx.storage.set("hudHidden", true);
  await h.start();
  await h.emit("agent:usage", samplePayload);
  await tick();
  assert.equal(h.calls.bubbles.length, 0, "HUD stays hidden after restart");
  h.expectNoErrors();
}

// 6) Standalone widget config pins the HUD to a dedicated spawned pet
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 100_000_000_000, config: { standaloneWidget: true } });
  await h.start();
  await h.emit("agent:usage", samplePayload);
  await tick();
  assert.deepEqual(h.calls.spawnedPets, ["usage-widget"], "standalone mode spawns the widget pet");
  assert.equal(h.calls.bubbles.length, 1);
  assert.notEqual(h.calls.bubbles[0].petId, "default", "HUD is pinned to the widget pet, not the default pet");
  h.expectNoErrors();
}

// 6b) Switching standalone mode at runtime moves the HUD
{
  const h = createTestHarness(register, { permissions: PERMISSIONS, locales: LOCALES, nowMs: 100_000_000_000 });
  await h.start();
  await h.emit("agent:usage", samplePayload);
  await tick();
  assert.equal(h.calls.bubbles[0].petId, "default");

  await h.setConfig({ standaloneWidget: true });
  await tick();
  assert.equal(h.calls.spawnedPets.length, 1, "widget pet spawned on config switch");
  assert.equal(h.calls.bubbles[0].dismissed, true, "old HUD dismissed on switch");
  assert.equal(h.calls.bubbles.length, 2);
  assert.notEqual(h.calls.bubbles[1].petId, "default");

  await h.setConfig({ standaloneWidget: false });
  await tick();
  assert.equal(h.calls.bubbles.length, 3);
  assert.equal(h.calls.bubbles[2].petId, "default", "HUD returns to the default pet");

  h.expectNoErrors();
}

console.log("openpets.claude-usage: all checks passed.");
