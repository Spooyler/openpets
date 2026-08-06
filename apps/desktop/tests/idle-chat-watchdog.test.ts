/**
 * Unit tests for the idle-chat watchdog state machine:
 *   (1) Warns exactly once when a session crosses the warn threshold.
 *   (2) Does not warn before the threshold.
 *   (3) Fresh activity resets the stretch — warns again after a new idle span.
 *   (4) Auto-compact fires once at AUTO_COMPACT_MINUTES when enabled+supported.
 *   (5) Auto-compact never fires when disabled, unsupported, or without clientPid.
 *   (6) Statusline busy pings count as activity (long tool runs stay un-warned).
 *   (7) Lease death prunes state; a re-acquired lease id starts a fresh stretch.
 *   (8) Compact is attempted once per stretch even when the injection fails.
 */
import assert from "node:assert/strict";

import { AUTO_COMPACT_MINUTES, createIdleChatWatchdog, type IdleChatSession, type IdleChatSettings } from "../src/idle-chat-watchdog.js";

const MIN = 60_000;

function makeHarness(overrides?: Partial<IdleChatSettings> & { autoCompactSupported?: boolean; compactResult?: boolean }) {
  let currentTime = 1_000_000;
  let sessions: IdleChatSession[] = [];
  const warns: Array<{ leaseId: string; idleMinutes: number }> = [];
  const compacts: string[] = [];
  const settings: IdleChatSettings = {
    warnEnabled: overrides?.warnEnabled ?? true,
    warnMinutes: overrides?.warnMinutes ?? 50,
    autoCompactEnabled: overrides?.autoCompactEnabled ?? true,
  };
  const watchdog = createIdleChatWatchdog({
    listSessions: () => sessions,
    getSettings: () => settings,
    warn: (session, idleMinutes) => warns.push({ leaseId: session.leaseId, idleMinutes }),
    compact: (session) => {
      compacts.push(session.leaseId);
      return Promise.resolve(overrides?.compactResult ?? true);
    },
    now: () => currentTime,
    autoCompactSupported: overrides?.autoCompactSupported ?? true,
  });
  return {
    watchdog,
    warns,
    compacts,
    setSessions(next: IdleChatSession[]) { sessions = next; },
    advance(ms: number) { currentTime += ms; },
    now: () => currentTime,
  };
}

// Test (1) + (2): warns exactly once at the threshold, not before.
{
  const h = makeHarness();
  h.setSessions([{ leaseId: "a", acquiredAt: h.now(), clientPid: 42 }]);
  h.watchdog.tick();
  h.advance(49 * MIN);
  h.watchdog.tick();
  assert.equal(h.warns.length, 0, "(2) no warn before the threshold");
  h.advance(1 * MIN);
  h.watchdog.tick();
  h.watchdog.tick();
  assert.deepEqual(h.warns, [{ leaseId: "a", idleMinutes: 50 }], "(1) warns exactly once at 50 min");
}

// Test (3): activity resets the stretch and re-arms the warning.
{
  const h = makeHarness();
  const acquiredAt = h.now();
  h.setSessions([{ leaseId: "a", acquiredAt, clientPid: 42 }]);
  h.advance(50 * MIN);
  h.watchdog.tick();
  assert.equal(h.warns.length, 1, "first stretch warned");
  // Hook activity lands: lastActivityAt moves forward.
  h.setSessions([{ leaseId: "a", acquiredAt, lastActivityAt: h.now(), clientPid: 42 }]);
  h.advance(10 * MIN);
  h.watchdog.tick();
  assert.equal(h.warns.length, 1, "(3) no warn 10 min into the new stretch");
  h.advance(40 * MIN);
  h.watchdog.tick();
  assert.equal(h.warns.length, 2, "(3) warns again after a full new idle span");
}

// Test (4): auto-compact fires once at AUTO_COMPACT_MINUTES.
{
  const h = makeHarness();
  h.setSessions([{ leaseId: "a", acquiredAt: h.now(), clientPid: 42 }]);
  h.advance((AUTO_COMPACT_MINUTES - 1) * MIN);
  h.watchdog.tick();
  assert.equal(h.compacts.length, 0, "(4) no compact before 59 min");
  h.advance(1 * MIN);
  h.watchdog.tick();
  h.watchdog.tick();
  assert.deepEqual(h.compacts, ["a"], "(4) compacts exactly once at 59 min");
  assert.equal(h.warns.length, 1, "(4) warning also fired along the way");
}

// Test (5a): disabled auto-compact never fires.
{
  const h = makeHarness({ autoCompactEnabled: false });
  h.setSessions([{ leaseId: "a", acquiredAt: h.now(), clientPid: 42 }]);
  h.advance(120 * MIN);
  h.watchdog.tick();
  assert.equal(h.compacts.length, 0, "(5a) disabled — no compact");
  assert.equal(h.warns.length, 1, "(5a) warning still fires");
}

// Test (5b): unsupported platform never compacts.
{
  const h = makeHarness({ autoCompactSupported: false });
  h.setSessions([{ leaseId: "a", acquiredAt: h.now(), clientPid: 42 }]);
  h.advance(120 * MIN);
  h.watchdog.tick();
  assert.equal(h.compacts.length, 0, "(5b) unsupported platform — no compact");
}

// Test (5c): a session without clientPid never compacts.
{
  const h = makeHarness();
  h.setSessions([{ leaseId: "a", acquiredAt: h.now() }]);
  h.advance(120 * MIN);
  h.watchdog.tick();
  assert.equal(h.compacts.length, 0, "(5c) no clientPid — no compact");
}

// Test (6): busy pings defer idleness.
{
  const h = makeHarness();
  const acquiredAt = h.now();
  h.setSessions([{ leaseId: "a", acquiredAt, clientPid: 42 }]);
  h.advance(45 * MIN);
  h.watchdog.tick();
  h.watchdog.noteBusyPing("a");
  h.advance(45 * MIN);
  h.watchdog.tick();
  assert.equal(h.warns.length, 0, "(6) 90 min after acquire but only 45 since the ping — no warn");
  h.advance(5 * MIN);
  h.watchdog.tick();
  assert.equal(h.warns.length, 1, "(6) warned relative to the ping, not acquire");
  assert.equal(h.warns[0]?.idleMinutes, 50, "(6) idle minutes measured from the busy ping");
  assert.equal(h.compacts.length, 0, "(6) 50 min since ping — below compact threshold");
}

// Test (7): lease death prunes state; same id re-acquired starts fresh.
{
  const h = makeHarness();
  const acquiredAt = h.now();
  h.setSessions([{ leaseId: "a", acquiredAt, clientPid: 42 }]);
  h.advance(50 * MIN);
  h.watchdog.tick();
  assert.equal(h.warns.length, 1);
  h.setSessions([]);
  h.watchdog.tick();
  // Re-acquired later (fresh acquiredAt) — must not inherit the old stretch.
  h.setSessions([{ leaseId: "a", acquiredAt: h.now(), clientPid: 42 }]);
  h.advance(10 * MIN);
  h.watchdog.tick();
  assert.equal(h.warns.length, 1, "(7) fresh lease with same id does not re-warn early");
}

// Test (8): one compact attempt per stretch even when injection fails.
{
  const h = makeHarness({ compactResult: false });
  h.setSessions([{ leaseId: "a", acquiredAt: h.now(), clientPid: 42 }]);
  h.advance(60 * MIN);
  h.watchdog.tick();
  h.advance(5 * MIN);
  h.watchdog.tick();
  assert.deepEqual(h.compacts, ["a"], "(8) failed injection is not retried within the stretch");
}

console.log("idle-chat-watchdog tests passed.");
