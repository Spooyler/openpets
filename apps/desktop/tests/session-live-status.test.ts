/**
 * Unit tests for SessionLiveStatusTracker:
 *   (1) Unknown sessions read idle.
 *   (2) Each reaction maps to its matching status.
 *   (3) Status decays to idle after 30s of no new reaction.
 *   (4) A new update resets the decay timer.
 *   (5) An unmapped reaction (e.g. "success") clears the entry back to idle.
 *   (6) remove() clears a session immediately.
 *   (7) all() returns only active (non-decayed) statuses.
 *   (8) Herdr-driven status persists past the decay window — herdr only
 *       pushes transitions, so the dot holds until the next one.
 */
import assert from "node:assert/strict";
import { herdrStatusActions } from "../src/herdr-state.js";
import { SessionLiveStatusTracker } from "../src/session-live-status.js";

let now = 1_000_000;
const tracker = new SessionLiveStatusTracker({ now: () => now, decayMs: 30_000 });

// (1) Unknown session is idle.
assert.equal(tracker.get("a"), "idle", "(1) unknown session is idle");

// (2) Each reaction maps correctly.
for (const reaction of ["thinking", "editing", "running", "testing", "waiting"] as const) {
  tracker.update("a", reaction);
  assert.equal(tracker.get("a"), reaction, `(2) ${reaction} reaction maps to itself`);
}

// (3) Decays to idle after 30s.
tracker.update("a", "editing");
now += 30_001;
assert.equal(tracker.get("a"), "idle", "(3) decays to idle after 30s");

// (4) A new update resets the decay timer.
tracker.update("a", "running");
now += 20_000;
assert.equal(tracker.get("a"), "running", "(4a) still active before decay window elapses");
now += 20_000;
assert.equal(tracker.get("a"), "idle", "(4b) decays 30s after the reset update, not the original one");

// (5) Unmapped reaction (e.g. "success") clears the entry.
tracker.update("b", "thinking");
assert.equal(tracker.get("b"), "thinking", "(5a) mapped reaction is active");
tracker.update("b", "success");
assert.equal(tracker.get("b"), "idle", "(5b) success reaction clears to idle");

// (6) remove() clears a session immediately.
tracker.update("c", "waiting");
assert.equal(tracker.get("c"), "waiting", "(6a) active before removal");
tracker.remove("c");
assert.equal(tracker.get("c"), "idle", "(6b) idle immediately after removal");

// (7) all() returns only active statuses, excluding decayed ones.
now = 2_000_000;
tracker.remove("a");
tracker.remove("b");
tracker.remove("c");
tracker.update("x", "thinking");
tracker.update("y", "running");
now += 100;
let snapshot = tracker.all();
assert.deepEqual(
  [...snapshot.entries()].sort(),
  [
    ["x", "thinking"],
    ["y", "running"],
  ],
  "(7a) all() includes fresh entries"
);
now += 30_001;
snapshot = tracker.all();
assert.equal(snapshot.size, 0, "(7b) all() excludes decayed entries");

// (8) Herdr-driven status does not decay; the next herdr transition clears it.
for (const [herdrStatus, expected] of [["blocked", "waiting"], ["working", "running"]] as const) {
  const key = `herdr-${herdrStatus}`;
  const reaction = herdrStatusActions(herdrStatus, tracker.get(key), false).liveReaction;
  assert.ok(reaction, `(8) ${herdrStatus} yields a live reaction`);
  tracker.update(key, reaction);
  now += 120_000;
  assert.equal(tracker.get(key), expected, `(8a) herdr ${herdrStatus} still ${expected} after the decay window`);
  assert.equal(tracker.all().get(key), expected, `(8b) all() keeps herdr ${herdrStatus}`);
  tracker.update(key, herdrStatusActions("idle", tracker.get(key), false).liveReaction!);
  assert.equal(tracker.get(key), "idle", `(8c) herdr idle transition clears ${expected}`);
}

console.log("session-live-status tests passed.");
