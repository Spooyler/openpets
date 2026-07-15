/**
 * Unit tests for computeScurryTarget (pure edge-target math), the sole
 * building block for scurryAllPetsToEdge() in pet-roaming-controller.ts.
 *
 * Rule: compare the window's horizontal center against the work area's
 * horizontal midpoint. Left of midpoint -> walk to the left edge. Right of
 * (or exactly at) midpoint -> walk to the right edge. The y coordinate is
 * always left unchanged (scurry is a horizontal-only move).
 */
import assert from "node:assert/strict";

import { computeScurryTarget } from "../src/pet-roaming-controller.js";

const workArea = { x: 0, y: 0, width: 1920, height: 1080 };

// Window center left of the work area midpoint -> target is the left edge.
{
  const bounds = { x: 100, y: 800, width: 64, height: 64 };
  const target = computeScurryTarget(bounds, workArea);
  assert.deepEqual(target, { x: 0, y: 800 }, "left-of-midpoint pet must walk to the left edge, y unchanged");
}

// Window center right of the work area midpoint -> target is the right edge.
{
  const bounds = { x: 1800, y: 800, width: 64, height: 64 };
  const target = computeScurryTarget(bounds, workArea);
  assert.deepEqual(target, { x: workArea.width - 64, y: 800 }, "right-of-midpoint pet must walk to the right edge, y unchanged");
}

// Already at the left edge -> target equals the current position (no-op).
{
  const bounds = { x: 0, y: 500, width: 64, height: 64 };
  const target = computeScurryTarget(bounds, workArea);
  assert.deepEqual(target, { x: 0, y: 500 }, "already at the left edge must stay in place");
}

// Already at the right edge -> target equals the current position (no-op).
{
  const bounds = { x: workArea.width - 64, y: 500, width: 64, height: 64 };
  const target = computeScurryTarget(bounds, workArea);
  assert.deepEqual(target, { x: workArea.width - 64, y: 500 }, "already at the right edge must stay in place");
}

// A work area with a non-zero origin (secondary monitor) is respected.
{
  const secondary = { x: 1920, y: 0, width: 1280, height: 800 };
  const boundsLeft = { x: 1920 + 50, y: 300, width: 64, height: 64 };
  assert.deepEqual(
    computeScurryTarget(boundsLeft, secondary),
    { x: secondary.x, y: 300 },
    "secondary monitor: left-of-midpoint targets that display's left edge",
  );
  const boundsRight = { x: 1920 + 1200, y: 300, width: 64, height: 64 };
  assert.deepEqual(
    computeScurryTarget(boundsRight, secondary),
    { x: secondary.x + secondary.width - 64, y: 300 },
    "secondary monitor: right-of-midpoint targets that display's right edge",
  );
}

// With spriteWidth: the sprite (not the window) should touch the screen edge.
// Window = 340px, sprite = 192px → margin = (340-192)/2 = 74px per side.
{
  const petBounds = { x: 100, y: 800, width: 340, height: 420 };
  const target = computeScurryTarget(petBounds, workArea, 192);
  assert.equal(target.x, 0 - 74, "left scurry with sprite offset: window extends 74px past screen edge");
  assert.equal(target.y, 800, "y unchanged");
}
{
  const petBounds = { x: 1500, y: 800, width: 340, height: 420 };
  const target = computeScurryTarget(petBounds, workArea, 192);
  assert.equal(target.x, 1920 - 340 + 74, "right scurry with sprite offset: window extends 74px past screen edge");
  assert.equal(target.y, 800, "y unchanged");
}

console.log("scurry-target.test.ts passed");
