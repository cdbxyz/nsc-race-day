/* sync.js — behaviour under a network that keeps letting us down.
 *
 * Timers are injected so backoff is asserted instantly rather than waited out,
 * and the clock is never a source of flakiness.
 */

import "fake-indexeddb/auto";
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import * as db from "../js/db.js";
import { createSync } from "../js/sync.js";

beforeEach(() => db.clearAll());
after(() => db.closeDB());

/** A backend whose behaviour each test dictates. */
function testBackend() {
  const rows = new Map();
  const calls = [];
  return {
    name: "test",
    rows,
    calls,
    mode: "ok", // ok | fail | lost-response
    async push(batch) {
      calls.push(batch.map((e) => e.id));
      if (this.mode === "fail") throw new Error("no signal");
      // "lost-response": the write lands but the reply never gets back to us,
      // so sync will send the same batch again. This is the case idempotency
      // has to survive.
      for (const entry of batch) rows.set(`${entry.table}:${entry.id}`, entry.row);
      if (this.mode === "lost-response") throw new Error("connection reset");
    },
  };
}

/** Collects scheduled retries instead of running them. */
function testTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeout: (fn, ms) => scheduled.push({ fn, ms }),
    clearTimeout: () => {},
    delays: () => scheduled.map((t) => t.ms),
  };
}

function makeSync(backend, extra = {}) {
  const timers = testTimers();
  const sync = createSync({
    backend,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    isOnline: () => true,
    jitter: () => 1, // deterministic: assert the un-jittered curve
    ...extra,
  });
  return { sync, timers };
}

function event() {
  return { id: db.newId(), race_id: "r1", type: "lap_recorded", occurred_at: Date.now() };
}

test("a successful flush drains the outbox and reports synced", async () => {
  const backend = testBackend();
  const { sync } = makeSync(backend);

  await db.localWrite("race_events", event());
  await db.localWrite("race_events", event());

  await sync.flush();

  assert.equal(await db.countOutbox(), 0);
  assert.equal(backend.rows.size, 2);
  assert.equal(sync.status.state, "synced");
  assert.equal(sync.status.pending, 0);
  assert.ok(sync.status.lastSyncedAt);
});

test("a failed push keeps everything queued and schedules a retry", async () => {
  const backend = testBackend();
  backend.mode = "fail";
  const { sync, timers } = makeSync(backend);

  await db.localWrite("race_events", event());
  await sync.flush();

  assert.equal(await db.countOutbox(), 1, "nothing is discarded until confirmed");
  const [entry] = await db.peekOutbox(10);
  assert.equal(entry.attempts, 1);
  assert.equal(entry.last_error, "no signal");
  assert.equal(sync.status.state, "waiting");
  assert.equal(sync.status.pending, 1);
  assert.deepEqual(timers.delays(), [1000]);
});

test("backoff doubles and then clamps", async () => {
  const backend = testBackend();
  backend.mode = "fail";
  const { sync, timers } = makeSync(backend);

  await db.localWrite("race_events", event());
  for (let i = 0; i < 8; i += 1) await sync.flush();

  assert.deepEqual(timers.delays(), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(sync.stats().consecutiveFailures, 8);
});

test("backoff resets once a push gets through", async () => {
  const backend = testBackend();
  backend.mode = "fail";
  const { sync } = makeSync(backend);

  await db.localWrite("race_events", event());
  await sync.flush();
  await sync.flush();
  assert.equal(sync.stats().consecutiveFailures, 2);

  backend.mode = "ok";
  await sync.flush();

  assert.equal(sync.stats().consecutiveFailures, 0);
  assert.equal(sync.status.lastError, null);
  assert.equal(sync.status.state, "synced");
});

test("retrying a push whose response was lost is idempotent", async () => {
  const backend = testBackend();
  backend.mode = "lost-response";
  const { sync } = makeSync(backend);

  const a = event();
  const b = event();
  await db.localWrite("race_events", a);
  await db.localWrite("race_events", b);

  await sync.flush(); // lands on the "server", reply lost
  assert.equal(await db.countOutbox(), 2, "still queued — we never saw a confirmation");
  assert.equal(backend.rows.size, 2);

  backend.mode = "ok";
  await sync.flush(); // sends the identical batch again

  assert.equal(backend.calls.length, 2);
  assert.deepEqual(backend.calls[0], backend.calls[1], "the same UUIDs were re-sent");
  assert.equal(backend.rows.size, 2, "upsert on UUID: replaying created no duplicates");
  assert.equal(await db.countOutbox(), 0);
});

test("a stuck batch blocks the ones behind it, preserving order", async () => {
  // A race must not reach Supabase before the race_day it belongs to.
  const backend = testBackend();
  backend.mode = "fail";
  const { sync } = makeSync(backend, { batchSize: 1 });

  const first = event();
  const second = event();
  await db.localWrite("race_events", first);
  await db.localWrite("race_events", second);

  await sync.flush();

  assert.equal(backend.calls.length, 1, "gave up after the first batch failed");
  assert.deepEqual(backend.calls[0], [first.id]);
  assert.equal(await db.countOutbox(), 2);
});

test("offline means no attempt at all", async () => {
  const backend = testBackend();
  const { sync, timers } = makeSync(backend, { isOnline: () => false });

  await db.localWrite("race_events", event());
  await sync.flush();

  assert.equal(backend.calls.length, 0, "no pointless request while offline");
  assert.equal(await db.countOutbox(), 1);
  assert.equal(sync.status.state, "offline");
  assert.equal(sync.status.pending, 1);
  assert.deepEqual(timers.delays(), [], "no retry scheduled; the online event will wake us");
});

test("persistent failure escalates from waiting to error", async () => {
  const backend = testBackend();
  backend.mode = "fail";
  const { sync } = makeSync(backend);

  await db.localWrite("race_events", event());
  await sync.flush();
  assert.equal(sync.status.state, "waiting", "one miss on patchy signal is normal");

  await sync.flush();
  await sync.flush();
  assert.equal(sync.status.state, "error", "three in a row means something is wrong");
});

test("subscribers see the state changes and nothing else", async () => {
  const backend = testBackend();
  const { sync } = makeSync(backend);

  const seen = [];
  sync.subscribe((s) => seen.push(`${s.state}:${s.pending}`));
  assert.deepEqual(seen, ["synced:0"], "fires immediately with current status");

  await db.localWrite("race_events", event());
  await sync.refreshStatus();
  await sync.refreshStatus(); // unchanged — must not emit again

  await sync.flush();

  assert.deepEqual(seen, ["synced:0", "waiting:1", "synced:0"]);
});

test("concurrent flushes collapse into one", async () => {
  const backend = testBackend();
  const { sync } = makeSync(backend);

  await db.localWrite("race_events", event());
  await Promise.all([sync.flush(), sync.flush(), sync.flush()]);

  assert.equal(backend.calls.length, 1);
  assert.equal(await db.countOutbox(), 0);
});
