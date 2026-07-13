/**
 * Tests for routing lease-less / default-lease say-react calls to the pet of
 * the session they belong to, matched by shared process ancestry.
 *
 * Part A — pure collectAncestorPidChain (window-chain.ts, injectable lookup).
 * Part B — real LeaseManager: setClientAncestry / hasSessionRoutableLeases /
 *          findSessionPetLease (Electron-free).
 * Part C — source-regex wiring pins for local-ipc.ts and the client package
 *          (they import Electron / are cross-package, so source assertions
 *          follow the capabilities-win32.test.ts pattern).
 *
 * Scenario being protected: a Claude Code hook is a short-lived, lease-less
 * process whose ancestor chain shares the claude.exe (and tab shell) PIDs with
 * the session's MCP server. Ancestors at/above the terminal are shared by
 * unrelated sessions and must never match.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectAncestorPidChain } from "../src/window-chain.js";
import { LeaseManager } from "../src/lease-manager.js";

// ---------------------------------------------------------------------------
// Part A — collectAncestorPidChain
// ---------------------------------------------------------------------------
{
  const parents = new Map<number, number>([[100, 50], [50, 20], [20, 1]]);
  const lookup = async (pid: number): Promise<number | null> => parents.get(pid) ?? null;

  assert.deepEqual(await collectAncestorPidChain(100, lookup), [100, 50, 20, 1], "(A1) full chain collected");
  assert.deepEqual(await collectAncestorPidChain(100, lookup, 2), [100, 50, 20], "(A2) maxDepth caps the walk");
  assert.deepEqual(await collectAncestorPidChain(999, lookup), [999], "(A3) unknown pid yields just itself");

  const cyclic = new Map<number, number>([[10, 20], [20, 10]]);
  assert.deepEqual(
    await collectAncestorPidChain(10, async (pid) => cyclic.get(pid) ?? null),
    [10, 20],
    "(A4) cycles terminate the walk",
  );
}

// ---------------------------------------------------------------------------
// Part B — LeaseManager session matching
// ---------------------------------------------------------------------------
// Process tree modeled:
//   terminal (pid 500)
//     └ shell tab 1 (pid 510) └ claude #1 (pid 511) └ mcp #1 (pid 512)   → raccoon
//     └ shell tab 2 (pid 520) └ claude #2 (pid 521) └ mcp #2 (pid 522)   → nori
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

const raccoonLease = manager.acquire("raccoon", 512, "nonce-r");
const noriLease = manager.acquire("nori", 522, "nonce-n");

// (B1) no ancestry recorded yet → nothing routable, no match
assert.equal(manager.hasSessionRoutableLeases(), false, "(B1) no ancestry → not routable");
assert.equal(manager.findSessionPetLease([9_000, 511, 510, 500]), undefined, "(B1) no ancestry → no match");

// (B2) ancestry without terminal identity is not routable (no session cutoff)
manager.setClientAncestry(raccoonLease.leaseId, [512, 511, 510, 500, 4]);
assert.equal(manager.hasSessionRoutableLeases(), false, "(B2) ancestry without terminal identity → not routable");

manager.setTerminalIdentity(raccoonLease.leaseId, { terminalOwnerPid: 500, terminalAppName: "Windows Terminal" });
manager.setTerminalIdentity(noriLease.leaseId, { terminalOwnerPid: 500, terminalAppName: "Windows Terminal" });
manager.setClientAncestry(noriLease.leaseId, [522, 521, 520, 500, 4]);
assert.equal(manager.hasSessionRoutableLeases(), true, "(B2) ancestry + terminal identity → routable");

// (B3) a hook under claude #1 matches the raccoon session (shared 511/510)
const hookChain1 = [9_100, 9_050, 511, 510, 500, 4];
assert.equal(manager.findSessionPetLease(hookChain1)?.leaseId, raccoonLease.leaseId, "(B3) hook chain must match its own session's pet");

// (B4) a hook under claude #2 matches nori, not raccoon
const hookChain2 = [9_200, 521, 520, 500, 4];
assert.equal(manager.findSessionPetLease(hookChain2)?.leaseId, noriLease.leaseId, "(B4) sibling session must match its own pet");

// (B5) sharing ONLY the terminal (and above) must NOT match — a session in a
// third tab without a dedicated pet stays on the default pet.
const foreignChain = [9_300, 531, 530, 500, 4];
assert.equal(manager.findSessionPetLease(foreignChain), undefined, "(B5) terminal-only overlap must not match");

// (B6) expired leases never match
now = 10_000;
assert.equal(manager.findSessionPetLease(hookChain1), undefined, "(B6) expired leases must not match");
assert.equal(manager.hasSessionRoutableLeases(), false, "(B6) expired leases are not routable");

// ---------------------------------------------------------------------------
// Part C — wiring source-regex assertions
// ---------------------------------------------------------------------------
const appRoot = process.env["OPENPETS_DESKTOP_ROOT"]
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// (C1) local-ipc: say and react handlers try session routing before the
// default-pet fallback, and identity resolution captures client ancestry.
{
  const src = readFileSync(join(appRoot, "src", "local-ipc.ts"), "utf-8");
  assert.equal((src.match(/resolveSessionPetTarget\(lease, params\)/g) ?? []).length, 2, "(C1) say AND react must attempt session routing");
  assert.ok(src.includes("captureClientAncestry(leaseId, clientPid)"), "(C1) identity resolution must capture client ancestry");
  assert.ok(src.includes("hasSessionRoutableLeases()"), "(C1) routing must fast-path when no session pets exist");
}

// (C2) client package: say/react requests carry the caller's pid and optional
// self-collected ancestry so lease-less helpers (hooks) can be routed.
{
  const clientSrc = readFileSync(join(appRoot, "..", "..", "packages", "client", "src", "index.ts"), "utf-8");
  assert.ok(/pet\.say"?,\s*\{[^}]*clientPid: process\.pid/.test(clientSrc), "(C2) pet.say must include clientPid");
  assert.ok(/pet\.react"?,\s*\{[^}]*clientPid: process\.pid/.test(clientSrc), "(C2) pet.react must include clientPid");
  assert.ok(/pet\.say"?,\s*\{[^}]*clientAncestorPids/.test(clientSrc), "(C2) pet.say must forward clientAncestorPids");
  assert.ok(/pet\.react"?,\s*\{[^}]*clientAncestorPids/.test(clientSrc), "(C2) pet.react must forward clientAncestorPids");
}

// (C3) caller-supplied ancestry is preferred (hooks die before a server-side
// walk can see them) and validated; the hook package collects its own chain.
{
  const src = readFileSync(join(appRoot, "src", "local-ipc.ts"), "utf-8");
  const fnStart = src.indexOf("async function resolveSessionPetTarget");
  assert.ok(fnStart >= 0, "(C3) resolveSessionPetTarget must exist");
  const fn = src.slice(fnStart);
  const supplied = fn.indexOf("validateClientAncestorPids(params.clientAncestorPids)");
  const walk = fn.indexOf("getAncestorPidChain(clientPid)");
  assert.ok(supplied >= 0, "(C3) routing must accept caller-supplied ancestry");
  assert.ok(walk > supplied, "(C3) caller-supplied ancestry must be preferred over a live walk");

  const hookSrc = readFileSync(join(appRoot, "..", "..", "packages", "claude", "src", "hooks.ts"), "utf-8");
  assert.ok(hookSrc.includes("collectOwnProcessAncestry()"), "(C3) hooks must collect their own ancestry");
  assert.ok(/say\([^)]*\{[^}]*clientAncestorPids/.test(hookSrc), "(C3) hook say must pass ancestry");
  assert.ok(/react\([^)]*\{?[^}]*clientAncestorPids/.test(hookSrc), "(C3) hook react must pass ancestry");
}

console.log("session-pet-routing validation passed.");
