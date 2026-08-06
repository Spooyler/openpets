/**
 * process-ancestry.ts
 *
 * Collect this process's ancestor PID chain ([pid, parent, grandparent, …])
 * so short-lived hook processes can identify their coding-agent session to the
 * OpenPets desktop app. The chain must be collected CLIENT-side: by the time
 * the app could walk it, the hook process is usually already gone.
 *
 * Platforms:
 *   - win32 : ONE PowerShell Get-CimInstance enumeration (pid→ppid map),
 *             walked in memory. Bounded by a hard timeout.
 *   - linux : /proc/<pid>/status PPid walk (sync reads, effectively free).
 *   - darwin: `ps -o pid=,ppid= -ax` single spawn, walked in memory.
 *   - other : just [process.pid].
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const maxDepth = 12;
// PowerShell startup + a full Win32_Process CIM enumeration measures ~2.1-2.4s
// on a normally-loaded Windows box, and higher when several sessions run hooks
// concurrently. A 2s ceiling made the enumeration time out on every call, so
// this fell back to [process.pid] (a length-1 chain) and desktop-side session
// routing could never match a bound pet — every say/react landed on the default
// pet. Keep a bounded best-effort budget, but well above the real cost.
const win32TimeoutMs = 8_000;

export async function collectOwnProcessAncestry(): Promise<readonly number[]> {
  try {
    if (process.platform === "win32") return await collectWin32();
    if (process.platform === "linux") return collectLinux();
    if (process.platform === "darwin") return await collectDarwin();
  } catch {
    // Fall through — ancestry is best-effort; the app has a server-side fallback.
  }
  return [process.pid];
}

function walkChain(startPid: number, parentOf: ReadonlyMap<number, number>): number[] {
  const chain = [startPid];
  const seen = new Set<number>([startPid]);
  let current = startPid;
  for (let i = 0; i < maxDepth; i++) {
    const parent = parentOf.get(current);
    if (parent === undefined || parent <= 0 || seen.has(parent)) break;
    chain.push(parent);
    seen.add(parent);
    current = parent;
  }
  return chain;
}

/** @internal exported for unit tests. */
export function parsePidPpidLines(stdout: string): Map<number, number> {
  const parentOf = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)[\s,;]+(\d+)\s*$/.exec(line);
    if (!match) continue;
    parentOf.set(parseInt(match[1]!, 10), parseInt(match[2]!, 10));
  }
  return parentOf;
}

async function collectWin32(): Promise<readonly number[]> {
  const script = "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }";
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { timeout: win32TimeoutMs },
  );
  return walkChain(process.pid, parsePidPpidLines(stdout));
}

function collectLinux(): readonly number[] {
  const chain = [process.pid];
  let current = process.pid;
  for (let i = 0; i < maxDepth; i++) {
    const status = readFileSync(`/proc/${current}/status`, "utf8");
    const match = /^PPid:\s*(\d+)/m.exec(status);
    if (!match) break;
    const parent = parseInt(match[1]!, 10);
    if (!Number.isFinite(parent) || parent <= 0 || chain.includes(parent)) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

async function collectDarwin(): Promise<readonly number[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid="], { timeout: win32TimeoutMs });
  return walkChain(process.pid, parsePidPpidLines(stdout));
}
