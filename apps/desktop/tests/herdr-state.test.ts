import assert from "node:assert/strict";

import { createHerdrStateWatcher, herdrStatusActions, type HerdrPaneStatusEvent, type HerdrSocketHandle, type HerdrSocketHandlers, type HerdrStateWatcherDeps } from "../src/herdr-state.js";

// --- herdrStatusActions (merge policy) ---

{
  // blocked always sets the waiting dot; notifies once, never while seeding.
  assert.deepEqual(herdrStatusActions("blocked", "idle", false), { liveReaction: "waiting", notifyBlocked: true, touchActivity: false });
  assert.deepEqual(herdrStatusActions("blocked", "editing", false), { liveReaction: "waiting", notifyBlocked: true, touchActivity: false });
  assert.deepEqual(herdrStatusActions("blocked", "waiting", false), { liveReaction: "waiting", notifyBlocked: false, touchActivity: false });
  assert.deepEqual(herdrStatusActions("blocked", "idle", true), { liveReaction: "waiting", notifyBlocked: false, touchActivity: false });
  console.log("policy: blocked — PASS");
}

{
  // working fills an idle dot but never clobbers a specific hook status.
  assert.deepEqual(herdrStatusActions("working", "idle", false), { liveReaction: "running", notifyBlocked: false, touchActivity: true });
  assert.deepEqual(herdrStatusActions("working", "editing", false), { liveReaction: null, notifyBlocked: false, touchActivity: true });
  console.log("policy: working — PASS");
}

{
  // idle/done clear the dot; unknown leaves everything untouched.
  assert.deepEqual(herdrStatusActions("idle", "running", false), { liveReaction: "idle", notifyBlocked: false, touchActivity: false });
  assert.deepEqual(herdrStatusActions("done", "waiting", false), { liveReaction: "idle", notifyBlocked: false, touchActivity: false });
  assert.deepEqual(herdrStatusActions("unknown", "running", false), { liveReaction: null, notifyBlocked: false, touchActivity: false });
  console.log("policy: idle/done/unknown — PASS");
}

// --- watcher harness ---

interface FakeConnection {
  readonly socketPath: string;
  readonly handlers: HerdrSocketHandlers;
  readonly written: string[];
  destroyed: boolean;
}

interface Harness {
  readonly connections: FakeConnection[];
  readonly changes: HerdrPaneStatusEvent[];
  readonly gone: Array<{ socketPath: string; paneId: string }>;
  readonly timers: Array<{ fn: () => void; ms: number; cancelled: boolean }>;
  clock: number;
  leases: boolean;
}

function makeHarness(overrides: Partial<HerdrStateWatcherDeps> = {}): { harness: Harness; deps: HerdrStateWatcherDeps } {
  const harness: Harness = { connections: [], changes: [], gone: [], timers: [], clock: 1_000, leases: true };
  const deps: HerdrStateWatcherDeps = {
    connect: (socketPath, handlers): HerdrSocketHandle => {
      const conn: FakeConnection = { socketPath, handlers, written: [], destroyed: false };
      harness.connections.push(conn);
      return {
        write: (line) => conn.written.push(line),
        destroy: () => {
          conn.destroyed = true;
        },
      };
    },
    hasHerdrLeases: () => harness.leases,
    onStatusChange: (event) => harness.changes.push(event),
    onPaneGone: (socketPath, paneId) => harness.gone.push({ socketPath, paneId }),
    now: () => harness.clock,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      harness.timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cancelled: boolean }).cancelled = true;
    },
    seedMs: 2_000,
    reconnectMinMs: 5_000,
    reconnectMaxMs: 60_000,
    ...overrides,
  };
  return { harness, deps };
}

function paneUpdated(paneId: string, status: string, agent: string | null = "claude"): string {
  return JSON.stringify({ event: "pane_updated", data: { pane: { pane_id: paneId, agent, agent_status: status } } }) + "\n";
}

const SOCK = "C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock";

{
  // Connect subscribes to pane events; replay seeds silently, later events don't.
  const { harness, deps } = makeHarness();
  const watcher = createHerdrStateWatcher(deps);
  watcher.ensureWatching(SOCK);
  assert.equal(harness.connections.length, 1);
  const conn = harness.connections[0]!;
  conn.handlers.onConnect();
  assert.equal(conn.written.length, 1);
  const request = JSON.parse(conn.written[0]!);
  assert.equal(request.method, "events.subscribe");
  assert.deepEqual(
    request.params.subscriptions.map((s: { type: string }) => s.type),
    ["pane.updated", "pane.closed", "pane.exited"],
  );

  conn.handlers.onData(JSON.stringify({ id: "openpets-sub", result: { type: "subscription_started" } }) + "\n");
  conn.handlers.onData(paneUpdated("wC:p4", "idle"));
  conn.handlers.onData(paneUpdated("wC:p4", "working"));
  harness.clock += 5_000; // past the seed window
  conn.handlers.onData(paneUpdated("wC:p4", "blocked"));
  assert.deepEqual(
    harness.changes.map((c) => ({ paneId: c.paneId, status: c.status, seeding: c.seeding })),
    [
      { paneId: "wC:p4", status: "idle", seeding: true },
      { paneId: "wC:p4", status: "working", seeding: true },
      { paneId: "wC:p4", status: "blocked", seeding: false },
    ],
  );
  assert.equal(watcher.statusFor(SOCK, "wC:p4"), "blocked");
  console.log("watcher: subscribe + seeding window — PASS");
}

{
  // Unchanged status is not re-emitted; ensureWatching is idempotent.
  const { harness, deps } = makeHarness();
  const watcher = createHerdrStateWatcher(deps);
  watcher.ensureWatching(SOCK);
  watcher.ensureWatching(SOCK);
  assert.equal(harness.connections.length, 1);
  const conn = harness.connections[0]!;
  conn.handlers.onConnect();
  conn.handlers.onData(paneUpdated("wC:p4", "working"));
  conn.handlers.onData(paneUpdated("wC:p4", "working"));
  assert.equal(harness.changes.length, 1);
  console.log("watcher: change-only emission, idempotent watch — PASS");
}

{
  // Lines split across chunks are reassembled; garbage lines are ignored.
  const { harness, deps } = makeHarness();
  createHerdrStateWatcher(deps).ensureWatching(SOCK);
  const conn = harness.connections[0]!;
  conn.handlers.onConnect();
  const line = paneUpdated("wC:p4", "working");
  conn.handlers.onData("not json at all\n");
  conn.handlers.onData(line.slice(0, 25));
  conn.handlers.onData(line.slice(25));
  assert.equal(harness.changes.length, 1);
  assert.equal(harness.changes[0]!.status, "working");
  console.log("watcher: chunked framing + garbage tolerance — PASS");
}

{
  // Agent release (agent null) and pane close both report the pane gone.
  const { harness, deps } = makeHarness();
  createHerdrStateWatcher(deps).ensureWatching(SOCK);
  const conn = harness.connections[0]!;
  conn.handlers.onConnect();
  conn.handlers.onData(paneUpdated("wC:p1", "working"));
  conn.handlers.onData(paneUpdated("wC:p2", "working"));
  conn.handlers.onData(paneUpdated("wC:p1", "idle", null));
  conn.handlers.onData(JSON.stringify({ event: "pane_closed", data: { pane_id: "wC:p2" } }) + "\n");
  assert.deepEqual(
    harness.gone.map((g) => g.paneId),
    ["wC:p1", "wC:p2"],
  );
  // A pane never seen (plain shell) stays silent.
  conn.handlers.onData(JSON.stringify({ event: "pane_exited", data: { pane_id: "wC:p9" } }) + "\n");
  assert.equal(harness.gone.length, 2);
  console.log("watcher: agent release / pane close — PASS");
}

{
  // Close with leases → reconnect with backoff; statuses survive so only real
  // changes re-emit after the replay.
  const { harness, deps } = makeHarness();
  const watcher = createHerdrStateWatcher(deps);
  watcher.ensureWatching(SOCK);
  const first = harness.connections[0]!;
  first.handlers.onConnect();
  first.handlers.onData(JSON.stringify({ id: "openpets-sub", result: { type: "subscription_started" } }) + "\n");
  first.handlers.onData(paneUpdated("wC:p4", "working"));
  first.handlers.onClose();
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0]!.ms, 5_000);
  harness.timers[0]!.fn();
  assert.equal(harness.connections.length, 2);
  const second = harness.connections[1]!;
  second.handlers.onConnect();
  second.handlers.onData(paneUpdated("wC:p4", "working")); // unchanged — replay
  second.handlers.onData(paneUpdated("wC:p4", "blocked")); // changed while down
  assert.deepEqual(
    harness.changes.map((c) => ({ status: c.status, seeding: c.seeding })),
    [
      { status: "working", seeding: true },
      { status: "blocked", seeding: true },
    ],
  );
  console.log("watcher: reconnect keeps statuses — PASS");
}

{
  // Backoff doubles up to the max while unacked; second close waits longer.
  const { harness, deps } = makeHarness();
  createHerdrStateWatcher(deps).ensureWatching(SOCK);
  harness.connections[0]!.handlers.onConnect();
  harness.connections[0]!.handlers.onClose(); // no ack seen → delay 5s, next 10s
  harness.timers[0]!.fn();
  harness.connections[1]!.handlers.onClose();
  assert.equal(harness.timers[1]!.ms, 10_000);
  console.log("watcher: backoff growth — PASS");
}

{
  // Close without remaining leases → dropped, no reconnect.
  const { harness, deps } = makeHarness();
  const watcher = createHerdrStateWatcher(deps);
  watcher.ensureWatching(SOCK);
  harness.connections[0]!.handlers.onConnect();
  harness.leases = false;
  harness.connections[0]!.handlers.onClose();
  assert.equal(harness.timers.length, 0);
  assert.equal(watcher.statusFor(SOCK, "wC:p4"), undefined);
  // A later acquire starts fresh.
  watcher.ensureWatching(SOCK);
  assert.equal(harness.connections.length, 2);
  console.log("watcher: drop when leases gone — PASS");
}

{
  // An event arriving after the last lease left destroys the connection.
  const { harness, deps } = makeHarness();
  createHerdrStateWatcher(deps).ensureWatching(SOCK);
  const conn = harness.connections[0]!;
  conn.handlers.onConnect();
  harness.leases = false;
  conn.handlers.onData(paneUpdated("wC:p4", "working"));
  assert.equal(conn.destroyed, true);
  assert.equal(harness.changes.length, 0);
  console.log("watcher: self-stop on event without leases — PASS");
}

{
  // An error response tears the connection down (reconnect path owns retry).
  const { harness, deps } = makeHarness();
  createHerdrStateWatcher(deps).ensureWatching(SOCK);
  const conn = harness.connections[0]!;
  conn.handlers.onConnect();
  conn.handlers.onData(JSON.stringify({ id: "", error: { code: "invalid_request", message: "nope" } }) + "\n");
  assert.equal(conn.destroyed, true);
  console.log("watcher: error response destroys connection — PASS");
}

{
  // stop() destroys connections and cancels pending reconnects.
  const { harness, deps } = makeHarness();
  const watcher = createHerdrStateWatcher(deps);
  watcher.ensureWatching(SOCK);
  watcher.ensureWatching("/tmp/other/herdr.sock");
  harness.connections[0]!.handlers.onConnect();
  harness.connections[1]!.handlers.onConnect();
  harness.connections[1]!.handlers.onClose(); // pending reconnect timer
  watcher.stop();
  assert.equal(harness.connections[0]!.destroyed, true);
  assert.equal(harness.timers[0]!.cancelled, true);
  watcher.ensureWatching(SOCK);
  assert.equal(harness.connections.length, 2, "stopped watcher must not reconnect");
  console.log("watcher: stop tears everything down — PASS");
}

console.log("Herdr state validation passed.");
