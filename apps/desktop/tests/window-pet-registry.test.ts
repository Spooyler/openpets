import assert from "node:assert/strict";
import { WindowPetRegistry, windowKeyForIdentity } from "../src/window-pet-registry.js";

assert.equal(windowKeyForIdentity(77, 500), "w:77");
assert.equal(windowKeyForIdentity(undefined, 500), "p:500");

interface Call { fn: string; args: unknown[] }
const calls: Call[] = [];
const cb = {
  spawnPet: (...args: unknown[]) => calls.push({ fn: "spawn", args }),
  closePet: (...args: unknown[]) => calls.push({ fn: "close", args }),
  rebindPet: (...args: unknown[]) => calls.push({ fn: "rebind", args }),
  sessionEndedNotice: (...args: unknown[]) => calls.push({ fn: "notice", args }),
};
let alive = true;
let now = 1_000;
const registry = new WindowPetRegistry({
  callbacks: cb,
  now: () => now,
  isPidAlive: () => alive,
  drawPoolPet: (occupied) => (occupied.has("cat") ? (occupied.has("dog") ? null : "dog") : "cat"),
});

const s1 = { sessionKey: "100:n1", leaseId: "L1", terminalOwnerPid: 500, terminalWindowId: 77, label: "fraud_project" };
const s2 = { sessionKey: "200:n2", leaseId: "L2", terminalOwnerPid: 500, terminalWindowId: 77, label: "fraud_project" };
const s3 = { sessionKey: "300:n3", leaseId: "L3", terminalOwnerPid: 900, terminalWindowId: 88, label: "api-fix" };

// Explicit bind; second session in same window joins without a second spawn.
assert.equal(registry.onSessionIdentified(s1, "cat", false), "cat");
assert.equal(registry.onSessionIdentified(s2, undefined, false), "cat", "joins existing binding");
assert.deepEqual(calls.map((c) => c.fn), ["spawn"]);
assert.equal(registry.petForWindow("w:77"), "cat");
assert.equal(registry.windowForPet("cat"), "w:77");

// Session without explicit pet in a new window, pool off → default coverage.
assert.equal(registry.onSessionIdentified(s3, undefined, false), null);
assert.equal(registry.storeForSession("300:n3"), registry.defaultStore);

// Pool on → new window draws pool pet; occupied excludes drawing "cat".
const s4 = { sessionKey: "400:n4", leaseId: "L4", terminalOwnerPid: 901, terminalWindowId: 89, label: "docs" };
assert.equal(registry.onSessionIdentified(s4, undefined, true), "dog");

// Adopt a pet bound elsewhere → old binding closes with "rebind", pet moves.
calls.length = 0;
registry.onSessionAdopted(s3, "cat");
assert.deepEqual(calls.map((c) => c.fn), ["close", "spawn"]);
assert.equal((calls[0]!.args as string[])[2], "rebind");
assert.equal(registry.petForWindow("w:88"), "cat");
assert.equal(registry.petForWindow("w:77"), null, "old window unbound");
assert.equal(registry.storeForSession("100:n1"), registry.defaultStore, "orphaned sessions fall to default");

// Notifications route to binding store; window focus resolves them.
registry.storeForSession("300:n3").record({ sessionKey: "300:n3", windowKey: "w:88", kind: "waiting", message: "needs permission", label: "api-fix" });
assert.equal(registry.storeForPet("cat")?.unresolvedCount(), 1);
assert.deepEqual(registry.resolveWindowFocus("w:88"), ["cat"]);
assert.equal(registry.storeForPet("cat")?.unresolvedCount(), 0);

// Focus target: oldest unresolved wins, else freshest activity.
registry.storeForPet("cat")?.record({ sessionKey: "300:n3", windowKey: "w:88", kind: "error", message: "boom", label: "api-fix" });
assert.deepEqual(registry.focusTargetForPet("cat"), { terminalOwnerPid: 900, terminalWindowId: 88 });

// User close: binding gone, heartbeat-driven re-identify does NOT respawn without explicit request.
calls.length = 0;
registry.onUserClosedPet("w:88");
assert.deepEqual(calls.map((c) => c.fn), ["close"]);
assert.equal((calls[0]!.args as string[])[2], "user-closed");
assert.equal(registry.onSessionIdentified(s3, undefined, true), null, "pool skips user-closed window");
assert.equal(registry.onSessionIdentified(s3, "cat", false), "cat", "explicit adopt re-binds");

// Teardown: last session out, window alive → notice + close(session-ended).
calls.length = 0;
registry.onSessionGone("300:n3");
assert.deepEqual(calls.map((c) => c.fn), ["notice", "close"]);
assert.equal((calls[1]!.args as string[])[2], "session-ended");

// Window dead → instant close, no notice.
calls.length = 0;
alive = false;
registry.onSessionGone("400:n4");
assert.deepEqual(calls.map((c) => c.fn), ["close"]);
assert.equal((calls[0]!.args as string[])[2], "window-dead");

console.log("Window pet registry passed.");
