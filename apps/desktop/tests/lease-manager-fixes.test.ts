/**
 * Tests for Fix 1/M1 (idempotent per-clientPid+sessionNonce lease reuse),
 * Fix L1 (re-validate eligible target on reuse),
 * Fix 4 (terminalOwnerPid liveness check in checkPidLiveness), and
 * onExpired (notify caller when heartbeat()/get() internally release an
 * expired lease, so window-registry teardown isn't skipped between the 5s
 * cleanup ticks).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { LeaseManager, resolveAcquirePetId, type PetLease } from "../src/lease-manager.js";

// ---------------------------------------------------------------------------
// T1: Fix 1/M1 — same clientPid + same nonce re-acquires same lease
// ---------------------------------------------------------------------------
{
  let now = 1_000;
  const firstOpened: string[] = [];
  let callCount = 0;
  const nonce = randomUUID();

  // Use a forward-ref to allow resolveTarget to call countExplicitLeases.
  let mgr!: LeaseManager;
  mgr = new LeaseManager({
    ttlMs: 10_000,
    now: () => now,
    resolveTarget: (_requestedPetId) => {
      // Simulates pool behavior: returns explicit/P only if no explicit lease
      // for P exists yet (the slot is free). Otherwise falls back to default.
      callCount++;
      if (mgr.countExplicitLeases("P") === 0) {
        return { targetKind: "explicit", actualPetId: "P" };
      }
      return { targetKind: "default", actualPetId: "builtin" };
    },
    getDefaultPetId: () => "builtin",
    getPetDisplayName: (petId) => petId,
    onFirstExplicitLease: (petId) => firstOpened.push(petId),
  });

  const s1 = mgr.acquire(undefined, 111, nonce);
  assert.equal(s1.targetKind, "explicit", "T1: first acquire should be explicit");
  assert.equal(s1.actualTargetPetId, "P", "T1: first acquire should target P");

  const resolveCallsAfterFirst = callCount;

  now += 100; // advance time slightly (still within TTL)
  const s2 = mgr.acquire(undefined, 111, nonce);
  assert.equal(s2.leaseId, s1.leaseId, "T1: second acquire should return SAME leaseId");
  assert.equal(s2.targetKind, "explicit", "T1: reused lease should still be explicit");
  assert.equal(s2.actualTargetPetId, "P", "T1: reused lease should still target P");

  // Fix M1: #resolveTarget must NOT have been called again for the second acquire
  assert.equal(callCount, resolveCallsAfterFirst, "T1: resolveTarget must NOT be called on reuse");

  // onFirstExplicitLease must have fired exactly once
  assert.equal(firstOpened.length, 1, "T1: onFirstExplicitLease fired more than once");
  assert.equal(firstOpened[0], "P", "T1: onFirstExplicitLease fired for wrong pet");

  console.log("T1 (Fix M1 — same clientPid+nonce reuse): PASS");
}

// ---------------------------------------------------------------------------
// T2: Fix 1 — different clientPids get distinct leases (nonces differ too)
// ---------------------------------------------------------------------------
{
  let now = 1_000;
  const firstOpened: string[] = [];
  let callCount = 0;
  const petIds = ["P", "Q"];

  let mgr!: LeaseManager;
  mgr = new LeaseManager({
    ttlMs: 10_000,
    now: () => now,
    resolveTarget: (_requestedPetId) => {
      // Round-robin pool simulation: each call gets a distinct pet
      const petId = petIds[callCount % petIds.length];
      callCount++;
      return { targetKind: "explicit", actualPetId: petId };
    },
    getDefaultPetId: () => "builtin",
    getPetDisplayName: (petId) => petId,
    onFirstExplicitLease: (petId) => firstOpened.push(petId),
  });

  const s1 = mgr.acquire(undefined, 111, randomUUID());
  const s2 = mgr.acquire(undefined, 222, randomUUID());

  assert.notEqual(s1.leaseId, s2.leaseId, "T2: different clientPids must get distinct leaseIds");
  assert.notEqual(s1.actualTargetPetId, s2.actualTargetPetId, "T2: different clientPids must get different pets");
  assert.equal(s1.targetKind, "explicit", "T2: pid 111 lease should be explicit");
  assert.equal(s2.targetKind, "explicit", "T2: pid 222 lease should be explicit");

  // resolveTarget was called once per distinct pid (no reuse across pids)
  assert.equal(callCount, 2, "T2: resolveTarget should be called once per distinct clientPid");

  console.log("T2 (Fix 1 — distinct clientPids not collapsed): PASS");
}

// ---------------------------------------------------------------------------
// T3: Skipped — wiring local-ipc routing guard requires heavy electron-stub
// seam plumbing across multiple handler layers; coverage of the routing logic
// is already provided by local-ipc-confinement.test.ts.
// ---------------------------------------------------------------------------
console.log("T3 (routing guard): SKIPPED — covered by local-ipc-confinement.test.ts");

// ---------------------------------------------------------------------------
// T-M1a: same PID + same nonce → reuse (explicit M1 test)
// ---------------------------------------------------------------------------
{
  let now = 1_000;
  let callCount = 0;
  const nonce = randomUUID();

  const mgr = new LeaseManager({
    ttlMs: 10_000,
    now: () => now,
    resolveTarget: () => { callCount++; return { targetKind: "explicit", actualPetId: "kitty" }; },
    getDefaultPetId: () => "builtin",
    getPetDisplayName: (p) => p,
  });

  const s1 = mgr.acquire("kitty", 555, nonce);
  assert.equal(callCount, 1, "T-M1a: resolveTarget should be called once on first acquire");
  now += 50;
  const s2 = mgr.acquire("kitty", 555, nonce);
  assert.equal(s2.leaseId, s1.leaseId, "T-M1a: same PID + same nonce must reuse leaseId");
  assert.equal(callCount, 1, "T-M1a: resolveTarget must NOT be called again on reuse");

  console.log("T-M1a (Fix M1 — same PID + same nonce reuses): PASS");
}

// ---------------------------------------------------------------------------
// T-M1b: same PID + DIFFERENT nonce → fresh acquire (no reuse)
// ---------------------------------------------------------------------------
{
  let now = 1_000;
  let callCount = 0;
  const nonce1 = randomUUID();
  const nonce2 = randomUUID();

  const mgr = new LeaseManager({
    ttlMs: 10_000,
    now: () => now,
    resolveTarget: () => { callCount++; return { targetKind: "explicit", actualPetId: "kitty" }; },
    getDefaultPetId: () => "builtin",
    getPetDisplayName: (p) => p,
  });

  const s1 = mgr.acquire("kitty", 555, nonce1);
  assert.equal(callCount, 1);
  now += 50;
  const s2 = mgr.acquire("kitty", 555, nonce2); // different nonce = different process (PID reuse)
  assert.notEqual(s2.leaseId, s1.leaseId, "T-M1b: different nonce must produce fresh leaseId");
  assert.equal(callCount, 2, "T-M1b: resolveTarget must be called again for different nonce");

  console.log("T-M1b (Fix M1 — different nonce → fresh acquire): PASS");
}

// ---------------------------------------------------------------------------
// T-M1c: undefined/missing nonce → never reuse
// ---------------------------------------------------------------------------
{
  let now = 1_000;
  let callCount = 0;

  const mgr = new LeaseManager({
    ttlMs: 10_000,
    now: () => now,
    resolveTarget: () => { callCount++; return { targetKind: "explicit", actualPetId: "kitty" }; },
    getDefaultPetId: () => "builtin",
    getPetDisplayName: (p) => p,
  });

  const s1 = mgr.acquire("kitty", 555, undefined); // no nonce
  assert.equal(callCount, 1);
  now += 50;
  const s2 = mgr.acquire("kitty", 555, undefined); // still no nonce
  assert.notEqual(s2.leaseId, s1.leaseId, "T-M1c: missing nonce must never reuse");
  assert.equal(callCount, 2, "T-M1c: resolveTarget must be called for each no-nonce acquire");

  console.log("T-M1c (Fix M1 — undefined nonce → never reuse): PASS");
}

// ---------------------------------------------------------------------------
// T-L1: explicit target no longer eligible → release + fresh acquire
// ---------------------------------------------------------------------------
{
  let now = 1_000;
  const lastClosed: string[] = [];
  const nonce = randomUUID();
  let eligiblePets = new Set(["kitty"]);
  let callCount = 0;

  const mgr = new LeaseManager({
    ttlMs: 10_000,
    now: () => now,
    resolveTarget: () => {
      callCount++;
      // After kitty is uninstalled, re-resolution falls back to default.
      if (eligiblePets.has("kitty")) return { targetKind: "explicit", actualPetId: "kitty" };
      return { targetKind: "default", actualPetId: "builtin", fallbackReason: "pet_not_installed" };
    },
    getDefaultPetId: () => "builtin",
    getPetDisplayName: (p) => p,
    isPetEligible: (petId) => eligiblePets.has(petId),
    onLastExplicitLease: (petId) => lastClosed.push(petId),
  });

  // Acquire with kitty eligible
  const s1 = mgr.acquire("kitty", 777, nonce);
  assert.equal(s1.targetKind, "explicit", "T-L1: initial acquire should be explicit kitty");
  assert.equal(callCount, 1);

  // Simulate kitty being uninstalled between original acquire and re-acquire
  eligiblePets = new Set();
  now += 100;

  // Re-acquire same PID+nonce — Fix L1 must detect kitty is ineligible, release and re-resolve
  const s2 = mgr.acquire("kitty", 777, nonce);
  assert.notEqual(s2.leaseId, s1.leaseId, "T-L1: ineligible target must produce fresh leaseId");
  assert.equal(callCount, 2, "T-L1: resolveTarget must be called again after ineligible reuse");
  assert.equal(s2.usingDefaultPet, true, "T-L1: re-resolved lease should fall back to default");
  assert.equal(lastClosed.join(","), "kitty", "T-L1: onLastExplicitLease should fire for released kitty lease");

  console.log("T-L1 (Fix L1 — ineligible reuse target → release + fresh acquire): PASS");
}

// ---------------------------------------------------------------------------
// T-L1b: default lease — isPetEligible NOT called (by-design behavior preserved)
// ---------------------------------------------------------------------------
{
  let now = 1_000;
  const nonce = randomUUID();
  let eligibilityCallCount = 0;
  let resolveCallCount = 0;

  const mgr = new LeaseManager({
    ttlMs: 10_000,
    now: () => now,
    resolveTarget: () => { resolveCallCount++; return { targetKind: "default", actualPetId: "builtin" }; },
    getDefaultPetId: () => "builtin",
    getPetDisplayName: (p) => p,
    isPetEligible: (_petId) => { eligibilityCallCount++; return false; }, // always ineligible
  });

  const s1 = mgr.acquire(undefined, 888, nonce);
  assert.equal(s1.usingDefaultPet, true, "T-L1b: initial acquire should be default");
  now += 50;
  const s2 = mgr.acquire(undefined, 888, nonce);
  assert.equal(s2.leaseId, s1.leaseId, "T-L1b: default lease must still reuse");
  assert.equal(eligibilityCallCount, 0, "T-L1b: isPetEligible must NOT be called for default leases");
  assert.equal(resolveCallCount, 1, "T-L1b: resolveTarget called once (not on reuse)");

  console.log("T-L1b (Fix L1 — default leases skip eligibility check): PASS");
}

// ---------------------------------------------------------------------------
// T4: Fix 4 — dead terminalOwnerPid triggers lease release + onLastExplicitLease
// ---------------------------------------------------------------------------
{
  let now = 1_000;
  const lastClosed: string[] = [];

  const mgr = new LeaseManager({
    ttlMs: 60_000,
    now: () => now,
    resolveTarget: (id) => id ? { targetKind: "explicit", actualPetId: id } : { targetKind: "default", actualPetId: "builtin" },
    getDefaultPetId: () => "builtin",
    getPetDisplayName: (petId) => petId,
    onLastExplicitLease: (petId) => lastClosed.push(petId),
  });

  const snap = mgr.acquire("rex", process.pid);
  // Set a dead terminalOwnerPid (process 999_999_999 does not exist)
  mgr.setTerminalIdentity(snap.leaseId, { terminalOwnerPid: 999_999_999, terminalAppName: "Ghostty" });

  const released = mgr.checkPidLiveness();

  assert.equal(released.length, 1, "T4: dead terminalOwnerPid should cause lease release");
  assert.equal(released[0].actualTargetPetId, "rex", "T4: released lease should target rex");
  assert.equal(mgr.get(snap.leaseId), null, "T4: lease should no longer be active");
  assert.equal(lastClosed.join(","), "rex", "T4: onLastExplicitLease('rex') should have fired");

  console.log("T4 (Fix 4 — dead terminalOwnerPid releases lease): PASS");
}

// ---------------------------------------------------------------------------
// T5: Fix 4 — heartbeat does NOT defeat owner-death teardown
// ---------------------------------------------------------------------------
{
  let now = 1_000;
  const lastClosed: string[] = [];

  const mgr = new LeaseManager({
    ttlMs: 60_000,
    now: () => now,
    resolveTarget: (id) => id ? { targetKind: "explicit", actualPetId: id } : { targetKind: "default", actualPetId: "builtin" },
    getDefaultPetId: () => "builtin",
    getPetDisplayName: (petId) => petId,
    onLastExplicitLease: (petId) => lastClosed.push(petId),
  });

  const snap = mgr.acquire("rex", process.pid);
  mgr.setTerminalIdentity(snap.leaseId, { terminalOwnerPid: 999_999_999, terminalAppName: "Ghostty" });

  // Heartbeat refreshes TTL but should NOT protect against dead terminalOwnerPid
  now += 1_000;
  mgr.heartbeat(snap.leaseId);

  const released = mgr.checkPidLiveness();

  assert.equal(released.length, 1, "T5: heartbeat must not protect against dead terminalOwnerPid");
  assert.equal(mgr.get(snap.leaseId), null, "T5: lease should be released even after heartbeat");
  assert.equal(lastClosed.join(","), "rex", "T5: onLastExplicitLease should still fire");

  console.log("T5 (Fix 4 — heartbeat does not defeat owner-death): PASS");
}

// ---------------------------------------------------------------------------
// T6: onExpired fires when heartbeat() internally releases an expired lease
// ---------------------------------------------------------------------------
{
  let now = 1_000;
  const expired: PetLease[] = [];

  const mgr = new LeaseManager({
    ttlMs: 100,
    now: () => now,
    resolveTarget: (id) => id ? { targetKind: "explicit", actualPetId: id } : { targetKind: "default", actualPetId: "builtin" },
    getDefaultPetId: () => "builtin",
    getPetDisplayName: (petId) => petId,
    onExpired: (lease) => expired.push(lease),
  });

  const snap = mgr.acquire("rex", 4242, randomUUID());
  now += 200; // now past ttlMs (100) — lease is expired but the 5s cleanup tick hasn't run yet

  assert.throws(() => mgr.heartbeat(snap.leaseId), /unknown_lease/, "T6: heartbeat on an expired lease must throw unknown_lease");
  assert.equal(expired.length, 1, "T6: onExpired must fire exactly once from heartbeat()'s internal release");
  assert.equal(expired[0]?.leaseId, snap.leaseId, "T6: onExpired must receive the expired lease with the matching leaseId");

  console.log("T6 (onExpired fires from heartbeat()'s internal release): PASS");
}

// ---------------------------------------------------------------------------
// T7: onExpired fires when get() internally releases an expired lease
// ---------------------------------------------------------------------------
{
  let now = 1_000;
  const expired: PetLease[] = [];

  const mgr = new LeaseManager({
    ttlMs: 100,
    now: () => now,
    resolveTarget: (id) => id ? { targetKind: "explicit", actualPetId: id } : { targetKind: "default", actualPetId: "builtin" },
    getDefaultPetId: () => "builtin",
    getPetDisplayName: (petId) => petId,
    onExpired: (lease) => expired.push(lease),
  });

  const snap = mgr.acquire("rex", 4343, randomUUID());
  now += 200; // now past ttlMs (100) — lease is expired but the 5s cleanup tick hasn't run yet

  assert.equal(mgr.get(snap.leaseId), null, "T7: get() on an expired lease must return null");
  assert.equal(expired.length, 1, "T7: onExpired must fire exactly once from get()'s internal release");
  assert.equal(expired[0]?.leaseId, snap.leaseId, "T7: onExpired must receive the expired lease with the matching leaseId");

  console.log("T7 (onExpired fires from get()'s internal release): PASS");
}

// ---------------------------------------------------------------------------
// T8: onExpired NOT fired for acquire reuse-mismatch release (session lives on)
// ---------------------------------------------------------------------------
{
  let now = 1_000;
  const expired: PetLease[] = [];
  const nonce = randomUUID();

  const mgr = new LeaseManager({
    ttlMs: 10_000,
    now: () => now,
    resolveTarget: (id) => id ? { targetKind: "explicit", actualPetId: id } : { targetKind: "default", actualPetId: "builtin" },
    getDefaultPetId: () => "builtin",
    getPetDisplayName: (petId) => petId,
    onExpired: (lease) => expired.push(lease),
  });

  // First acquire: explicit pet "rex"
  const s1 = mgr.acquire("rex", 9999, nonce);
  assert.equal(s1.targetKind, "explicit", "T8: first acquire should be explicit");

  now += 100;
  // Second acquire: same pid+nonce but DIFFERENT requestedPetId → reuse-mismatch
  // release of old lease + fresh acquire. The session lives on — onExpired must NOT fire.
  const s2 = mgr.acquire("kitty", 9999, nonce);
  assert.notEqual(s2.leaseId, s1.leaseId, "T8: reuse-mismatch must produce fresh leaseId");
  assert.equal(expired.length, 0, "T8: onExpired must NOT fire for reuse-mismatch release (session lives on)");

  console.log("T8 (onExpired NOT fired for reuse-mismatch release): PASS");
}

// ---------------------------------------------------------------------------
// T9: explicit --pet wins over a remembered project pet; a remembered pet only
// applies when no pet was requested and it is still eligible (bug A1).
// ---------------------------------------------------------------------------
{
  const eligible = (petId: string) => petId === "rex" || petId === "kitty";
  assert.equal(resolveAcquirePetId("kitty", "rex", eligible), "kitty", "T9: explicit --pet must beat remembered pet");
  assert.equal(resolveAcquirePetId(null, "rex", eligible), null, "T9: explicit return-to-default must beat remembered pet");
  assert.equal(resolveAcquirePetId(undefined, "rex", eligible), "rex", "T9: remembered pet applies when nothing requested");
  assert.equal(resolveAcquirePetId(undefined, "gone", eligible), undefined, "T9: ineligible remembered pet must be ignored");
  console.log("T9 (explicit pet beats remembered project pet): PASS");
}

// ---------------------------------------------------------------------------
// T10: project lookup uses the same cwd normalization as Sessions grouping, so
// project-wide reassign reaches every session in the group (bug A2).
// ---------------------------------------------------------------------------
{
  const mgr = new LeaseManager({
    ttlMs: 10_000,
    now: () => 1_000,
    resolveTarget: () => ({ targetKind: "default", actualPetId: "builtin" }),
    getDefaultPetId: () => "builtin",
  });
  const a = mgr.acquire(undefined, 1, "n1", "C:\\Dev\\Proj");
  const b = mgr.acquire(undefined, 2, "n2", "c:/dev/proj/");
  mgr.acquire(undefined, 3, "n3", "c:/dev/other");
  const ids = mgr.getRawLeasesInProject("C:\\Dev\\Proj").map((l) => l.leaseId).sort();
  assert.deepEqual(ids, [a.leaseId, b.leaseId].sort(), "T10: same-group cwds must all match");
  console.log("T10 (project lookup matches grouping normalization): PASS");
}

console.log("\nAll lease-manager-fixes tests passed.");
