import assert from "node:assert/strict";

import { clearHerdrClientPidCache, focusHerdrClientWindow, isKnownTerminalBinary, parseHerdrClientInvocation, pickHerdrClientPid, type HerdrProcessInfo, type HerdrVisibleWindow, type HerdrWindowDeps } from "../src/herdr-window.js";

const exe = `"C:\\Users\\me\\AppData\\Local\\Programs\\Herdr\\bin\\herdr.exe"`;

// --- parseHerdrClientInvocation ---

{
  // Bare invocation (default session) is a client.
  assert.deepEqual(parseHerdrClientInvocation(exe), { sessionName: undefined });
  assert.deepEqual(parseHerdrClientInvocation("/usr/local/bin/herdr"), { sessionName: undefined });
  console.log("parse: bare invocation is a client — PASS");
}

{
  // The server and one-shot CLI calls are not clients.
  assert.equal(parseHerdrClientInvocation(`${exe} server`), null);
  assert.equal(parseHerdrClientInvocation(`${exe} agent focus wC:p1`), null);
  assert.equal(parseHerdrClientInvocation(`${exe} api snapshot`), null);
  assert.equal(parseHerdrClientInvocation(`${exe} session list`), null);
  assert.equal(parseHerdrClientInvocation(`${exe} status server`), null);
  console.log("parse: server and CLI calls rejected — PASS");
}

{
  // Named-session client forms carry the session name.
  assert.deepEqual(parseHerdrClientInvocation(`${exe} --session work`), { sessionName: "work" });
  assert.deepEqual(parseHerdrClientInvocation(`${exe} session attach work`), { sessionName: "work" });
  assert.deepEqual(parseHerdrClientInvocation(`${exe} --remote host --session work`), { sessionName: "work" });
  console.log("parse: named-session clients — PASS");
}

// --- pickHerdrClientPid ---

{
  // Single client wins regardless of session naming.
  const processes: HerdrProcessInfo[] = [
    { pid: 100, commandLine: exe },
    { pid: 200, commandLine: `${exe} server` },
    { pid: 300, commandLine: `${exe} agent wait --until done` },
  ];
  assert.equal(pickHerdrClientPid(processes), 100);
  console.log("pick: single client — PASS");
}

{
  // No client → null.
  assert.equal(pickHerdrClientPid([{ pid: 200, commandLine: `${exe} server` }]), null);
  assert.equal(pickHerdrClientPid([]), null);
  console.log("pick: no client returns null — PASS");
}

{
  // Multiple clients: the one whose session name appears in the socket path wins.
  const processes: HerdrProcessInfo[] = [
    { pid: 100, commandLine: exe },
    { pid: 300, commandLine: `${exe} --session work` },
  ];
  assert.equal(pickHerdrClientPid(processes, "C:\\Users\\me\\AppData\\Roaming\\herdr\\work\\herdr.sock"), 300);
  console.log("pick: session-name socket match — PASS");
}

{
  // Multiple clients with no disambiguating match → null (never guess).
  const processes: HerdrProcessInfo[] = [
    { pid: 100, commandLine: exe },
    { pid: 300, commandLine: `${exe} --session work` },
  ];
  assert.equal(pickHerdrClientPid(processes, "C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock"), null);
  assert.equal(pickHerdrClientPid(processes), null);
  console.log("pick: ambiguous set returns null — PASS");
}

// --- focusHerdrClientWindow ---

interface DepsScript {
  processes: HerdrProcessInfo[];
  alivePids: Set<number>;
  windows: Map<number, { terminalPid: number; window: { id: number } | null } | null>;
  raiseResult: boolean;
  consoleHosts?: Map<number, number>;
  visibleWindows?: HerdrVisibleWindow[];
}

function scriptedDeps(script: DepsScript): { deps: HerdrWindowDeps; calls: { list: number; raises: Array<{ terminalPid: number; windowId?: number }> } } {
  const calls = { list: 0, raises: [] as Array<{ terminalPid: number; windowId?: number }> };
  const deps: HerdrWindowDeps = {
    listProcesses: async () => { calls.list += 1; return script.processes; },
    isPidAlive: (pid) => script.alivePids.has(pid),
    resolveWindow: async (clientPid) => script.windows.get(clientPid) ?? null,
    raiseWindow: async (terminalPid, windowId) => { calls.raises.push({ terminalPid, windowId }); return script.raiseResult; },
    consoleHostPid: async (clientPid) => script.consoleHosts?.get(clientPid) ?? null,
    listWindows: script.visibleWindows ? async () => script.visibleWindows! : undefined,
  };
  return { deps, calls };
}

const context = { paneId: "wC:p4", tabId: "wC:t4", socketPath: "C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock" };

{
  // Happy path: enumerate → resolve window → raise.
  clearHerdrClientPidCache();
  const { deps, calls } = scriptedDeps({
    processes: [{ pid: 100, commandLine: exe }, { pid: 200, commandLine: `${exe} server` }],
    alivePids: new Set([100]),
    windows: new Map([[100, { terminalPid: 555, window: { id: 42 } }]]),
    raiseResult: true,
  });
  assert.equal(await focusHerdrClientWindow(context, deps), true);
  assert.deepEqual(calls.raises, [{ terminalPid: 555, windowId: 42 }]);
  console.log("focus: happy path raises terminal window — PASS");
}

{
  // Cached client PID skips re-enumeration while the PID is alive.
  clearHerdrClientPidCache();
  const { deps, calls } = scriptedDeps({
    processes: [{ pid: 100, commandLine: exe }],
    alivePids: new Set([100]),
    windows: new Map([[100, { terminalPid: 555, window: { id: 42 } }]]),
    raiseResult: true,
  });
  await focusHerdrClientWindow(context, deps);
  await focusHerdrClientWindow(context, deps);
  assert.equal(calls.list, 1);
  console.log("focus: client pid cached across calls — PASS");
}

{
  // Dead cached PID → re-enumerate and pick the new client.
  clearHerdrClientPidCache();
  const script: DepsScript = {
    processes: [{ pid: 100, commandLine: exe }],
    alivePids: new Set([100]),
    windows: new Map([
      [100, { terminalPid: 555, window: { id: 42 } }],
      [101, { terminalPid: 777, window: { id: 43 } }],
    ]),
    raiseResult: true,
  };
  const { deps, calls } = scriptedDeps(script);
  await focusHerdrClientWindow(context, deps);
  script.alivePids = new Set([101]);
  script.processes = [{ pid: 101, commandLine: exe }];
  // scriptedDeps closes over `script` fields via the object — rebuild deps with mutated script.
  const second = scriptedDeps(script);
  assert.equal(await focusHerdrClientWindow(context, second.deps), true);
  assert.equal(second.calls.list, 1);
  assert.deepEqual(second.calls.raises, [{ terminalPid: 777, windowId: 43 }]);
  assert.equal(calls.list, 1);
  console.log("focus: dead cached pid re-enumerates — PASS");
}

{
  // Cached PID alive but no longer resolves to a window → one re-enumeration.
  clearHerdrClientPidCache();
  const first = scriptedDeps({
    processes: [{ pid: 100, commandLine: exe }],
    alivePids: new Set([100]),
    windows: new Map([[100, { terminalPid: 555, window: { id: 42 } }]]),
    raiseResult: true,
  });
  await focusHerdrClientWindow(context, first.deps);
  const second = scriptedDeps({
    processes: [{ pid: 101, commandLine: exe }],
    alivePids: new Set([100, 101]),
    windows: new Map([[101, { terminalPid: 777, window: { id: 43 } }]]),
    raiseResult: true,
  });
  assert.equal(await focusHerdrClientWindow(context, second.deps), true);
  assert.equal(second.calls.list, 1);
  assert.deepEqual(second.calls.raises, [{ terminalPid: 777, windowId: 43 }]);
  console.log("focus: stale cache falls back to re-enumeration — PASS");
}

{
  // Minimized terminal (window null) still dispatches the raise by PID.
  clearHerdrClientPidCache();
  const { deps, calls } = scriptedDeps({
    processes: [{ pid: 100, commandLine: exe }],
    alivePids: new Set([100]),
    windows: new Map([[100, { terminalPid: 555, window: null }]]),
    raiseResult: true,
  });
  assert.equal(await focusHerdrClientWindow(context, deps), true);
  assert.deepEqual(calls.raises, [{ terminalPid: 555, windowId: undefined }]);
  console.log("focus: minimized terminal raised by pid — PASS");
}

{
  // Client PPID chain fails → console-host chain resolves the window instead
  // (WT-spawned OpenConsole is a direct child of the terminal emulator).
  clearHerdrClientPidCache();
  const { deps, calls } = scriptedDeps({
    processes: [{ pid: 100, commandLine: exe }],
    alivePids: new Set([100]),
    windows: new Map([[900, { terminalPid: 555, window: { id: 42 } }]]),
    raiseResult: true,
    consoleHosts: new Map([[100, 900]]),
  });
  assert.equal(await focusHerdrClientWindow(context, deps), true);
  assert.deepEqual(calls.raises, [{ terminalPid: 555, windowId: 42 }]);
  console.log("focus: console-host fallback resolves window — PASS");
}

{
  // No client / no window / failing deps → false, never throws.
  clearHerdrClientPidCache();
  const noClient = scriptedDeps({ processes: [{ pid: 200, commandLine: `${exe} server` }], alivePids: new Set(), windows: new Map(), raiseResult: true });
  assert.equal(await focusHerdrClientWindow(context, noClient.deps), false);

  clearHerdrClientPidCache();
  const noWindow = scriptedDeps({ processes: [{ pid: 100, commandLine: exe }], alivePids: new Set([100]), windows: new Map(), raiseResult: true });
  assert.equal(await focusHerdrClientWindow(context, noWindow.deps), false);

  clearHerdrClientPidCache();
  const throwing: HerdrWindowDeps = {
    listProcesses: async () => { throw new Error("spawn failed"); },
    isPidAlive: () => false,
    resolveWindow: async () => null,
    raiseWindow: async () => false,
    consoleHostPid: async () => null,
  };
  assert.equal(await focusHerdrClientWindow(context, throwing), false);
  console.log("focus: failure paths return false — PASS");
}

// --- isKnownTerminalBinary ---

{
  assert.equal(isKnownTerminalBinary("C:\\Program Files\\WindowsApps\\WindowsTerminal.exe"), true);
  assert.equal(isKnownTerminalBinary("/usr/bin/alacritty.exe"), true);
  assert.equal(isKnownTerminalBinary("C:\\tools\\mintty.exe"), true);
  assert.equal(isKnownTerminalBinary("C:\\Windows\\explorer.exe"), false);
  assert.equal(isKnownTerminalBinary(undefined), false);
  assert.equal(isKnownTerminalBinary(""), false);
  console.log("isKnownTerminalBinary: known and unknown binaries — PASS");
}

// --- broad terminal scan fallback ---

{
  // PPID chain fails, console host fails, but broad scan finds the single
  // terminal emulator window → raises it.
  clearHerdrClientPidCache();
  const { deps, calls } = scriptedDeps({
    processes: [{ pid: 100, commandLine: exe }],
    alivePids: new Set([100]),
    windows: new Map(), // PPID chain yields nothing
    raiseResult: true,
    visibleWindows: [
      { id: 999, ownerPid: 555, ownerPath: "C:\\Program Files\\WindowsApps\\WindowsTerminal.exe" },
    ],
  });
  assert.equal(await focusHerdrClientWindow(context, deps), true);
  assert.deepEqual(calls.raises, [{ terminalPid: 555, windowId: 999 }]);
  console.log("focus: broad scan single terminal raises window — PASS");
}

{
  // Broad scan with title preference: picks the window whose title contains "herdr".
  clearHerdrClientPidCache();
  const { deps, calls } = scriptedDeps({
    processes: [{ pid: 100, commandLine: exe }],
    alivePids: new Set([100]),
    windows: new Map(),
    raiseResult: true,
    visibleWindows: [
      { id: 998, ownerPid: 555, ownerPath: "C:\\Program Files\\WindowsApps\\WindowsTerminal.exe", title: "PowerShell" },
      { id: 999, ownerPid: 555, ownerPath: "C:\\Program Files\\WindowsApps\\WindowsTerminal.exe", title: "herdr - work" },
    ],
  });
  assert.equal(await focusHerdrClientWindow(context, deps), true);
  assert.deepEqual(calls.raises, [{ terminalPid: 555, windowId: 999 }]);
  console.log("focus: broad scan prefers herdr-titled window — PASS");
}

{
  // Multiple terminal emulator PROCESSES → ambiguous → no raise.
  clearHerdrClientPidCache();
  const { deps, calls } = scriptedDeps({
    processes: [{ pid: 100, commandLine: exe }],
    alivePids: new Set([100]),
    windows: new Map(),
    raiseResult: true,
    visibleWindows: [
      { id: 998, ownerPid: 555, ownerPath: "C:\\Program Files\\WindowsApps\\WindowsTerminal.exe" },
      { id: 999, ownerPid: 666, ownerPath: "C:\\tools\\alacritty.exe" },
    ],
  });
  assert.equal(await focusHerdrClientWindow(context, deps), false);
  assert.equal(calls.raises.length, 0);
  console.log("focus: broad scan multiple terminal processes skips — PASS");
}

{
  // No listWindows dep → broad scan skipped gracefully.
  clearHerdrClientPidCache();
  const { deps, calls } = scriptedDeps({
    processes: [{ pid: 100, commandLine: exe }],
    alivePids: new Set([100]),
    windows: new Map(),
    raiseResult: true,
    // visibleWindows intentionally omitted
  });
  assert.equal(await focusHerdrClientWindow(context, deps), false);
  assert.equal(calls.raises.length, 0);
  console.log("focus: no listWindows dep skips broad scan — PASS");
}

clearHerdrClientPidCache();
console.log("Herdr window validation passed.");
