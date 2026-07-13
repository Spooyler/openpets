/**
 * Terminal Focus Utility
 *
 * Raises a terminal (or any app) window to the front.
 *
 * Design decisions:
 * - macOS + Windows: Linux is a no-op (out of scope per plan).
 * - macOS uses the Accessibility API (AXRaise) via osascript — works with ANY
 *   terminal emulator (Ghostty, iTerm2, Terminal.app, VS Code, Warp, etc.)
 *   without knowing the app bundle identifier.
 * - macOS Accessibility permission is required. On first use we prompt the
 *   user with a one-time dialog; subsequent calls skip the prompt.
 * - If Accessibility is not trusted the function resolves silently — the pet
 *   is still usable; only the "focus" action is degraded.
 * - Windows uses user32 ShowWindow + SetForegroundWindow via PowerShell — no
 *   permission or prompt exists there.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { systemPreferences, shell, dialog } from "electron";

import { debug, error as logError, info } from "./logger.js";

const execFileAsync = promisify(execFile);

// Track whether we've already shown the one-time Accessibility prompt.
let accessibilityPromptShown = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Bring the terminal window owned by `pid` to the front.
 *
 * @param terminalPid - PID of the terminal process (owner of the window).
 * @returns true if the raise command was dispatched, false otherwise.
 */
export async function focusTerminalWindow(terminalPid: number): Promise<boolean> {
  if (process.platform === "win32") {
    return focusTerminalWindowWin32(terminalPid);
  }

  if (process.platform !== "darwin") {
    debug("terminal-focus", "skip focus — unsupported platform");
    return false;
  }

  const trusted = await checkAccessibilityPermission();
  if (!trusted) return false;

  try {
    // Use Accessibility API via osascript to raise the window of the process
    // with the given PID. This is app-agnostic and works for any terminal.
    const script = `
tell application "System Events"
  set theProc to first process whose unix id is ${terminalPid}
  set frontmost of theProc to true
  tell theProc
    set frontWindow to first window
    perform action "AXRaise" of frontWindow
  end tell
end tell
`;
    await execFileAsync("osascript", ["-e", script]);
    info("terminal-focus", "focus dispatched", { terminalPid });
    return true;
  } catch (err) {
    // Non-fatal: the pet still works, only the focus action failed.
    logError("terminal-focus", "focus failed", err instanceof Error ? err : new Error(String(err)));
    return false;
  }
}

/**
 * Windows implementation: restore (if minimized) and raise the main window of
 * the process with the given PID via user32 ShowWindow + SetForegroundWindow.
 * No permission prompt exists on Windows — this either works or fails softly.
 */
async function focusTerminalWindowWin32(terminalPid: number): Promise<boolean> {
  try {
    const script =
      `Add-Type -TypeDefinition '` +
      `using System;` +
      `using System.Runtime.InteropServices;` +
      `public class WinFocus {` +
      `  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);` +
      `  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);` +
      `  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);` +
      `}' -Language CSharp;` +
      `$proc = Get-Process -Id ${terminalPid} -ErrorAction SilentlyContinue;` +
      `if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {` +
      `  if ([WinFocus]::IsIconic($proc.MainWindowHandle)) { [WinFocus]::ShowWindow($proc.MainWindowHandle, 9) };` +
      `  [WinFocus]::SetForegroundWindow($proc.MainWindowHandle)` +
      `}`;

    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    info("terminal-focus", "focus dispatched (win32)", { terminalPid });
    return true;
  } catch (err) {
    logError("terminal-focus", "focus failed (win32)", err instanceof Error ? err : new Error(String(err)));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

/**
 * Check whether Accessibility permission is granted.
 * On first denial, show a one-time dialog prompting the user to grant it.
 */
async function checkAccessibilityPermission(): Promise<boolean> {
  const trusted = systemPreferences.isTrustedAccessibilityClient(false);
  if (trusted) return true;

  if (!accessibilityPromptShown) {
    accessibilityPromptShown = true;
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Accessibility Permission Required",
      message: "OpenPets needs Accessibility access to focus your terminal window.",
      detail: "Open System Settings → Privacy & Security → Accessibility and enable OpenPets, then try again.",
      buttons: ["Open System Settings", "Not Now"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      // Deep-link to the Accessibility pane.
      await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
    }
  }

  // Re-check after the user may have toggled the permission.
  return systemPreferences.isTrustedAccessibilityClient(false);
}
