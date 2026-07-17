import assert from "node:assert/strict";

import { pickTerminalForChain, type MatchableTerminal } from "./match.js";

function term(pid: number | undefined, delayMs = 0): MatchableTerminal {
  return {
    processId: new Promise((resolve) => setTimeout(() => resolve(pid), delayMs)),
  };
}

// direct match by shell pid in ancestor chain
assert.equal(await pickTerminalForChain([term(100), term(200)], [999, 200, 4], 200), 1);

// no match
assert.equal(await pickTerminalForChain([term(100), term(200)], [1, 2, 3], 200), null);

// empty inputs
assert.equal(await pickTerminalForChain([], [1], 200), null);
assert.equal(await pickTerminalForChain([term(100)], [], 200), null);

// undefined processId is skipped, others still match
assert.equal(await pickTerminalForChain([term(undefined), term(42)], [42], 200), 1);

// slow processId beyond the cap is treated as unresolved (no hang)
const started = Date.now();
assert.equal(await pickTerminalForChain([term(42, 500)], [42], 50), null);
assert.ok(Date.now() - started < 400, "cap must bound the wait");

// first matching terminal wins when several match
assert.equal(await pickTerminalForChain([term(7), term(7)], [7], 200), 0);

console.error("vscode-extension match tests passed.");
