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

// Regression: identity change (stale window detach) must keep the session's
// notification row following its coverage — not stranded in defaultStore.
{
  const calls2: Call[] = [];
  const cb2 = {
    spawnPet: (...args: unknown[]) => calls2.push({ fn: "spawn", args }),
    closePet: (...args: unknown[]) => calls2.push({ fn: "close", args }),
    rebindPet: (...args: unknown[]) => calls2.push({ fn: "rebind", args }),
    sessionEndedNotice: (...args: unknown[]) => calls2.push({ fn: "notice", args }),
  };
  const registry2 = new WindowPetRegistry({
    callbacks: cb2,
    now: () => now,
    isPidAlive: () => alive,
    drawPoolPet: () => null,
  });

  const s5 = { sessionKey: "500:n5", leaseId: "L5", terminalOwnerPid: 700, terminalWindowId: 77, label: "fraud_project" };
  assert.equal(registry2.onSessionIdentified(s5, "cat", false), "cat");
  registry2.storeForSession("500:n5").record({ sessionKey: "500:n5", windowKey: "w:77", kind: "waiting", message: "needs permission", label: "fraud_project" });
  assert.equal(registry2.storeForPet("cat")?.unresolvedCount(), 1);

  // Same sessionKey re-identified with a different terminalWindowId → new windowKey.
  const s5moved = { ...s5, terminalWindowId: 78 };
  assert.equal(registry2.onSessionIdentified(s5moved, "cat", false), "cat");

  assert.equal(registry2.petForWindow("w:78"), "cat", "pet moved to the new window key");
  assert.equal(registry2.petForWindow("w:77"), null, "old window key unbound");
  const movedRows = registry2.storeForPet("cat")?.rows() ?? [];
  assert.ok(
    movedRows.some((row) => row.sessionKey === "500:n5"),
    "notification row followed the session into the new binding store",
  );
  const strandedRows = registry2.defaultStore.rows().filter((row) => row.sessionKey === "500:n5");
  assert.deepEqual(strandedRows, [], "no row stranded in defaultStore for the migrated session");
}

// sessionFocusTarget: row-level focus must resolve the clicked session's own
// window, whether it's parked in default coverage or tracked under a binding
// — not the aggregate target for the pet/default coverage as a whole.
{
  const calls3: Call[] = [];
  const cb3 = {
    spawnPet: (...args: unknown[]) => calls3.push({ fn: "spawn", args }),
    closePet: (...args: unknown[]) => calls3.push({ fn: "close", args }),
    rebindPet: (...args: unknown[]) => calls3.push({ fn: "rebind", args }),
    sessionEndedNotice: (...args: unknown[]) => calls3.push({ fn: "notice", args }),
  };
  const registry3 = new WindowPetRegistry({
    callbacks: cb3,
    now: () => now,
    isPidAlive: () => alive,
    drawPoolPet: () => null,
  });

  const s6 = { sessionKey: "600:n6", leaseId: "L6", terminalOwnerPid: 111, terminalWindowId: 22, label: "default-covered" };
  assert.equal(registry3.onSessionIdentified(s6, undefined, false), null, "no pool, no explicit → default coverage");
  assert.deepEqual(
    registry3.sessionFocusTarget("600:n6"),
    { terminalOwnerPid: 111, terminalWindowId: 22 },
    "found in default coverage",
  );

  const s7 = { sessionKey: "700:n7", leaseId: "L7", terminalOwnerPid: 222, terminalWindowId: 33, label: "bound" };
  assert.equal(registry3.onSessionIdentified(s7, "fox", false), "fox");
  assert.deepEqual(
    registry3.sessionFocusTarget("700:n7"),
    { terminalOwnerPid: 222, terminalWindowId: 33 },
    "found in a binding's own sessions, independent of the binding's aggregate target",
  );

  assert.equal(registry3.sessionFocusTarget("unknown-key"), null, "unknown session key returns null");
}

// --- Task 3 scenarios: project memory, explicit-default, assignPetToWindow ---
function makeRecorder() {
  const recorded: Call[] = [];
  return {
    recorded,
    cb: {
      spawnPet: (...args: unknown[]) => recorded.push({ fn: "spawn", args }),
      closePet: (...args: unknown[]) => recorded.push({ fn: "close", args }),
      rebindPet: (...args: unknown[]) => recorded.push({ fn: "rebind", args }),
      sessionEndedNotice: (...args: unknown[]) => recorded.push({ fn: "notice", args }),
    },
  };
}

// Memory beats pool; pool draw reports via onPoolPetDrawn.
{
  const { recorded, cb } = makeRecorder();
  const drawn: Array<[string | undefined, string]> = [];
  const reg = new WindowPetRegistry({
    callbacks: cb,
    isPidAlive: () => true,
    drawPoolPet: () => "poolpet",
    resolveRememberedPet: (cwd) => (cwd === "/proj/a" ? "membot" : null),
    onPoolPetDrawn: (cwd, petId) => drawn.push([cwd, petId]),
  });
  const sA = { sessionKey: "1:a", leaseId: "LA", terminalOwnerPid: 10, terminalWindowId: 1, label: "a", cwd: "/proj/a" };
  assert.equal(reg.onSessionIdentified(sA, undefined, true), "membot", "memory wins over pool");
  assert.deepEqual(recorded.map((c) => c.fn), ["spawn"]);
  assert.deepEqual(drawn, [], "no pool draw when memory hit");
  const sB = { sessionKey: "2:b", leaseId: "LB", terminalOwnerPid: 20, terminalWindowId: 2, label: "b", cwd: "/proj/b" };
  assert.equal(reg.onSessionIdentified(sB, undefined, true), "poolpet", "no memory → pool draw");
  assert.deepEqual(drawn, [["/proj/b", "poolpet"]], "pool draw reported with cwd");
}

// Memory respects user-closed windows and is skipped when pool disabled? No —
// memory applies regardless of poolEnabled; only user-closed suppresses it.
{
  const { cb } = makeRecorder();
  const reg = new WindowPetRegistry({
    callbacks: cb,
    isPidAlive: () => true,
    resolveRememberedPet: () => "membot",
  });
  const s = { sessionKey: "3:c", leaseId: "LC", terminalOwnerPid: 30, terminalWindowId: 3, label: "c", cwd: "/proj/c" };
  assert.equal(reg.onSessionIdentified(s, undefined, false), "membot", "memory applies with pool off");
  reg.onUserClosedPet("w:3");
  const s2 = { sessionKey: "4:d", leaseId: "LD", terminalOwnerPid: 30, terminalWindowId: 3, label: "d", cwd: "/proj/c" };
  assert.equal(reg.onSessionIdentified(s2, undefined, false), null, "user-closed window suppresses memory bind");
}

// Explicit-default (null): unbinds, marks user-closed, session falls to default coverage.
{
  const { recorded, cb } = makeRecorder();
  const reg = new WindowPetRegistry({ callbacks: cb, isPidAlive: () => true });
  const s = { sessionKey: "5:e", leaseId: "LE", terminalOwnerPid: 50, terminalWindowId: 5, label: "e" };
  assert.equal(reg.onSessionIdentified(s, "fox", false), "fox");
  recorded.length = 0;
  assert.equal(reg.onSessionIdentified(s, null, true), null, "null → default coverage");
  assert.deepEqual(recorded.map((c) => c.fn), ["close"], "binding closed");
  assert.equal((recorded[0]!.args as unknown[])[2], "user-closed", "close reason user-closed");
  assert.equal(reg.petForWindow("w:5"), null);
  // Pool must not re-draw for this window afterwards.
  const s2 = { sessionKey: "6:f", leaseId: "LF", terminalOwnerPid: 50, terminalWindowId: 5, label: "f" };
  assert.equal(reg.onSessionIdentified(s2, undefined, true), null, "no re-draw after explicit default");
}

// assignPetToWindow: bind parked default sessions; move; unbind.
{
  const { recorded, cb } = makeRecorder();
  const reg = new WindowPetRegistry({ callbacks: cb, isPidAlive: () => true });
  const s1 = { sessionKey: "7:g", leaseId: "LG", terminalOwnerPid: 70, terminalWindowId: 7, label: "g" };
  const s2 = { sessionKey: "8:h", leaseId: "LH", terminalOwnerPid: 80, terminalWindowId: 8, label: "h" };
  assert.equal(reg.onSessionIdentified(s1, undefined, false), null, "parked on default");
  assert.equal(reg.assignPetToWindow("w:7", "fox"), true, "binds parked sessions");
  assert.equal(reg.petForWindow("w:7"), "fox");
  assert.equal(reg.displayPetForSession("7:g")?.petId, "fox", "session attached to new binding");
  // Move semantics: assigning fox to another window steals it.
  assert.equal(reg.onSessionIdentified(s2, undefined, false), null);
  recorded.length = 0;
  assert.equal(reg.assignPetToWindow("w:8", "fox"), true, "move steals from w:7");
  assert.equal(reg.petForWindow("w:7"), null);
  assert.equal(reg.petForWindow("w:8"), "fox");
  assert.equal(reg.displayPetForSession("7:g"), null, "stolen-from window's session falls to default coverage");
  // Unbind: sessions fall to default, window suppressed.
  assert.equal(reg.assignPetToWindow("w:8", null), true, "unbind succeeds");
  assert.equal(reg.petForWindow("w:8"), null);
  assert.equal(reg.onSessionIdentified(s2, undefined, true), null, "no pool re-draw after UI default");
  // Assigning to a window with no sessions at all fails.
  assert.equal(reg.assignPetToWindow("w:99", "fox"), false, "no sessions → false");
}

// Regression: assignPetToWindow must validate the target window BEFORE
// stealing the pet from wherever it's currently bound. A stale UI snapshot
// (target window's sessions all disconnected between render and click) must
// fail cleanly, without stealing from the source window or clearing the
// target window's user-closed suppression.
{
  const { recorded, cb } = makeRecorder();
  const reg = new WindowPetRegistry({
    callbacks: cb,
    isPidAlive: () => true,
    drawPoolPet: (occupied) => (occupied.has("dog") ? null : "dog"),
  });
  const sBound = { sessionKey: "9:i", leaseId: "LI", terminalOwnerPid: 90, terminalWindowId: 9, label: "i" };
  assert.equal(reg.onSessionIdentified(sBound, "fox", false), "fox", "fox bound to w:9");
  reg.onUserClosedPet("w:10");
  recorded.length = 0;
  assert.equal(reg.assignPetToWindow("w:10", "fox"), false, "target window has no sessions to accept the pet");
  assert.deepEqual(recorded.map((c) => c.fn), [], "no steal, no rebind — validation failed before any mutation");
  assert.equal(reg.petForWindow("w:9"), "fox", "fox's original binding is untouched");
  // If the failed assign had wrongly cleared w:10's user-closed suppression,
  // this pool draw would succeed instead of staying suppressed.
  const s10 = { sessionKey: "10:j", leaseId: "LJ", terminalOwnerPid: 100, terminalWindowId: 10, label: "j" };
  assert.equal(reg.onSessionIdentified(s10, undefined, true), null, "w:10's user-closed suppression was not touched by the failed assign");
}

console.log("Window pet registry passed.");
