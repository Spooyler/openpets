/**
 * console-inject.ts — Windows-only /compact injection for idle Claude Code chats.
 *
 * Mechanism: a Claude Code session's MCP client (our lease's clientPid) shares
 * its ConPTY console with the Claude Code CLI process that spawned it. A
 * PowerShell helper walks the CIM parent chain from clientPid, finds the
 * Claude Code ancestor (name/command line containing "claude" as a token),
 * attaches to that process's console (`AttachConsole`), opens `CONIN$`, and
 * writes synthetic key events (`WriteConsoleInputW`): Escape (clears any stale
 * input draft), a pause (so the ESC byte is not coalesced into an Alt-chord by
 * the TUI's escape-sequence parser), then "/compact" + Enter.
 *
 * Nothing here touches window focus — the injection lands in the target
 * console's input buffer even when its terminal tab is in the background.
 *
 * Design decisions (mirrors terminal-focus.ts):
 * - PowerShell + Add-Type keeps this dependency-free; the script is passed via
 *   -EncodedCommand to avoid any quoting/injection surface (the only dynamic
 *   value is the numeric PID, validated before interpolation).
 * - Fail-safe: every failure path resolves { ok: false, reason } and the
 *   caller decides UX. Exit codes: 3 = no Claude ancestor found (wrong agent —
 *   never inject), 4 = AttachConsole failed, 5 = console write failed.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { debug, error as logError, info } from "./logger.js";

const execFileAsync = promisify(execFile);

export type ConsoleInjectFailureReason = "unsupported_platform" | "invalid_pid" | "no_claude_ancestor" | "attach_failed" | "write_failed" | "spawn_failed";

export interface ConsoleInjectResult {
  readonly ok: boolean;
  readonly reason?: ConsoleInjectFailureReason;
}

// Kept as data (not inline concatenation) so the injected text is auditable
// at a glance. The command must stay a bare slash command — never user text.
const COMPACT_COMMAND = "/compact";

function buildScript(clientPid: number): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class OpConsoleInject {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint dwProcessId);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool WriteConsoleInputW(IntPtr hConsoleInput, INPUT_RECORD[] lpBuffer, uint nLength, out uint lpNumberOfEventsWritten);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct KEY_EVENT_RECORD {
    public int bKeyDown;
    public ushort wRepeatCount;
    public ushort wVirtualKeyCode;
    public ushort wVirtualScanCode;
    public char UnicodeChar;
    public uint dwControlKeyState;
  }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
  }
  static INPUT_RECORD Rec(bool down, ushort vk, char ch) {
    INPUT_RECORD r = new INPUT_RECORD();
    r.EventType = 1; // KEY_EVENT
    r.KeyEvent.bKeyDown = down ? 1 : 0;
    r.KeyEvent.wRepeatCount = 1;
    r.KeyEvent.wVirtualKeyCode = vk;
    r.KeyEvent.wVirtualScanCode = 0;
    r.KeyEvent.UnicodeChar = ch;
    r.KeyEvent.dwControlKeyState = 0;
    return r;
  }
  public static IntPtr OpenConin() {
    // GENERIC_READ|GENERIC_WRITE, FILE_SHARE_READ|FILE_SHARE_WRITE, OPEN_EXISTING
    return CreateFileW("CONIN$", 0xC0000000, 0x3, IntPtr.Zero, 3, 0, IntPtr.Zero);
  }
  public static bool SendKey(IntPtr conin, ushort vk, char ch) {
    INPUT_RECORD[] recs = new INPUT_RECORD[] { Rec(true, vk, ch), Rec(false, vk, ch) };
    uint written;
    return WriteConsoleInputW(conin, recs, (uint)recs.Length, out written) && written == recs.Length;
  }
  public static bool SendText(IntPtr conin, string text) {
    foreach (char c in text) {
      if (!SendKey(conin, 0, c)) return false;
    }
    return true;
  }
}
'@

$clientPid = ${clientPid}

# Walk the parent chain from the MCP client to find the Claude Code process.
# Stop at terminal emulators / shells' hosts — beyond them is not this session.
$cur = $clientPid
$target = 0
for ($i = 0; $i -lt 10 -and $cur -gt 4; $i++) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
  if (-not $p) { break }
  $probe = "$($p.Name) $($p.CommandLine)"
  if ($probe -match '(?i)(^|[\\\\/\\s"])claude(\\.exe|\\.cmd|\\.js|\\.mjs)?([\\s"]|$)') { $target = $cur; break }
  if ($p.Name -match '(?i)^(WindowsTerminal|conhost|openconsole|explorer|wt)') { break }
  $cur = [int]$p.ParentProcessId
}
if ($target -eq 0) { exit 3 }

[OpConsoleInject]::FreeConsole() | Out-Null
if (-not [OpConsoleInject]::AttachConsole([uint32]$target)) { exit 4 }
$conin = [OpConsoleInject]::OpenConin()
if ($conin -eq [IntPtr]::Zero -or $conin.ToInt64() -eq -1) { exit 4 }

# Escape clears any stale draft; the pauses keep the TUI's input parser from
# reading ESC + '/' as an Alt-chord and mimic human typing cadence.
if (-not [OpConsoleInject]::SendKey($conin, 0x1B, [char]0x1B)) { exit 5 }
Start-Sleep -Milliseconds 300
if (-not [OpConsoleInject]::SendText($conin, '${COMPACT_COMMAND}')) { exit 5 }
Start-Sleep -Milliseconds 150
if (-not [OpConsoleInject]::SendKey($conin, 0x0D, [char]13)) { exit 5 }
exit 0
`;
}

/**
 * Inject "/compact" into the Claude Code session that owns `clientPid`
 * (the session's MCP client process). Windows only.
 */
export async function injectCompactCommand(clientPid: number): Promise<ConsoleInjectResult> {
  if (process.platform !== "win32") return { ok: false, reason: "unsupported_platform" };
  if (!Number.isInteger(clientPid) || clientPid <= 0) return { ok: false, reason: "invalid_pid" };

  const encoded = Buffer.from(buildScript(clientPid), "utf16le").toString("base64");
  try {
    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
      { timeout: 20_000, windowsHide: true },
    );
    info("console-inject", "compact injected", { clientPid });
    return { ok: true };
  } catch (err) {
    const exitCode = (err as { code?: unknown })?.code;
    const reason: ConsoleInjectFailureReason =
      exitCode === 3 ? "no_claude_ancestor"
      : exitCode === 4 ? "attach_failed"
      : exitCode === 5 ? "write_failed"
      : "spawn_failed";
    if (reason === "no_claude_ancestor") {
      // Expected for non-Claude agents (e.g. a bare MCP client) — not an error.
      debug("console-inject", "no claude ancestor — skipping injection", { clientPid });
    } else {
      logError("console-inject", `compact injection failed (${reason})`, err instanceof Error ? err : new Error(String(err)));
    }
    return { ok: false, reason };
  }
}
