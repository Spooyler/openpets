/**
 * Tests that acquiring an explicit lease always surfaces the pet window.
 *
 * Regression: adopting a pet whose window was dismissed under an earlier
 * lease produced no visible pet — and showAgentPet() skips dismissed pets.
 *
 * Spawning now happens when the session's terminal identity resolves (via the
 * window registry), but a 3-second grace timer on the explicit acquire still
 * clears any stale dismissal and shows the pet if no window has bound it yet —
 * preserving the reshow guarantee before identity lands.
 *
 * local-ipc.ts imports Electron, so the wiring is pinned with source-regex
 * assertions (capabilities-win32.test.ts pattern).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = process.env["OPENPETS_DESKTOP_ROOT"]
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = readFileSync(join(appRoot, "src", "local-ipc.ts"), "utf-8");

const acquireStart = src.indexOf(`request.method === "lease.acquire"`);
const heartbeatStart = src.indexOf(`request.method === "lease.heartbeat"`);
assert.ok(acquireStart >= 0 && heartbeatStart > acquireStart, "lease.acquire handler must exist");
const acquireHandler = src.slice(acquireStart, heartbeatStart);

// (1) explicit acquisitions clear any stale dismissal and show the pet
//     (via the 3s grace timer, keyed on the lease's actualTargetPetId)
{
  assert.ok(
    /if \(lease\.targetKind === "explicit"\)[\s\S]*?const gracePetId = lease\.actualTargetPetId;[\s\S]*?clearAgentPetDismissal\(gracePetId\);[\s\S]*?showAgentPet\(gracePetId\);/.test(acquireHandler),
    "(1) lease.acquire must clear dismissal and show the pet for explicit leases",
  );
}

// (2) dismissal must be cleared BEFORE showing (showAgentPet skips dismissed pets)
{
  const clearIdx = acquireHandler.indexOf("clearAgentPetDismissal");
  const showIdx = acquireHandler.indexOf("showAgentPet");
  assert.ok(clearIdx >= 0 && showIdx > clearIdx, "(2) clearAgentPetDismissal must run before showAgentPet");
}

console.log("agent-pet-reshow validation passed.");
