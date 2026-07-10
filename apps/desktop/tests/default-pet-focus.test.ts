/**
 * Tests for default-pet session-terminal focus.
 *
 * Part A — real unit tests for LeaseManager.getFocusableDefaultLease() and
 * touchActivity() (LeaseManager is Electron-free, so it is imported directly).
 *
 * Part B — source-regex assertions pinning the wiring (default-pet-controller,
 * pet-window default menu, local-ipc resolver registration, agent-pet
 * double-click), following the capabilities-win32.test.ts pattern because
 * those modules import Electron.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LeaseManager } from "../src/lease-manager.js";

// ---------------------------------------------------------------------------
// Part A — LeaseManager focusable-default-lease selection
// ---------------------------------------------------------------------------
let now = 1_000;
const manager = new LeaseManager({
  ttlMs: 100,
  now: () => now,
  resolveTarget: (requestedPetId) => {
    if (!requestedPetId) return { targetKind: "default", actualPetId: "builtin" };
    return { targetKind: "explicit", actualPetId: requestedPetId };
  },
  getDefaultPetId: () => "builtin",
  getPetDisplayName: (petId) => petId,
  onFirstExplicitLease: () => {},
  onLastExplicitLease: () => {},
});

// (A1) No leases → undefined
assert.equal(manager.getFocusableDefaultLease(), undefined, "(A1) empty manager must return undefined");

// (A2) Default lease without terminal identity → undefined
const leaseA = manager.acquire(undefined, 111, "nonce-a");
assert.equal(manager.getFocusableDefaultLease(), undefined, "(A2) lease without terminal identity must not be focusable");

// (A3) After setTerminalIdentity → that lease is returned
manager.setTerminalIdentity(leaseA.leaseId, { terminalOwnerPid: 4242, terminalAppName: "Windows Terminal" });
assert.equal(manager.getFocusableDefaultLease()?.leaseId, leaseA.leaseId, "(A3) default lease with identity must be focusable");
assert.equal(manager.getFocusableDefaultLease()?.terminalOwnerPid, 4242, "(A3) terminalOwnerPid must be exposed");

// (A4) Explicit lease with identity is NOT eligible (agent pets have their own focus path)
const explicitLease = manager.acquire("raccoon", 222, "nonce-b");
manager.setTerminalIdentity(explicitLease.leaseId, { terminalOwnerPid: 5555, terminalAppName: "Windows Terminal" });
assert.equal(manager.getFocusableDefaultLease()?.leaseId, leaseA.leaseId, "(A4) explicit lease must not win the default focus target");

// (A5) Two default leases: later heartbeat wins when no activity recorded
now = 1_010;
const leaseB = manager.acquire(undefined, 333, "nonce-c");
manager.setTerminalIdentity(leaseB.leaseId, { terminalOwnerPid: 7777, terminalAppName: "Windows Terminal" });
assert.equal(manager.getFocusableDefaultLease()?.leaseId, leaseB.leaseId, "(A5) most recently heartbeated default lease must win");

// (A6) touchActivity outranks heartbeat recency
now = 1_020;
manager.touchActivity(leaseA.leaseId);
now = 1_030;
manager.heartbeat(leaseB.leaseId);
assert.equal(manager.getFocusableDefaultLease()?.leaseId, leaseA.leaseId, "(A6) session with recorded activity must outrank heartbeat-only session");

// (A7) Later activity wins over earlier activity
now = 1_040;
manager.touchActivity(leaseB.leaseId);
assert.equal(manager.getFocusableDefaultLease()?.leaseId, leaseB.leaseId, "(A7) most recent activity must win");

// (A8) Expired leases are not focusable
now = 10_000;
assert.equal(manager.getFocusableDefaultLease(), undefined, "(A8) expired leases must not be focusable");

// ---------------------------------------------------------------------------
// Part B — wiring source-regex assertions
// ---------------------------------------------------------------------------
const appRoot = process.env["OPENPETS_DESKTOP_ROOT"]
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (name: string): string => readFileSync(join(appRoot, "src", name), "utf-8");

// (B1) default-pet-controller: double-click focuses the session terminal and
// plugin pet-event forwarding is preserved.
{
  const src = read("default-pet-controller.ts");
  assert.ok(src.includes(`"pet:doubleClicked"`), "(B1) default pet must handle pet:doubleClicked");
  assert.ok(src.includes("focusTerminalWindow"), "(B1) default pet must call focusTerminalWindow");
  assert.ok(src.includes("setSessionTerminalFocusResolver"), "(B1) resolver setter must exist");
  assert.ok(src.includes(`publishPluginPetEvent("default", name, payload)`), "(B1) plugin pet-event forwarding must be preserved");
}

// (B2) local-ipc registers the resolver backed by the lease manager
{
  const src = read("local-ipc.ts");
  assert.ok(src.includes("setSessionTerminalFocusResolver("), "(B2) local-ipc must register the focus resolver");
  assert.ok(src.includes("getFocusableDefaultLease()"), "(B2) resolver must read the focusable default lease");
  assert.ok(src.includes("touchActivity("), "(B2) say/react must stamp lease activity");
  assert.ok(
    src.includes("resolveDefaultLeaseTerminalIdentity"),
    "(B2) default-target leases must get a terminal-identity resolve (confinement path is explicit-only)",
  );
}

// (B3) pet-window: default-pet context menu offers the focus action
{
  const src = read("pet-window.ts");
  const defaultBranchIdx = src.indexOf("getDefaultPetPluginCommands()");
  assert.ok(defaultBranchIdx >= 0, "(B3) default menu branch must exist");
  const defaultBranch = src.slice(defaultBranchIdx);
  assert.ok(
    defaultBranch.includes("action.focusSessionWindow"),
    "(B3) default menu branch must include the focus-session-window action",
  );
  assert.ok(src.includes("hasFocusableSessionTerminal"), "(B3) menu must gate focus item on session availability");
}

// (B4) agent pets focus on double-click, not single click
{
  const src = read("agent-pet-controller.ts");
  assert.ok(src.includes(`"pet:doubleClicked"`), "(B4) agent pet must focus on double-click");
  assert.ok(!src.includes(`"pet:clicked"`), "(B4) agent pet must not steal single clicks");
}

console.log("default-pet-focus validation passed.");
