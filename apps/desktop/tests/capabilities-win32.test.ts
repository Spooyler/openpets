/**
 * Unit tests for capabilities.ts platform extensions.
 *
 * capabilities.ts imports Electron (systemPreferences) so it cannot be
 * imported directly in plain Node. We use source-regex assertions to pin the
 * critical platform-dispatch text, plus a pure helper for the
 * isConfinementSupported logic.
 *
 * Source-reading path follows the same pattern as default-pet-external-show.test.ts:
 * use OPENPETS_DESKTOP_ROOT env (set by run-tests.mjs) or fall back to
 * dirname(import.meta.url) + "../.." to reach apps/desktop from .test-dist/tests/.
 *
 * Tests:
 *   (1) Source-regex: isConfinementSupported includes win32.
 *   (2) Source-regex: isConfinementSupported includes linux.
 *   (3) Source-regex: probeConfinementCapabilities has a win32 branch that
 *       returns supported:true without any systemPreferences call first.
 *   (4) Pure logic replica: isConfinementSupported(platform) returns expected
 *       values for darwin, win32, linux, freebsd.
 *   (5) Pure logic replica: probeConfinementCapabilities on win32 returns
 *       supported:true, trackingAvailable:true, focusActionAvailable:true.
 *   (6) Source-regex: win32 branch of probeConfinementCapabilities enables
 *       the focus action (no focusUnavailableReason), and
 *       isFocusActionAvailable returns true on win32.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the source tree root — same technique as default-pet-external-show.test.ts.
// When run as a compiled .js file under .test-dist/tests/, ../.. reaches apps/desktop/.
const appRoot = process.env["OPENPETS_DESKTOP_ROOT"]
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = readFileSync(join(appRoot, "src", "capabilities.ts"), "utf-8");

// ---------------------------------------------------------------------------
// (1) isConfinementSupported includes win32
// ---------------------------------------------------------------------------
{
  assert.ok(
    src.includes(`process.platform === "win32"`),
    "(1) isConfinementSupported must include win32 check",
  );
}

// ---------------------------------------------------------------------------
// (2) isConfinementSupported includes linux
// ---------------------------------------------------------------------------
{
  assert.ok(
    src.includes(`process.platform === "linux"`),
    "(2) isConfinementSupported must include linux check",
  );
}

// ---------------------------------------------------------------------------
// (3) probeConfinementCapabilities has win32 branch before systemPreferences call
// ---------------------------------------------------------------------------
{
  const win32BranchIdx = src.indexOf(`process.platform === "win32"`);
  const systemPrefsIdx = src.indexOf("systemPreferences.isTrustedAccessibilityClient");
  assert.ok(win32BranchIdx >= 0, "(3) win32 branch must be present in capabilities.ts");
  assert.ok(
    win32BranchIdx < systemPrefsIdx,
    "(3) win32 branch must appear before systemPreferences call (no SR requirement on Windows)",
  );
  assert.ok(
    src.includes("supported: true"),
    "(3) probeConfinementCapabilities must return supported:true for win32",
  );
}

// ---------------------------------------------------------------------------
// (4) Pure logic replica — isConfinementSupported for each platform
// ---------------------------------------------------------------------------
function isConfinementSupportedFor(platform: string): boolean {
  return platform === "darwin" || platform === "win32" || platform === "linux";
}

assert.equal(isConfinementSupportedFor("darwin"), true, "(4) darwin → supported");
assert.equal(isConfinementSupportedFor("win32"), true, "(4) win32 → supported");
assert.equal(isConfinementSupportedFor("linux"), true, "(4) linux → supported");
assert.equal(isConfinementSupportedFor("freebsd"), false, "(4) freebsd → not supported");
assert.equal(isConfinementSupportedFor("openbsd"), false, "(4) openbsd → not supported");

// ---------------------------------------------------------------------------
// (5) Pure logic replica — probeConfinementCapabilities on win32
// ---------------------------------------------------------------------------
{
  function probeForPlatform(platform: string): {
    supported: boolean;
    trackingAvailable: boolean;
    focusActionAvailable: boolean;
  } {
    if (platform === "win32") {
      return { supported: true, trackingAvailable: true, focusActionAvailable: true };
    }
    if (platform === "linux") {
      return { supported: true, trackingAvailable: true, focusActionAvailable: false };
    }
    if (platform !== "darwin") {
      return { supported: false, trackingAvailable: false, focusActionAvailable: false };
    }
    return { supported: true, trackingAvailable: true, focusActionAvailable: false };
  }

  const win32Caps = probeForPlatform("win32");
  assert.equal(win32Caps.supported, true, "(5) win32 supported");
  assert.equal(win32Caps.trackingAvailable, true, "(5) win32 trackingAvailable");
  assert.equal(win32Caps.focusActionAvailable, true, "(5) win32 focusAction available");

  const linuxCaps = probeForPlatform("linux");
  assert.equal(linuxCaps.supported, true, "(5) linux supported");
  assert.equal(linuxCaps.trackingAvailable, true, "(5) linux trackingAvailable");

  const bsdCaps = probeForPlatform("freebsd");
  assert.equal(bsdCaps.supported, false, "(5) freebsd not supported");
}

// ---------------------------------------------------------------------------
// (6) Source-regex: win32 branch of probeConfinementCapabilities enables focus
// ---------------------------------------------------------------------------
{
  const win32BranchIdx = src.indexOf(`process.platform === "win32"`);
  const linuxBranchIdx = src.indexOf(`process.platform === "linux"`);
  const win32Branch = src.slice(win32BranchIdx, linuxBranchIdx);
  assert.ok(
    win32Branch.includes("focusActionAvailable: true"),
    "(6) win32 branch must return focusActionAvailable:true",
  );
  assert.ok(
    !win32Branch.includes("focusUnavailableReason"),
    "(6) win32 branch must not set focusUnavailableReason",
  );
  assert.ok(
    src.includes(`if (process.platform === "win32") return true;`),
    "(6) isFocusActionAvailable must return true on win32",
  );
}

console.log("capabilities-win32 validation passed.");
