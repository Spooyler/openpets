/**
 * Unit tests for terminal-focus.ts win32 support.
 *
 * terminal-focus.ts imports Electron (systemPreferences, dialog, shell) so it
 * cannot be imported directly in plain Node. Source-regex assertions pin the
 * critical win32-dispatch text, following capabilities-win32.test.ts.
 *
 * Tests:
 *   (1) focusTerminalWindow dispatches to a win32 branch before the darwin
 *       bail-out.
 *   (2) The win32 implementation invokes powershell.exe with -NoProfile and
 *       -NonInteractive.
 *   (3) The PowerShell script P/Invokes ShowWindow with SW_RESTORE (9) and
 *       SetForegroundWindow from user32.dll.
 *   (4) The win32 path interpolates the terminal PID into Get-Process.
 *   (5) SW_RESTORE is guarded by IsIconic so a maximized (non-minimized)
 *       window keeps its maximized state when focused.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = process.env["OPENPETS_DESKTOP_ROOT"]
  ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = readFileSync(join(appRoot, "src", "terminal-focus.ts"), "utf-8");

// (1) win32 dispatch before darwin bail-out
{
  const win32Idx = src.indexOf(`process.platform === "win32"`);
  const darwinBailIdx = src.indexOf(`process.platform !== "darwin"`);
  assert.ok(win32Idx >= 0, "(1) win32 branch must exist");
  assert.ok(win32Idx < darwinBailIdx, "(1) win32 branch must come before darwin bail-out");
  assert.ok(src.includes("focusTerminalWindowWin32"), "(1) must delegate to focusTerminalWindowWin32");
}

// (2) powershell invocation flags
{
  assert.ok(src.includes(`"powershell.exe"`), "(2) must invoke powershell.exe");
  assert.ok(src.includes(`"-NoProfile"`), "(2) must pass -NoProfile");
  assert.ok(src.includes(`"-NonInteractive"`), "(2) must pass -NonInteractive");
}

// (3) user32 P/Invoke with SW_RESTORE
{
  assert.ok(src.includes("SetForegroundWindow"), "(3) must P/Invoke SetForegroundWindow");
  assert.ok(src.includes("ShowWindow"), "(3) must P/Invoke ShowWindow");
  assert.ok(src.includes(`user32.dll`), "(3) must import from user32.dll");
  assert.ok(/ShowWindow\([^)]*,\s*9\)/.test(src), "(3) must call ShowWindow with SW_RESTORE (9)");
}

// (4) PID interpolation
{
  assert.ok(src.includes("Get-Process -Id ${terminalPid}"), "(4) must query the terminal PID");
}

// (5) restore only when minimized — a maximized window must stay maximized
{
  assert.ok(src.includes("IsIconic"), "(5) must P/Invoke IsIconic");
  assert.ok(
    /if \(\[WinFocus\]::IsIconic\([^)]*\)\) \{[^}]*ShowWindow\([^)]*,\s*9\)/.test(src),
    "(5) ShowWindow(SW_RESTORE) must be guarded by IsIconic",
  );
}

console.log("terminal-focus-win32 validation passed.");
