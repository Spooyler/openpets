import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { OpenPetsClient, OpenPetsReaction } from "@open-pets/client";

import plugin, { openPetsOpenCodePluginId } from "./plugin.js";
import { classifyOpenCodeBusEvent, classifyOpenCodeToolReaction, createOpenPetsOpenCodeHooks, getDefaultOpenCodeThrottlePath, shouldIgnoreOpenPetsTool } from "./opencode-plugin-runtime.js";

assert.equal(plugin.id, openPetsOpenCodePluginId);
assert.equal(typeof plugin.server, "function");
const packagePlugin = await import("@open-pets/opencode/server");
assert.equal(packagePlugin.default.id, openPetsOpenCodePluginId);
assert.equal(typeof packagePlugin.default.server, "function");

assert.equal(classifyOpenCodeToolReaction("edit", {}), "editing");
assert.equal(classifyOpenCodeToolReaction("apply_patch", {}), "editing");
assert.equal(classifyOpenCodeToolReaction("bash", { command: "pnpm test" }), "testing");
assert.equal(classifyOpenCodeToolReaction("shell", { command: "ls" }), undefined);
assert.equal(classifyOpenCodeToolReaction("read", {}), undefined);
assert.equal(shouldIgnoreOpenPetsTool("openpets_openpets_status"), true);
assert.equal(shouldIgnoreOpenPetsTool("openpets_openpets_say"), true);
assert.equal(shouldIgnoreOpenPetsTool("openpets_openpets_react"), true);
assert.equal(shouldIgnoreOpenPetsTool("openpets_status"), true);
assert.deepEqual(classifyOpenCodeBusEvent({ type: "permission.asked" }), { reaction: "waiting", speechCategory: "permission" });
assert.equal(classifyOpenCodeBusEvent({ type: "permission.asked", properties: { permission: "openpets_openpets_say" } }), undefined);
assert.equal(classifyOpenCodeBusEvent({ payload: { type: "permission.asked", properties: { patterns: ["openpets_openpets_react"] } } }), undefined);
assert.deepEqual(classifyOpenCodeBusEvent({ type: "session.error" }), { reaction: "error", speechCategory: "error" });
assert.deepEqual(classifyOpenCodeBusEvent({ type: "session.status", properties: { status: { type: "idle" } } }), { reaction: "success" });
assert.ok(getDefaultOpenCodeThrottlePath().includes("opencode-hook-throttle.json"));

assert.throws(() => createOpenPetsOpenCodeHooks({ pet: "bad/pet" }));

const dir = mkdtempSync(join(tmpdir(), "openpets-opencode-plugin-"));
try {
  const calls: Array<{ readonly kind: string; readonly value: string; readonly leaseId?: string; readonly requestedPetId?: string }> = [];
  let releaseBlockedReact: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { releaseBlockedReact = resolve; });
  const client: OpenPetsClient = {
    hello: async () => ({}),
    status: async () => ({ ok: true, appRunning: true }),
    listPets: async () => ({ ok: true, pets: [], defaultPetId: "builtin" }),
    installPet: async () => { throw new Error("unused"); },
    installLocalPet: async () => { throw new Error("unused"); },
    acquireLease: async (options?: { readonly requestedPetId?: string }) => {
      calls.push({ kind: "lease", value: "acquire", requestedPetId: options?.requestedPetId });
      return { leaseId: "lease-fixer", requestedPetId: options?.requestedPetId, targetKind: "explicit", actualTargetPetId: options?.requestedPetId ?? "builtin", actualTargetPetName: "Fixer", usingDefaultPet: false, expiresAt: Date.now() + 15_000, leaseActive: true };
    },
    heartbeatLease: async () => ({ leaseId: "lease-fixer", expiresAt: Date.now() + 15_000 }),
    releaseLease: async () => ({ released: true }),
    react: async (reaction: OpenPetsReaction, options?: { readonly leaseId?: string }) => {
      calls.push({ kind: "react", value: reaction, leaseId: options?.leaseId });
      await blocked;
    },
    say: async (message: string, options?: { readonly leaseId?: string }) => {
      calls.push({ kind: "say", value: message, leaseId: options?.leaseId });
    },
  };

  const scheduled: Array<() => Promise<void>> = [];
  const hooks = createOpenPetsOpenCodeHooks({ pet: "fixer", clientFactory: () => client, schedule: (work) => { scheduled.push(work); }, throttlePath: join(dir, "opencode-hook-throttle.json"), now: () => 100_000, random: () => 0 });
  hooks["chat.message"]({}, { message: { text: "do not use this prompt" } });
  assert.equal(scheduled.length, 1);
  const thinkingWork = scheduled.shift();
  const thinkingPromise = thinkingWork?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls[0], { kind: "lease", value: "acquire", requestedPetId: "fixer" });
  assert.deepEqual(calls[1], { kind: "react", value: "thinking", leaseId: "lease-fixer" });
  releaseBlockedReact?.();
  await thinkingPromise;
  releaseBlockedReact = undefined;

  hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "pnpm test -- --secret" } });
  assert.equal(scheduled.length, 1);
  const work = scheduled.shift();
  const promise = work?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls.at(-1), { kind: "react", value: "testing", leaseId: "lease-fixer" });
  await promise;

  hooks["tool.execute.before"]({ tool: "shell" }, { args: { command: "ls" } });
  assert.equal(scheduled.length, 0);
  hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "pnpm test" } });
  assert.equal(scheduled.length, 1);
  const beforeDuplicateTesting = calls.length;
  await scheduled.shift()?.();
  assert.equal(calls.length, beforeDuplicateTesting, "duplicate testing reaction should be throttled without lease/client work");

  const beforeIgnored = scheduled.length;
  hooks["tool.execute.before"]({ tool: "openpets_openpets_say" }, { args: {} });
  assert.equal(scheduled.length, beforeIgnored);

  hooks.event({ event: { type: "permission.asked", properties: { prompt: "never speak this" } } });
  assert.equal(scheduled.length, 1);
  await scheduled.shift()?.();
  assert.deepEqual(calls.at(-1), { kind: "say", value: "Approval needed", leaseId: "lease-fixer" });

  hooks.event({ event: { type: "session.status", properties: { status: { type: "idle" } } } });
  assert.equal(scheduled.length, 1);
  await scheduled.shift()?.();
  assert.deepEqual(calls.at(-1), { kind: "react", value: "success", leaseId: "lease-fixer" });

  const errors: string[] = [];
  const failingHooks = createOpenPetsOpenCodeHooks({ clientFactory: () => { throw new Error("api_key=secret /tmp/path"); }, schedule: (work) => { void work(); }, debug: true, debugLog: (message) => errors.push(message), throttlePath: join(dir, "fail-throttle.json"), now: () => 200_000 });
  assert.doesNotThrow(() => failingHooks.event({ event: { type: "session.error" } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(errors.join("\n"), /<redacted>|<path>/);

  const throwingSchedule = createOpenPetsOpenCodeHooks({ schedule: () => { throw new Error("schedule failed"); }, debug: true, debugLog: (message) => errors.push(message) });
  assert.doesNotThrow(() => throwingSchedule.event({ event: { type: "session.error" } }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const loaded = await plugin.server({}, { pet: "fixer" });
assert.equal(typeof loaded.event, "function");
assert.equal(typeof loaded["chat.message"], "function");
assert.equal(typeof loaded["tool.execute.before"], "function");

console.error("OpenCode plugin validation passed.");
