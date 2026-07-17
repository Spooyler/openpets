import assert from "node:assert/strict";

import {
  maxParkedWaitFocus,
  parkWaitFocus,
  parkedWaitFocusCount,
  pruneWaitFocus,
  requestTabReveal,
  waitFocusKeepaliveMs,
  type VsCodeFocusPayload,
} from "../src/vscode-tab-focus.js";

// requestTabReveal with nothing parked -> false
assert.equal(requestTabReveal([1, 2, 3]), false);
assert.equal(parkedWaitFocusCount(), 0);

// park one, reveal completes it with the chain
const received: VsCodeFocusPayload[] = [];
const park1 = parkWaitFocus({ requestId: "r1", respond: (p) => received.push(p) });
assert.equal(park1.accepted, true);
assert.equal(parkedWaitFocusCount(), 1);
assert.equal(requestTabReveal([10, 20]), true);
assert.equal(received.length, 1);
assert.deepEqual(received[0], { command: "reveal-terminal", sessionAncestorPids: [10, 20] });
// completion removes the parked entry
assert.equal(parkedWaitFocusCount(), 0);
assert.equal(requestTabReveal([10, 20]), false);

// reveal completes ALL parked requests
const gotA: VsCodeFocusPayload[] = [];
const gotB: VsCodeFocusPayload[] = [];
parkWaitFocus({ requestId: "rA", respond: (p) => gotA.push(p) });
parkWaitFocus({ requestId: "rB", respond: (p) => gotB.push(p) });
assert.equal(requestTabReveal([7]), true);
assert.equal(gotA.length, 1);
assert.equal(gotB.length, 1);
assert.equal(parkedWaitFocusCount(), 0);

// duplicate requestId replaces the previous entry (old one answered with keepalive)
const dupFirst: VsCodeFocusPayload[] = [];
const dupSecond: VsCodeFocusPayload[] = [];
parkWaitFocus({ requestId: "dup", respond: (p) => dupFirst.push(p) });
parkWaitFocus({ requestId: "dup", respond: (p) => dupSecond.push(p) });
assert.equal(parkedWaitFocusCount(), 1);
assert.deepEqual(dupFirst, [{ command: null }]);
requestTabReveal([1]);
assert.equal(dupSecond.length, 1);

// prune removes without responding
const pruned: VsCodeFocusPayload[] = [];
parkWaitFocus({ requestId: "rp", respond: (p) => pruned.push(p) });
pruneWaitFocus("rp");
assert.equal(parkedWaitFocusCount(), 0);
assert.equal(pruned.length, 0);
assert.equal(requestTabReveal([1]), false);

// cap: entries beyond maxParkedWaitFocus are rejected with retryAfterMs
for (let i = 0; i < maxParkedWaitFocus; i += 1) {
  assert.equal(parkWaitFocus({ requestId: `cap-${i}`, respond: () => {} }).accepted, true);
}
const overCap = parkWaitFocus({ requestId: "over", respond: () => {} });
assert.equal(overCap.accepted, false);
assert.equal(typeof overCap.retryAfterMs, "number");
assert.equal(parkedWaitFocusCount(), maxParkedWaitFocus);
requestTabReveal([1]); // drain

// keepalive: parked entry is answered { command: null } after waitFocusKeepaliveMs
assert.equal(waitFocusKeepaliveMs, 60_000);
const keepalive: VsCodeFocusPayload[] = [];
parkWaitFocus({ requestId: "ka", respond: (p) => keepalive.push(p), keepaliveMs: 20 });
await new Promise((resolve) => setTimeout(resolve, 60));
assert.deepEqual(keepalive, [{ command: null }]);
assert.equal(parkedWaitFocusCount(), 0);

console.error("vscode-tab-focus tests passed.");
