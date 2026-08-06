/**
 * herdr-window.ts
 *
 * OS-window raise for herdr-hosted sessions (phase 2 of the herdr
 * integration; pane/tab focus is herdr-focus.ts).
 *
 * Herdr panes run under a detached, windowless server process, so a session's
 * process ancestry never reaches a terminal emulator and the normal terminal
 * registration cannot raise a window for it. The visible window belongs to
 * the herdr *client* process (`herdr` with no CLI subcommand, or
 * `herdr --session x` / `herdr session attach x`) hosted inside a regular
 * terminal emulator. This module finds that client process by enumerating
 * herdr processes with their command lines, then reuses the standard
 * PPID-walk window resolution (window-tracker.ts) and terminal raise
 * (terminal-focus.ts) on the client PID.
 *
 * The resolved client PID is cached per socket path: enumeration costs a
 * PowerShell/ps spawn (~1s), but a client PID stays valid for the client's
 * lifetime — liveness is re-checked cheaply and enumeration re-runs only when
 * the cached PID died or stopped resolving to a window.
 *
 * Everything is fail-safe: a missing binary, no attached client, or an
 * ambiguous multi-client setup degrades to "window not raised" (pane focus
 * still fires), never to an error at the caller.
 *
 * logger / window-tracker / terminal-focus are lazy-loaded via createRequire
 * (same pattern as herdr-focus.ts) so this module stays importable from the
 * plain-Node test suite: those modules read Electron state at load time.
 */

import { execFile } from "node:child_process";
import { createRequire } from "node:module";

import type { HerdrFocusContext } from "./herdr-focus.js";

const nodeRequire = createRequire(import.meta.url);

type LoggerModule = typeof import("./logger.js");

function log(level: "debug" | "info", message: string, fields?: Record<string, unknown>): void {
  try {
    (nodeRequire("./logger.js") as LoggerModule)[level]("herdr-focus", message, fields);
  } catch {
    // Logger unavailable outside Electron (e.g. test suite) — logging is best-effort.
  }
}

/** One enumerated herdr process: pid plus its full command line. */
export interface HerdrProcessInfo {
  readonly pid: number;
  readonly commandLine: string;
}

/** Minimal shape of window-tracker's TerminalWindowInfo that this module needs. */
export interface HerdrClientWindow {
  readonly terminalPid: number;
  readonly window: { readonly id: number } | null;
}

/** Injectable seams — production defaults spawn PowerShell/ps and lazy-require Electron-side modules. */
export interface HerdrWindowDeps {
  readonly listProcesses: () => Promise<readonly HerdrProcessInfo[]>;
  readonly isPidAlive: (pid: number) => boolean;
  readonly resolveWindow: (clientPid: number) => Promise<HerdrClientWindow | null>;
  readonly raiseWindow: (terminalPid: number, terminalWindowId?: number) => Promise<boolean>;
  /**
   * PID of the process hosting the client's console (conhost/OpenConsole), or
   * null when unavailable. Fallback chain start when the client's own PPID
   * chain is severed (e.g. a dead `wt.exe` launcher between shell and
   * terminal): a WT-spawned OpenConsole is a direct child of the terminal
   * emulator, so walking from it still reaches the window. Win32 only.
   */
  readonly consoleHostPid: (clientPid: number) => Promise<number | null>;
}

// ---------------------------------------------------------------------------
// Client classification (pure)
// ---------------------------------------------------------------------------

/** Split a command line into tokens, honoring double quotes. */
function tokenize(commandLine: string): string[] {
  const tokens = commandLine.match(/"[^"]*"|\S+/g) ?? [];
  return tokens.map((token) => token.replace(/^"|"$/g, ""));
}

/**
 * Decide whether a herdr command line is a CLIENT invocation (attaches to a
 * session and owns the visible terminal) as opposed to the windowless server
 * (`herdr server`) or a one-shot CLI call (`herdr agent focus …`).
 * Returns the session name the client attached to (undefined = default
 * session), or null when the invocation is not a client.
 */
export function parseHerdrClientInvocation(commandLine: string): { sessionName: string | undefined } | null {
  const args = tokenize(commandLine).slice(1);
  if (args.length === 0) return { sessionName: undefined };
  const [first, second, third] = args;
  if (first === "session" && second === "attach") return { sessionName: third };
  // Any bare subcommand word (server, agent, pane, api, …) is not a client.
  if (!first!.startsWith("-")) return null;
  // Flag-style invocation (--session x, --remote host, …) launches a client.
  const sessionFlag = args.indexOf("--session");
  return { sessionName: sessionFlag !== -1 ? args[sessionFlag + 1] : undefined };
}

/**
 * Pick the client PID for the session the socket path belongs to.
 * With a single client the choice is unambiguous. With several, prefer the
 * one whose session name appears as a segment of the socket path; when that
 * still doesn't single one out, give up (null) — raising the WRONG terminal
 * window is worse than raising none (pane focus still fires).
 */
export function pickHerdrClientPid(processes: readonly HerdrProcessInfo[], socketPath?: string): number | null {
  const clients: Array<{ pid: number; sessionName: string | undefined }> = [];
  for (const proc of processes) {
    const parsed = parseHerdrClientInvocation(proc.commandLine);
    if (parsed) clients.push({ pid: proc.pid, sessionName: parsed.sessionName });
  }
  if (clients.length === 0) return null;
  if (clients.length === 1) return clients[0]!.pid;
  const segments = new Set((socketPath ?? "").toLowerCase().split(/[\\/]/).filter((segment) => segment.length > 0));
  const matches = clients.filter((client) => client.sessionName !== undefined && segments.has(client.sessionName.toLowerCase()));
  if (matches.length === 1) return matches[0]!.pid;
  log("debug", "ambiguous herdr client set — window raise skipped", { clientCount: clients.length, matchCount: matches.length });
  return null;
}

// ---------------------------------------------------------------------------
// Production deps
// ---------------------------------------------------------------------------

const enumerationTimeoutMs = 8_000;

async function listHerdrProcessesWin32(): Promise<readonly HerdrProcessInfo[]> {
  const script = `Get-CimInstance Win32_Process -Filter "Name='herdr.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: enumerationTimeoutMs, windowsHide: true }, (error, out) => {
      if (error) reject(error);
      else resolve(out);
    });
  });
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const processes: HerdrProcessInfo[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const { ProcessId, CommandLine } = row as { ProcessId?: unknown; CommandLine?: unknown };
    if (typeof ProcessId !== "number" || typeof CommandLine !== "string") continue;
    processes.push({ pid: ProcessId, commandLine: CommandLine });
  }
  return processes;
}

async function listHerdrProcessesPosix(): Promise<readonly HerdrProcessInfo[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile("ps", ["-eo", "pid=,args="], { timeout: enumerationTimeoutMs }, (error, out) => {
      if (error) reject(error);
      else resolve(out);
    });
  });
  const processes: HerdrProcessInfo[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const commandLine = match[2]!;
    const argv0 = tokenize(commandLine)[0] ?? "";
    const binary = argv0.split(/[\\/]/).pop() ?? "";
    if (binary !== "herdr" && binary !== "herdr.exe") continue;
    processes.push({ pid: Number(match[1]), commandLine });
  }
  return processes;
}

/**
 * Resolve the console host (conhost.exe / OpenConsole.exe) of a console app
 * via NtQueryInformationProcess(ProcessConsoleHostProcess = 49). The value's
 * low bit is a flag and must be masked off. Undocumented but stable since
 * Windows 7; failure just disables the fallback.
 */
async function consoleHostPidWin32(clientPid: number): Promise<number | null> {
  if (!Number.isInteger(clientPid) || clientPid <= 0) return null;
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class OpConsoleHost {
  [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr handle, int cls, out IntPtr info, int len, out int retLen);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@ -Language CSharp
$handle = [OpConsoleHost]::OpenProcess(0x1000, $false, ${clientPid})
if ($handle -eq [IntPtr]::Zero) { exit 2 }
$info = [IntPtr]::Zero; $retLen = 0
$status = [OpConsoleHost]::NtQueryInformationProcess($handle, 49, [ref]$info, [IntPtr]::Size, [ref]$retLen)
[OpConsoleHost]::CloseHandle($handle) | Out-Null
if ($status -ne 0) { exit 3 }
Write-Output ([long]$info -band (-bnot 1))`;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: enumerationTimeoutMs, windowsHide: true }, (error, out) => {
        if (error) reject(error);
        else resolve(out);
      });
    });
    const pid = Number(stdout.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signalable by us — alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function createDefaultDeps(): HerdrWindowDeps {
  return {
    listProcesses: process.platform === "win32" ? listHerdrProcessesWin32 : listHerdrProcessesPosix,
    isPidAlive: defaultIsPidAlive,
    resolveWindow: async (clientPid) => {
      const tracker = nodeRequire("./window-tracker.js") as typeof import("./window-tracker.js");
      return tracker.findTerminalWindowForPid(clientPid);
    },
    raiseWindow: (terminalPid, terminalWindowId) => {
      const focus = nodeRequire("./terminal-focus.js") as typeof import("./terminal-focus.js");
      return focus.focusTerminalWindow(terminalPid, terminalWindowId);
    },
    consoleHostPid: process.platform === "win32" ? consoleHostPidWin32 : async () => null,
  };
}

// ---------------------------------------------------------------------------
// Resolution + raise
// ---------------------------------------------------------------------------

const clientPidCache = new Map<string, number>();

/** Test hook: drop all cached client PIDs. */
export function clearHerdrClientPidCache(): void {
  clientPidCache.clear();
}

async function resolveClientPid(cacheKey: string, socketPath: string | undefined, deps: HerdrWindowDeps): Promise<{ pid: number; fromCache: boolean } | null> {
  const cached = clientPidCache.get(cacheKey);
  if (cached !== undefined && deps.isPidAlive(cached)) return { pid: cached, fromCache: true };
  clientPidCache.delete(cacheKey);
  const pid = pickHerdrClientPid(await deps.listProcesses(), socketPath);
  if (pid === null) return null;
  clientPidCache.set(cacheKey, pid);
  return { pid, fromCache: false };
}

/**
 * Window resolution for a client PID: try the client's own PPID chain first,
 * then re-anchor on its console host process. The latter recovers WT-hosted
 * setups whose shell chain contains a dead launcher. Both can fail (e.g. the
 * default-terminal handoff parents the console host to the windowless shell
 * side, leaving no process-tree link to the rendering terminal at all) —
 * callers must treat null as "window unknown".
 */
async function resolveClientWindow(clientPid: number, deps: HerdrWindowDeps): Promise<HerdrClientWindow | null> {
  const direct = await deps.resolveWindow(clientPid);
  if (direct) return direct;
  const hostPid = await deps.consoleHostPid(clientPid);
  if (hostPid === null || hostPid === clientPid) return null;
  return deps.resolveWindow(hostPid);
}

/**
 * Raise the OS window of the terminal hosting the session's herdr client.
 * Resolves true when the raise was dispatched, false otherwise. Never throws.
 */
export async function focusHerdrClientWindow(context: HerdrFocusContext, deps: HerdrWindowDeps = createDefaultDeps()): Promise<boolean> {
  const cacheKey = context.socketPath ?? "default";
  try {
    let resolved = await resolveClientPid(cacheKey, context.socketPath, deps);
    if (!resolved) {
      log("debug", "no herdr client found for window raise", { paneId: context.paneId });
      return false;
    }
    let windowInfo = await resolveClientWindow(resolved.pid, deps);
    if (!windowInfo && resolved.fromCache) {
      // The cached PID may have been reused by an unrelated process, or the
      // client re-attached from a different terminal — re-enumerate once.
      clientPidCache.delete(cacheKey);
      resolved = await resolveClientPid(cacheKey, context.socketPath, deps);
      if (!resolved) return false;
      windowInfo = await resolveClientWindow(resolved.pid, deps);
    }
    if (!windowInfo) {
      log("debug", "herdr client window not resolved", { paneId: context.paneId, clientPid: resolved.pid });
      return false;
    }
    const raised = await deps.raiseWindow(windowInfo.terminalPid, windowInfo.window?.id);
    log("info", "herdr client window raise dispatched", { paneId: context.paneId, clientPid: resolved.pid, terminalPid: windowInfo.terminalPid, raised });
    return raised;
  } catch (err) {
    log("debug", "herdr client window raise failed", { paneId: context.paneId, error: String(err) });
    return false;
  }
}
