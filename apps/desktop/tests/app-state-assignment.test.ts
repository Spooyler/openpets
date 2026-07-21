/**
 * Unit tests for sessionAssignment / petSelectionStrategy normalization and migration:
 *   (1) normalizeSessionAssignment defaults to "hub", accepts "auto-spawn", rejects invalid
 *   (2) normalizePetSelectionStrategy defaults to "random", accepts "ordered", rejects invalid
 *   (3) Migration: petPoolEnabled=true + no explicit sessionAssignment -> "auto-spawn"
 *       petPoolEnabled=false -> "hub"; explicit sessionAssignment is never overridden
 *
 * NOTE: app-state.ts imports Electron so we cannot import it here directly.
 * We test the pure normalizers from app-state-core.ts directly, and simulate the
 * migration branch that lives in normalizePreferences() (app-state.ts) since that
 * logic is a one-line ternary over the pure normalizer.
 */
import assert from "node:assert/strict";

import { normalizePetSelectionStrategy, normalizeSessionAssignment } from "../src/app-state-core.js";

// --- normalizeSessionAssignment ---

assert.equal(normalizeSessionAssignment(undefined), "hub", "undefined -> default hub");
assert.equal(normalizeSessionAssignment(null), "hub", "null -> default hub");
assert.equal(normalizeSessionAssignment("bogus"), "hub", "invalid string -> default hub");
assert.equal(normalizeSessionAssignment(42), "hub", "number -> default hub");
assert.equal(normalizeSessionAssignment({}), "hub", "object -> default hub");
assert.equal(normalizeSessionAssignment("hub"), "hub", "'hub' -> hub");
assert.equal(normalizeSessionAssignment("auto-spawn"), "auto-spawn", "'auto-spawn' -> auto-spawn");

// --- normalizePetSelectionStrategy ---

assert.equal(normalizePetSelectionStrategy(undefined), "random", "undefined -> default random");
assert.equal(normalizePetSelectionStrategy(null), "random", "null -> default random");
assert.equal(normalizePetSelectionStrategy("bogus"), "random", "invalid string -> default random");
assert.equal(normalizePetSelectionStrategy(42), "random", "number -> default random");
assert.equal(normalizePetSelectionStrategy("random"), "random", "'random' -> random");
assert.equal(normalizePetSelectionStrategy("ordered"), "ordered", "'ordered' -> ordered");

// --- Migration logic (mirrors the ternary in normalizePreferences()) ---
function simulateMigratedSessionAssignment(value: { sessionAssignment?: unknown; petPoolEnabled?: unknown }): "hub" | "auto-spawn" {
  return value.sessionAssignment === undefined && value.petPoolEnabled === true
    ? "auto-spawn"
    : normalizeSessionAssignment(value.sessionAssignment);
}

assert.equal(
  simulateMigratedSessionAssignment({ petPoolEnabled: true }),
  "auto-spawn",
  "(3a) petPoolEnabled=true with no explicit sessionAssignment migrates to auto-spawn",
);

assert.equal(
  simulateMigratedSessionAssignment({ petPoolEnabled: false }),
  "hub",
  "(3b) petPoolEnabled=false with no explicit sessionAssignment stays hub",
);

assert.equal(
  simulateMigratedSessionAssignment({}),
  "hub",
  "(3c) no petPoolEnabled and no sessionAssignment defaults to hub",
);

assert.equal(
  simulateMigratedSessionAssignment({ sessionAssignment: "hub", petPoolEnabled: true }),
  "hub",
  "(3d) explicit sessionAssignment is not overridden by petPoolEnabled=true",
);

assert.equal(
  simulateMigratedSessionAssignment({ sessionAssignment: "auto-spawn", petPoolEnabled: false }),
  "auto-spawn",
  "(3e) explicit sessionAssignment is not overridden by petPoolEnabled=false",
);

console.log("app-state-assignment tests passed.");
