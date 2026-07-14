import assert from "node:assert/strict";
import { LeaseManager } from "../src/lease-manager.js";

let now = 1_000;
const manager = new LeaseManager({
  ttlMs: 100,
  now: () => now,
  resolveTarget: () => ({ targetKind: "default" as const, actualPetId: "builtin" }),
  getDefaultPetId: () => "builtin",
  getPetDisplayName: (petId) => petId,
});

const lease = manager.acquire(undefined, 4242, "nonce-1", "C:\\Users\\me\\fraud_project");
const raw = manager.getRawLease(lease.leaseId);
assert.equal(raw?.cwd, "C:\\Users\\me\\fraud_project", "cwd stored on lease");

// Idempotent reuse keeps cwd.
now += 10;
const reused = manager.acquire(undefined, 4242, "nonce-1", "C:\\Users\\me\\fraud_project");
assert.equal(reused.leaseId, lease.leaseId, "same lease reused");
assert.equal(manager.getRawLease(reused.leaseId)?.cwd, "C:\\Users\\me\\fraud_project");

console.log("Lease cwd threading passed.");
