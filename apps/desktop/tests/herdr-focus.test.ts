import assert from "node:assert/strict";

import { focusHerdrPane, validateHerdrFocusContext, type HerdrCommandRunner } from "../src/herdr-focus.js";

// --- validateHerdrFocusContext ---

{
  // Valid full context passes through.
  const context = validateHerdrFocusContext({ paneId: "wC:p1", tabId: "wC:t1", socketPath: "C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock" });
  assert.deepEqual(context, { paneId: "wC:p1", tabId: "wC:t1", socketPath: "C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock" });
  console.log("validate: full context — PASS");
}

{
  // paneId alone is enough; optional fields become undefined.
  const context = validateHerdrFocusContext({ paneId: "wA:p12" });
  assert.equal(context?.paneId, "wA:p12");
  assert.equal(context?.tabId, undefined);
  assert.equal(context?.socketPath, undefined);
  console.log("validate: paneId only — PASS");
}

{
  // Malformed inputs are rejected wholesale (undefined), never thrown.
  assert.equal(validateHerdrFocusContext(undefined), undefined);
  assert.equal(validateHerdrFocusContext(null), undefined);
  assert.equal(validateHerdrFocusContext("wC:p1"), undefined);
  assert.equal(validateHerdrFocusContext({}), undefined);
  assert.equal(validateHerdrFocusContext({ paneId: 42 }), undefined);
  assert.equal(validateHerdrFocusContext({ paneId: "" }), undefined);
  assert.equal(validateHerdrFocusContext({ paneId: "bad id with spaces" }), undefined);
  assert.equal(validateHerdrFocusContext({ paneId: ":leading-colon" }), undefined);
  assert.equal(validateHerdrFocusContext({ paneId: "x".repeat(65) }), undefined);
  console.log("validate: malformed paneId rejected — PASS");
}

{
  // A bad optional field is dropped without invalidating the whole context.
  const badTab = validateHerdrFocusContext({ paneId: "wC:p1", tabId: "no spaces allowed" });
  assert.equal(badTab?.paneId, "wC:p1");
  assert.equal(badTab?.tabId, undefined);
  const relativeSocket = validateHerdrFocusContext({ paneId: "wC:p1", socketPath: "relative/path.sock" });
  assert.equal(relativeSocket?.socketPath, undefined);
  const traversalSocket = validateHerdrFocusContext({ paneId: "wC:p1", socketPath: "C:\\Users\\me\\..\\other\\herdr.sock" });
  assert.equal(traversalSocket?.socketPath, undefined);
  const longSocket = validateHerdrFocusContext({ paneId: "wC:p1", socketPath: `C:\\${"x".repeat(600)}` });
  assert.equal(longSocket?.socketPath, undefined);
  console.log("validate: bad optional fields dropped — PASS");
}

{
  // Unix-style absolute socket paths are accepted too.
  const context = validateHerdrFocusContext({ paneId: "wC:p1", socketPath: "/run/user/1000/herdr.sock" });
  assert.equal(context?.socketPath, "/run/user/1000/herdr.sock");
  console.log("validate: posix socket path — PASS");
}

// --- focusHerdrPane ---

function recordingRunner(failing: ReadonlySet<string>): { calls: Array<{ args: readonly string[]; socketPath: string | undefined }>; runner: HerdrCommandRunner } {
  const calls: Array<{ args: readonly string[]; socketPath: string | undefined }> = [];
  const runner: HerdrCommandRunner = async (args, env) => {
    calls.push({ args, socketPath: env.HERDR_SOCKET_PATH });
    if (failing.has(args.join(" "))) throw new Error(`simulated failure: ${args.join(" ")}`);
  };
  return { calls, runner };
}

{
  // Happy path: agent focus succeeds, no tab fallback attempted.
  const { calls, runner } = recordingRunner(new Set());
  const focused = await focusHerdrPane({ paneId: "wC:p1", tabId: "wC:t1" }, runner);
  assert.equal(focused, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.args, ["agent", "focus", "wC:p1"]);
  console.log("focus: agent focus succeeds — PASS");
}

{
  // agent focus fails → tab focus fallback succeeds.
  const { calls, runner } = recordingRunner(new Set(["agent focus wC:p1"]));
  const focused = await focusHerdrPane({ paneId: "wC:p1", tabId: "wC:t1" }, runner);
  assert.equal(focused, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.args, ["tab", "focus", "wC:t1"]);
  console.log("focus: tab fallback — PASS");
}

{
  // Both commands fail → false, never throws.
  const { runner } = recordingRunner(new Set(["agent focus wC:p1", "tab focus wC:t1"]));
  const focused = await focusHerdrPane({ paneId: "wC:p1", tabId: "wC:t1" }, runner);
  assert.equal(focused, false);
  console.log("focus: both fail returns false — PASS");
}

{
  // No tabId → no fallback attempted after agent focus failure.
  const { calls, runner } = recordingRunner(new Set(["agent focus wC:p1"]));
  const focused = await focusHerdrPane({ paneId: "wC:p1" }, runner);
  assert.equal(focused, false);
  assert.equal(calls.length, 1);
  console.log("focus: no tab fallback without tabId — PASS");
}

{
  // socketPath is exported to the CLI environment; absent otherwise.
  const withSocket = recordingRunner(new Set());
  await focusHerdrPane({ paneId: "wC:p1", socketPath: "C:\\sock\\herdr.sock" }, withSocket.runner);
  assert.equal(withSocket.calls[0]!.socketPath, "C:\\sock\\herdr.sock");
  const priorEnv = process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_SOCKET_PATH;
  try {
    const withoutSocket = recordingRunner(new Set());
    await focusHerdrPane({ paneId: "wC:p1" }, withoutSocket.runner);
    assert.equal(withoutSocket.calls[0]!.socketPath, undefined);
  } finally {
    if (priorEnv !== undefined) process.env.HERDR_SOCKET_PATH = priorEnv;
  }
  console.log("focus: socket path env override — PASS");
}

console.log("Herdr focus validation passed.");
