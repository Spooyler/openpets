import assert from "node:assert/strict";

import { LeaseManager } from "../src/lease-manager.js";

let now = 1_000;
const opened: string[] = [];
const closed: string[] = [];
const manager = new LeaseManager({
  ttlMs: 100,
  now: () => now,
  resolveTarget: (requestedPetId) => {
    if (!requestedPetId) return { targetKind: "default", actualPetId: "builtin" };
    if (requestedPetId === "missing") return { targetKind: "default", actualPetId: "builtin", fallbackReason: "pet_not_installed" };
    return { targetKind: "explicit", actualPetId: requestedPetId };
  },
  getDefaultPetId: () => "builtin",
  getPetDisplayName: (petId) => petId,
  onFirstExplicitLease: (petId) => opened.push(petId),
  onLastExplicitLease: (petId) => closed.push(petId),
});

const defaultLease = manager.acquire();
assert.equal(defaultLease.usingDefaultPet, true, "Default lease did not target default.");
assert.equal(defaultLease.targetKind, "default", "Default lease targetKind should be 'default'.");
manager.release(defaultLease.leaseId);
assert.equal(closed.length, 0, "Default release closed a temp pet.");

const first = manager.acquire("snoopy");
const second = manager.acquire("snoopy");
assert.equal(opened.join(","), "snoopy", "Explicit pet did not open once for multiple leases.");
manager.release(first.leaseId);
assert.equal(closed.length, 0, "Explicit pet closed before final lease release.");
manager.release(first.leaseId);
manager.release(second.leaseId);
assert.equal(closed.join(","), "snoopy", "Explicit pet did not close after final release.");

const missing = manager.acquire("missing");
assert.equal(missing.fallbackReason, "pet_not_installed", "Missing pet did not fall back to default.");
assert.equal(missing.usingDefaultPet, true, "Missing pet should use default.");
manager.release(missing.leaseId);

const expiring = manager.acquire("tux");
now += 50;
manager.heartbeat(expiring.leaseId);
now += 75;
assert.equal(manager.cleanupExpired().length, 0, "Heartbeat did not extend lease.");
now += 50;
assert.equal(manager.cleanupExpired().length, 1, "Expired lease was not cleaned up.");

const expiredBeforeHeartbeat = manager.acquire("dobby");
now += 200;
assert.throws(() => manager.heartbeat(expiredBeforeHeartbeat.leaseId));
assert.equal(manager.get(expiredBeforeHeartbeat.leaseId), null, "Expired lease was still readable before cleanup.");

console.log("Lease manager validation passed.");

// --- checkPidLiveness tests ---

{
  // Test 1: no leases with clientPid — no-op, returns empty array
  const pidManager = new LeaseManager({
    ttlMs: 60_000,
    now: () => 1_000,
    resolveTarget: (id) => id ? { targetKind: "explicit", actualPetId: id } : { targetKind: "default", actualPetId: "builtin" },
    getDefaultPetId: () => "builtin",
    getPetDisplayName: (petId) => petId,
  });
  const result = pidManager.checkPidLiveness();
  assert.equal(result.length, 0, "checkPidLiveness with no leases should return empty array.");
  console.log("checkPidLiveness: no leases — PASS");
}

{
  // Test 2: lease with current process PID — alive, not released
  const pidManager = new LeaseManager({
    ttlMs: 60_000,
    now: () => 1_000,
    resolveTarget: (id) => id ? { targetKind: "explicit", actualPetId: id } : { targetKind: "default", actualPetId: "builtin" },
    getDefaultPetId: () => "builtin",
    getPetDisplayName: (petId) => petId,
  });
  const lease = pidManager.acquire("fido", process.pid);
  const result = pidManager.checkPidLiveness();
  assert.equal(result.length, 0, "checkPidLiveness should not release alive process.");
  // Lease should still be accessible
  assert.notEqual(pidManager.get(lease.leaseId), null, "Alive lease should remain active.");
  console.log("checkPidLiveness: alive PID — PASS");
}

{
  // Test 3: lease with dead/invalid PID — released, onLastExplicitLease fires
  const pidClosed: string[] = [];
  const pidManager = new LeaseManager({
    ttlMs: 60_000,
    now: () => 1_000,
    resolveTarget: (id) => id ? { targetKind: "explicit", actualPetId: id } : { targetKind: "default", actualPetId: "builtin" },
    getDefaultPetId: () => "builtin",
    getPetDisplayName: (petId) => petId,
    onLastExplicitLease: (petId) => pidClosed.push(petId),
  });
  const deadPid = 999_999_999;
  const lease = pidManager.acquire("rex", deadPid);
  const result = pidManager.checkPidLiveness();
  assert.equal(result.length, 1, "checkPidLiveness should release dead PID lease.");
  assert.equal(result[0].actualTargetPetId, "rex", "Released lease should have correct pet ID.");
  assert.equal(pidManager.get(lease.leaseId), null, "Dead PID lease should no longer be active.");
  assert.equal(pidClosed.join(","), "rex", "onLastExplicitLease should fire after dead PID lease release.");
  console.log("checkPidLiveness: dead PID — PASS");
}

// Tri-state requestedPetId: null = explicitly default.
{
  const triManager = new LeaseManager({
    ttlMs: 60_000,
    now: () => 1_000,
    resolveTarget: (id) => id ? { targetKind: "explicit", actualPetId: id } : { targetKind: "default", actualPetId: "builtin" },
    getDefaultPetId: () => "builtin",
    getPetDisplayName: (petId) => petId,
  });
  const lease = triManager.acquire(null, 4242, "nonce-null");
  assert.equal(lease.targetKind, "default", "null resolves to default target");
  assert.equal(lease.requestedPetId, undefined, "snapshot hides null (wire response stays string|undefined)");
  const raw = triManager.getRawLease(lease.leaseId);
  assert.equal(raw?.requestedPetId, null, "raw lease preserves null");
  // Reuse: same pid+nonce+null → same lease.
  const again = triManager.acquire(null, 4242, "nonce-null");
  assert.equal(again.leaseId, lease.leaseId, "null-for-null reuses lease");
  // Mismatch: same pid+nonce but explicit pet → fresh lease.
  const switched = triManager.acquire("fox", 4242, "nonce-null");
  assert.notEqual(switched.leaseId, lease.leaseId, "null vs explicit is a mismatch → fresh acquire");
  console.log("tri-state requestedPetId — PASS");
}

// --- Herdr pane context on leases ---

{
  const herdrManager = new LeaseManager({
    ttlMs: 60_000,
    now: () => 1_000,
    resolveTarget: (id) => id ? { targetKind: "explicit", actualPetId: id } : { targetKind: "default", actualPetId: "builtin" },
    getDefaultPetId: () => "builtin",
    getPetDisplayName: (petId) => petId,
  });
  const herdr = { paneId: "wC:p1", tabId: "wC:t1", socketPath: "C:\herdr\herdr.sock" };
  const lease = herdrManager.acquire(undefined, 111, "nonce-herdr", "/repo", herdr);
  const raw = herdrManager.getRawLease(lease.leaseId);
  assert.deepEqual(raw?.herdr, herdr, "acquire stores herdr context on the raw lease");

  // Reuse (same pid + nonce) preserves the stored context.
  const reused = herdrManager.acquire(undefined, 111, "nonce-herdr", "/repo", herdr);
  assert.equal(reused.leaseId, lease.leaseId, "same pid+nonce reuses lease");
  assert.deepEqual(herdrManager.getRawLease(reused.leaseId)?.herdr, herdr, "reuse preserves herdr context");

  // setTerminalIdentity keeps the herdr context intact.
  herdrManager.setTerminalIdentity(lease.leaseId, { terminalOwnerPid: 999, terminalAppName: "Terminal" });
  assert.deepEqual(herdrManager.getRawLease(lease.leaseId)?.herdr, herdr, "terminal identity update preserves herdr context");
  console.log("herdr context stored and preserved — PASS");
}

{
  // getFocusableDefaultLease treats a herdr-only lease (no terminal identity)
  // as focusable — herdr panes never resolve a terminal window.
  const herdrManager = new LeaseManager({
    ttlMs: 60_000,
    now: () => 1_000,
    resolveTarget: (id) => id ? { targetKind: "explicit", actualPetId: id } : { targetKind: "default", actualPetId: "builtin" },
    getDefaultPetId: () => "builtin",
    getPetDisplayName: (petId) => petId,
  });
  assert.equal(herdrManager.getFocusableDefaultLease(), undefined, "no focusable lease without identity or herdr");
  const plain = herdrManager.acquire(undefined, 222, "nonce-plain", "/repo");
  assert.equal(herdrManager.getFocusableDefaultLease(), undefined, "identity-less non-herdr lease is not focusable");
  const withHerdr = herdrManager.acquire(undefined, 333, "nonce-herdr2", "/repo", { paneId: "wB:p2" });
  assert.equal(herdrManager.getFocusableDefaultLease()?.leaseId, withHerdr.leaseId, "herdr-only lease is focusable");
  // A lease with resolved terminal identity and fresher activity wins as before.
  const withTerminal = herdrManager.acquire(undefined, 444, "nonce-term", "/repo");
  herdrManager.setTerminalIdentity(withTerminal.leaseId, { terminalOwnerPid: 555, terminalAppName: "Terminal" });
  herdrManager.touchActivity(withTerminal.leaseId);
  assert.equal(herdrManager.getFocusableDefaultLease()?.leaseId, withTerminal.leaseId, "freshest activity still wins across kinds");
  void plain;
  console.log("getFocusableDefaultLease herdr eligibility — PASS");
}
