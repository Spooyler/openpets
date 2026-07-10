/**
 * Tests that manual pet dragging cannot strand the pet window off-screen.
 *
 * pet-window.ts imports Electron so it cannot be imported in plain Node.
 * Source-regex assertions pin the drag-move clamp, following the
 * capabilities-win32.test.ts pattern.
 *
 * Tests:
 *   (1) handleDragMove clamps the computed position before setBounds.
 *   (2) The clamp respects the cross-display roaming flag (nearest-display
 *       clamp when roaming, work-area clamp otherwise), matching the wander
 *       path in getSafeDefaultPetPosition.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = process.env["OPENPETS_DESKTOP_ROOT"]
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = readFileSync(join(appRoot, "src", "pet-window.ts"), "utf-8");

const dragMoveStart = src.indexOf("const handleDragMove");
const dragMoveEnd = src.indexOf("const handleDragEnd");
assert.ok(dragMoveStart >= 0 && dragMoveEnd > dragMoveStart, "handleDragMove region must exist");
const dragMove = src.slice(dragMoveStart, dragMoveEnd);

// (1) drag move must clamp before applying bounds
{
  const clampIdx = dragMove.indexOf("clampToVisibleWorkArea");
  const setBoundsIdx = dragMove.indexOf("window.setBounds");
  assert.ok(clampIdx >= 0, "(1) handleDragMove must clamp to the visible work area");
  assert.ok(setBoundsIdx > clampIdx, "(1) clamp must happen before setBounds");
}

// (2) clamp respects the cross-display roaming flag
{
  assert.ok(
    dragMove.includes("isCrossDisplayRoamingEnabled()"),
    "(2) drag clamp must check the roaming flag",
  );
  assert.ok(
    dragMove.includes("clampToNearestDisplayIfOffscreen"),
    "(2) roaming mode must use the nearest-display clamp",
  );
}

console.log("pet-drag-clamp validation passed.");
