/* sync.js — behaviour under a network that keeps letting us down.
 *
 * Timers are injected so backoff is asserted instantly rather than waited out,
 * and the clock is never a source of flakiness.
 */

import "fake-indexeddb/auto";
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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

/* ---------------------------------------------------------------------------
 * Permanently-bad rows.
 *
 * Batches go up in order, so a row the server will always refuse would stall
 * every event tapped after it — an afternoon's racing stuck behind one bad
 * timestamp. It must be set aside, never dropped.
 * ------------------------------------------------------------------------ */

function permanent(message = "malformed row") {
  const err = new Error(message);
  err.retryable = false;
  return err;
}

test("a row the server refuses outright is set aside, not retried forever", async () => {
  const backend = testBackend();
  const { sync, timers } = makeSync(backend, { batchSize: 1 });
  backend.push = async () => {
    throw permanent("date/time field value out of range");
  };

  await db.localWrite("race_events", event());
  await sync.flush();

  assert.equal(await db.countOutbox(), 0, "no longer queued for sending");
  assert.equal(await db.countBlocked(), 1, "but still on the device");
  assert.equal(sync.status.blocked, 1);
  assert.equal(sync.status.state, "error", "the OOD is told, not left guessing");
  assert.deepEqual(timers.delays(), [], "no point retrying something that cannot work");

  const [entry] = await db.allOutbox();
  assert.equal(entry.blocked, true);
  assert.match(entry.last_error, /out of range/);
});

test("events tapped after a bad row still reach the server", async () => {
  // The whole point: one malformed race_day must not strand the afternoon.
  const backend = testBackend();
  const { sync } = makeSync(backend, { batchSize: 1 });

  const bad = event();
  const good1 = event();
  const good2 = event();
  await db.localWrite("race_events", bad);
  await db.localWrite("race_events", good1);
  await db.localWrite("race_events", good2);

  const realPush = backend.push.bind(backend);
  backend.push = async (batch) => {
    if (batch.some((e) => e.id === bad.id)) throw permanent();
    return realPush(batch);
  };

  await sync.flush();

  assert.equal(await db.countBlocked(), 1);
  assert.equal(await db.countOutbox(), 0, "everything behind it drained");
  assert.equal(backend.rows.size, 2);
  assert.ok(backend.rows.has(`race_events:${good1.id}`));
  assert.ok(backend.rows.has(`race_events:${good2.id}`));
});

test("a blocked row can be put back in the queue once fixed", async () => {
  const backend = testBackend();
  const { sync } = makeSync(backend, { batchSize: 1 });
  const realPush = backend.push.bind(backend);
  let refuse = true;
  backend.push = async (batch) => {
    if (refuse) throw permanent();
    return realPush(batch);
  };

  await db.localWrite("race_events", event());
  await sync.flush();
  assert.equal(await db.countBlocked(), 1);

  refuse = false;
  await db.unblockOutbox();
  await sync.flush();

  assert.equal(await db.countBlocked(), 0);
  assert.equal(await db.countOutbox(), 0);
  assert.equal(backend.rows.size, 1, "nothing was lost while it sat blocked");
});

test("an ordinary network failure is still retried, not set aside", async () => {
  const backend = testBackend();
  backend.mode = "fail"; // plain Error, no retryable flag
  const { sync, timers } = makeSync(backend);

  await db.localWrite("race_events", event());
  await sync.flush();

  assert.equal(await db.countBlocked(), 0, "patchy signal is not a bad row");
  assert.equal(await db.countOutbox(), 1);
  assert.deepEqual(timers.delays(), [1000]);
});

/* ---------------------------------------------------------------------------
 * Evidence of contact.
 *
 * An empty outbox proves nothing on its own — it looks exactly the same on a
 * phone that has never once reached the server. The pill needs a timestamp,
 * and that timestamp has to survive a reload.
 * ------------------------------------------------------------------------ */

test("a phone that has never reached the server has no contact stamp", async () => {
  const { sync } = makeSync(testBackend());
  await sync.refreshStatus();

  assert.equal(sync.status.state, "synced", "an empty outbox is still 'synced'");
  assert.equal(sync.status.lastSyncedAt, null, "but there is nothing to show for it");
});

test("a successful flush records when the server answered", async () => {
  const before = Date.now();
  const { sync } = makeSync(testBackend());

  await db.localWrite("race_events", event());
  await sync.flush();

  const stamp = await db.lastServerContact();
  assert.ok(stamp >= before, "stamped");
  assert.equal(sync.status.lastSyncedAt, stamp, "and reported");
});

test("the contact stamp survives a reload", async () => {
  const { sync } = makeSync(testBackend());
  await db.localWrite("race_events", event());
  await sync.flush();
  const stamp = sync.status.lastSyncedAt;

  // A new sync instance is what a page reload amounts to: fresh memory,
  // same IndexedDB.
  const { sync: reloaded } = makeSync(testBackend());
  await reloaded.refreshStatus();

  assert.equal(reloaded.status.lastSyncedAt, stamp);
});

test("a failed flush does not claim contact", async () => {
  const backend = testBackend();
  backend.mode = "fail";
  const { sync } = makeSync(backend);

  await db.localWrite("race_events", event());
  await sync.flush();

  assert.equal(await db.lastServerContact(), null);
  assert.equal(sync.status.lastSyncedAt, null);
});

test("a reference-data pull counts as contact even with an empty outbox", async () => {
  // This is the case that prompted all of it: sign in, nothing queued, and the
  // pill still needs something truthful to show.
  const { sync } = makeSync(testBackend());
  const at = Date.now();
  await db.recordServerContact(at);

  await sync.refreshStatus();

  assert.equal(sync.status.pending, 0);
  assert.equal(sync.status.state, "synced");
  assert.equal(sync.status.lastSyncedAt, at);
});

/* ---- flush must actually wait ------------------------------------------
 *
 * The bug behind "2 records are still only on this phone" at the end of every
 * race day. Every localWrite triggers a flush, so a caller that writes rows
 * and then flushes is ALWAYS the re-entrant one — and flush() used to return
 * `status` the instant it saw another in flight. `await sync.flush()` awaited
 * nothing, the count that followed was taken with the rows still queued, and
 * the last push before the phone goes away for a week was skipped.
 */

test("a concurrent flush is awaited, not skipped", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const pushed = [];
  const backend = {
    name: "supabase",
    push: async (batch) => {
      await gate;
      pushed.push(...batch.map((e) => e.id));
    },
  };
  const sync = createSync({ backend, setTimeout: () => 0, clearTimeout: () => {} });

  await db.localWrite("classes", { id: "c1", name: "Solo", base_py: 1142 });

  const first = sync.flush();          // starts, blocks on the gate
  const second = sync.flush();         // must join the first, not return early
  assert.equal(second, first, "the same promise, so awaiting it waits");

  release();
  await second;
  assert.deepEqual(pushed, ["c1"], "and the work is genuinely done");
  assert.equal(await db.countOutbox(), 0);
});

test("settle drains rows written while a flush was already running", async () => {
  /* Exactly the closeDay shape: write, write, then ask for an honest count. */
  let release;
  const gate = new Promise((r) => { release = r; });
  let firstBatch = true;
  const backend = {
    name: "supabase",
    push: async () => {
      if (firstBatch) { firstBatch = false; await gate; }
    },
  };
  const sync = createSync({ backend, setTimeout: () => 0, clearTimeout: () => {} });

  await db.localWrite("classes", { id: "c1", name: "Solo", base_py: 1142 });
  const running = sync.flush();

  // Written while that flush is in flight — the rows closeDay adds.
  await db.localWrite("helms", { id: "h1", name: "Hamish Fowler" });
  await db.localWrite("race_days", { id: "d1", date: "2026-08-21", status: "complete" });

  release();
  await running;

  const status = await sync.settle();
  assert.equal(await db.countOutbox(), 0, "nothing left behind");
  assert.equal(status.pending, 0, "and the count the OOD is shown says so");
});

test("closing the day does not report rows it has just pushed", async () => {
  const backend = { name: "supabase", push: async () => {} };
  const sync = createSync({ backend, setTimeout: () => 0, clearTimeout: () => {} });

  // What closeDay does: two writes, then settle, then read the count.
  await db.localWrite("checklist_runs", { id: "r1", race_day_id: "d1", completed_at: "x" });
  await db.localWrite("race_days", { id: "d1", date: "2026-08-21", status: "complete" });

  const status = await sync.settle();
  const outstanding = status.pending + (status.blocked || 0);
  assert.equal(outstanding, 0, "the closing screen must not invent stranded records");
});

test("settle still tells the truth when the rows really are stranded", async () => {
  /* The warning has to keep working — this fixes a false positive, not the
     message. */
  const backend = {
    name: "supabase",
    push: async () => { throw new Error("network unavailable"); },
  };
  const sync = createSync({ backend, setTimeout: () => 0, clearTimeout: () => {} });

  await db.localWrite("checklist_runs", { id: "r1", race_day_id: "d1", completed_at: "x" });
  await db.localWrite("race_days", { id: "d1", date: "2026-08-21", status: "complete" });

  const status = await sync.settle();
  assert.equal(status.pending, 2, "two rows genuinely waiting, and it says two");
});

test("settle gives up rather than spinning when retrying is pointless", async () => {
  let calls = 0;
  const backend = {
    name: "supabase",
    push: async () => { calls += 1; throw new Error("network unavailable"); },
  };
  const sync = createSync({ backend, setTimeout: () => 0, clearTimeout: () => {} });
  await db.localWrite("classes", { id: "c1", name: "Solo", base_py: 1142 });

  await sync.settle();
  assert.ok(calls <= 2, `a failing push must not be hammered, saw ${calls}`);
});

test("the closing screen settles rather than flushing once", async () => {
  const src = await readFile(new URL("../js/pages/standdown.js", import.meta.url), "utf8");
  const close = src.slice(src.indexOf("async function closeDay"));
  assert.match(close.slice(0, 900), /await sync\.settle\(\)/);
  assert.ok(!/await sync\.flush\(\)/.test(close.slice(0, 900)), "one flush is not enough here");
});
