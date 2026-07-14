import assert from "node:assert/strict";
import { NotificationStore, sessionLabelFromCwd } from "../src/notification-store.js";

assert.equal(sessionLabelFromCwd("C:\\Users\\me\\fraud_project", "Terminal"), "fraud_project");
assert.equal(sessionLabelFromCwd("/home/me/api-fix/", "Terminal"), "api-fix");
assert.equal(sessionLabelFromCwd(undefined, "Ghostty"), "Ghostty");

let now = 1_000;
const store = new NotificationStore({ now: () => now });

// One live row per session; re-record replaces content.
store.record({ sessionKey: "s1", windowKey: "w:1", kind: "waiting", message: "needs permission", label: "fraud_project" });
now = 2_000;
store.record({ sessionKey: "s2", windowKey: "w:2", kind: "success", message: "turn done", label: "api-fix" });
assert.equal(store.rows().length, 2);
assert.equal(store.unresolvedCount(), 2);
assert.equal(store.oldestUnresolved()?.sessionKey, "s1", "oldest unresolved is s1");

// Resolution by window focus.
assert.equal(store.resolveWindow("w:1"), true);
assert.equal(store.unresolvedCount(), 1);
assert.equal(store.oldestUnresolved()?.sessionKey, "s2");

// Fresh activity re-marks unresolved and resets firstUnresolvedAt.
now = 3_000;
store.record({ sessionKey: "s1", windowKey: "w:1", kind: "working", message: "refactoring", label: "fraud_project" });
assert.equal(store.unresolvedCount(), 2);
assert.equal(store.oldestUnresolved()?.sessionKey, "s2", "s1 unresolved-age reset — s2 now oldest");

// rows(): unresolved oldest-first, then resolved by recency.
store.resolveSession("s2");
assert.deepEqual(store.rows().map((r) => r.state), ["unresolved", "resolved"]);

// Dismiss removes from badge but a new event revives the row.
assert.equal(store.dismissSession("s1"), true);
assert.equal(store.unresolvedCount(), 0);
store.record({ sessionKey: "s1", windowKey: "w:1", kind: "error", message: "tests failed", label: "fraud_project" });
assert.equal(store.unresolvedCount(), 1);

// Policy: "off" writes nothing; "fade" auto-resolves after fadeMs.
let fadeNow = 0;
const fading = new NotificationStore({ now: () => fadeNow, policy: (kind) => (kind === "working" ? "fade" : kind === "idle" ? "off" : "persistent"), fadeMs: 10_000 });
fading.record({ sessionKey: "a", kind: "idle", message: "x", label: "l" });
assert.equal(fading.rows().length, 0, "off kind writes no row");
fading.record({ sessionKey: "a", kind: "working", message: "x", label: "l" });
assert.equal(fading.unresolvedCount(), 1);
fadeNow = 10_001;
assert.equal(fading.unresolvedCount(), 0, "fade kind auto-resolved after fadeMs");
assert.equal(fading.rows()[0]?.state, "resolved");

// removeSession + adoptEntries (close-pet fallback migration).
const moved = store.removeSession("s1");
assert.equal(moved?.sessionKey, "s1");
const target = new NotificationStore({ now: () => now });
target.adoptEntries(moved ? [moved] : []);
assert.equal(target.unresolvedCount(), 1);

console.log("Notification store passed.");
