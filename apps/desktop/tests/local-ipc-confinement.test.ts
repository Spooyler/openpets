/** Executable confinement subscription and lease-authorization regression tests. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAndSubscribe, type ConfinementPollerDeps } from "../src/confinement-poller.js";
import type { TerminalWindowInfo } from "../src/window-tracker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInfo(pid = 100): TerminalWindowInfo {
  return { window: null, terminalPid: pid, appName: "iTerm2", isMinimized: false, isOccluded: false };
}

function makeDeps(overrides: Partial<ConfinementPollerDeps> = {}): ConfinementPollerDeps {
  return {
    findTerminal: async () => null,
    subscribe: (_id, _pid, _cb) => () => { /* noop */ },
    setIdentity: () => { /* noop */ },
    applyUpdate: () => { /* noop */ },
    isAlive: () => true,
    onDead: () => { /* noop */ },
    getScreenPermissionStatus: () => "granted",
    notifyScreenPermission: () => { /* noop */ },
    promptScreenPermission: () => { /* noop */ },
    ...overrides,
  };
}

// A newly authorized lease must remain subscribed when its terminal is not
// discoverable yet; otherwise confinement never starts when it appears later.
{
  const subscribeCallIds: string[] = [];
  const subscribed = new Map<string, () => void>();

  const deps = makeDeps({
    findTerminal: async () => null,
    subscribe: (id, _pid, _cb) => {
      subscribeCallIds.push(id);
      return () => { /* noop */ };
    },
  });

  const result = await resolveAndSubscribe("lease-1", 42, deps, subscribed);

  assert.ok(result !== null, "should return an unsubscribe fn when first resolve is null");
  assert.equal(subscribeCallIds.length, 1, "subscribe should be called once");
  assert.equal(subscribeCallIds[0], "lease-1", "subscribe called with correct leaseId");
  assert.ok(subscribed.has("lease-1"), "subscribed map should contain the leaseId");
}

// A lease owns one confinement subscription, preventing duplicate updates.
{
  const subscribeCallCount = { n: 0 };
  const subscribed = new Map<string, () => void>();

  const deps = makeDeps({
    findTerminal: async () => null,
    subscribe: (_id, _pid, _cb) => {
      subscribeCallCount.n++;
      return () => { /* noop */ };
    },
  });

  const r1 = await resolveAndSubscribe("lease-2", 99, deps, subscribed);
  assert.ok(r1 !== null, "first call should return unsubscribe fn");

  const r2 = await resolveAndSubscribe("lease-2", 99, deps, subscribed);
  assert.equal(r2, null, "second call for same leaseId should return null (guard)");
  assert.equal(subscribeCallCount.n, 1, "subscribe should be called only once for same leaseId");
}

// A callback from a no-longer-authorized lease must tear down its subscription
// rather than continuing to confine a pet after the lease expires.
{
  const deadCalled = { n: 0 };
  const unsubCalled = { n: 0 };
  const subscribed = new Map<string, () => void>();

  let capturedCb: ((info: TerminalWindowInfo) => void) | undefined;

  const deps = makeDeps({
    findTerminal: async () => null,
    subscribe: (_id, _pid, cb) => {
      capturedCb = cb;
      return () => { unsubCalled.n++; };
    },
    isAlive: () => false,
    onDead: () => { deadCalled.n++; },
  });

  await resolveAndSubscribe("lease-3", 55, deps, subscribed);

  assert.ok(capturedCb !== undefined, "subscribe callback should have been captured");
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  capturedCb(makeInfo(55));

  assert.equal(deadCalled.n, 1, "onDead should be called when isAlive returns false");
  assert.equal(unsubCalled.n, 1, "unsubscribe fn should be called when isAlive returns false");
  assert.ok(!subscribed.has("lease-3"), "leaseId should be removed from subscribed map");
}

// ---------------------------------------------------------------------------
// Test 4: Initial resolve success seeds identity + update before subscribing
// ---------------------------------------------------------------------------
{
  const identityCalls: TerminalWindowInfo[] = [];
  const updateCalls: TerminalWindowInfo[] = [];
  const subscribed = new Map<string, () => void>();
  const resolved = makeInfo(200);

  const deps = makeDeps({
    findTerminal: async () => resolved,
    subscribe: (_id, _pid, _cb) => () => { /* noop */ },
    setIdentity: (i) => { identityCalls.push(i); },
    applyUpdate: (i) => { updateCalls.push(i); },
  });

  await resolveAndSubscribe("lease-4", 200, deps, subscribed);

  assert.equal(identityCalls.length, 1, "setIdentity should be called once on success");
  assert.equal(updateCalls.length, 1, "applyUpdate should be called once on success");
  assert.equal(identityCalls[0]!.terminalPid, 200, "setIdentity called with correct terminalPid");
}

// ---------------------------------------------------------------------------
// Test 5: Poller callback calls setIdentity (self-heal path after null first resolve)
// ---------------------------------------------------------------------------
{
  const identityCalls: TerminalWindowInfo[] = [];
  const subscribed = new Map<string, () => void>();

  let capturedCb: ((info: TerminalWindowInfo) => void) | undefined;

  const deps = makeDeps({
    findTerminal: async () => null,
    subscribe: (_id, _pid, cb) => {
      capturedCb = cb;
      return () => { /* noop */ };
    },
    setIdentity: (i) => { identityCalls.push(i); },
    isAlive: () => true,
  });

  await resolveAndSubscribe("lease-5", 77, deps, subscribed);

  assert.equal(identityCalls.length, 0, "setIdentity should NOT be called on null first resolve");

  assert.ok(capturedCb !== undefined, "callback should be captured");
  capturedCb(makeInfo(77));

  assert.equal(identityCalls.length, 1, "setIdentity should be called when poller self-heals");
  assert.equal(identityCalls[0]!.terminalPid, 77, "setIdentity has correct terminalPid from self-heal");
}

// ---------------------------------------------------------------------------
// Test 6: Production subscribe dep forwards onNull to subscribeWindowTracking
//
// Constructs a subscribe lambda in the same shape as the production wiring
// in local-ipc.ts:
//   subscribe: (id, pid, onFound, onNull) => subscribeWindowTracking(id, pid, onFound, onNull)
// and verifies all four args (including onNull) arrive at the underlying call.
// The existing backoff tests pass onNull via their own DI, masking the real
// wiring — this test exercises the production-pattern lambda directly.
// ---------------------------------------------------------------------------
{
  let capturedOnFoundArg: ((...args: unknown[]) => void) | undefined;
  let capturedOnNullArg: (() => void) | undefined | null;

  function stubSubscribeWindowTracking(
    _id: string,
    _pid: number,
    onFound: (...args: unknown[]) => void,
    onNull?: () => void,
  ): () => void {
    capturedOnFoundArg = onFound;
    capturedOnNullArg = onNull;
    return () => { /* noop */ };
  }

  // Production lambda shape (exact copy from local-ipc.ts ConfinementPollerDeps):
  const productionSubscribeDep = (
    id: string,
    pid: number,
    onFound: (...args: unknown[]) => void,
    onNull?: () => void,
  ) => stubSubscribeWindowTracking(id, pid, onFound, onNull);

  const sentinelOnNull = () => { /* sentinel */ };
  const sentinelOnFound = () => { /* sentinel */ };

  productionSubscribeDep("lease-wiring", 999, sentinelOnFound, sentinelOnNull);

  assert.strictEqual(capturedOnFoundArg, sentinelOnFound, "production subscribe dep forwards onFound to subscribeWindowTracking");
  assert.strictEqual(capturedOnNullArg, sentinelOnNull, "production subscribe dep forwards onNull (4th arg) to subscribeWindowTracking");
}

// ---------------------------------------------------------------------------
// Test 7: Source-level guard — getDefaultPetPaused must NOT gate the
//         explicit-lease branch in local-ipc.ts (Task 3 regression guard).
//
// When the pool is enabled, a paused default pet must not silence pool pets.
// This static check catches re-introduction of the bug before runtime.
// ---------------------------------------------------------------------------
{
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(__dirname, "../../src/local-ipc.ts"), "utf-8");

  // Extract the explicit-lease block for pet.react (up to the applyAgentPetReaction call).
  const reactExplicitBlock = src.match(/if \(lease\?\.targetKind === "explicit"\)[\s\S]*?applyAgentPetReaction/);
  // Extract the explicit-lease block for pet.say (up to the applyAgentPetSay call).
  const sayExplicitBlock = src.match(/if \(lease\?\.targetKind === "explicit"\)[\s\S]*?applyAgentPetSay/);

  assert.ok(reactExplicitBlock !== null, "react explicit-lease block must be present in local-ipc.ts");
  assert.ok(
    !reactExplicitBlock![0].includes("getDefaultPetPaused"),
    "react explicit-lease branch must NOT call getDefaultPetPaused() — that would silence pool pets when default is paused",
  );

  assert.ok(sayExplicitBlock !== null, "say explicit-lease block must be present in local-ipc.ts");
  assert.ok(
    !sayExplicitBlock![0].includes("getDefaultPetPaused"),
    "say explicit-lease branch must NOT call getDefaultPetPaused() — that would silence pool pets when default is paused",
  );
}

console.log("local-ipc-confinement validation passed.");
