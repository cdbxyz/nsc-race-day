/* db.js — the atomicity guarantee.
 *
 * If localWrite() resolves, the tap is on disk AND queued for sync. If it
 * rejects, neither happened. Anything in between would mean a race record that
 * exists on the phone but can never reach Supabase, or vice versa.
 */

import "fake-indexeddb/auto";
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import * as db from "../js/db.js";

beforeEach(() => db.clearAll());
after(() => db.closeDB());

function raceEvent(type = "lap_recorded") {
  return {
    id: db.newId(),
    race_id: "race-1",
    entry_id: "entry-1",
    type,
    payload: null,
    occurred_at: Date.now(),
  };
}

test("localWrite stores the row and exactly one outbox entry", async () => {
  const event = raceEvent();
  await db.localWrite("race_events", event);

  assert.deepEqual(await db.get("race_events", event.id), event);

  const outbox = await db.peekOutbox(10);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].table, "race_events");
  assert.equal(outbox[0].id, event.id, "outbox is keyed on the row's UUID so retries upsert");
  assert.equal(outbox[0].op, "upsert");
  assert.equal(outbox[0].attempts, 0);
  assert.deepEqual(outbox[0].row, event);
});

test("a transaction that fails to commit leaves neither half behind", async () => {
  const event = raceEvent();

  // Both writes are issued, then the transaction dies before committing —
  // the shape of a quota error or a browser being killed mid-write.
  db._hooks.beforeCommit = (tx) => tx.abort();
  try {
    await assert.rejects(() => db.localWrite("race_events", event));
  } finally {
    db._hooks.beforeCommit = null;
  }

  assert.equal(await db.get("race_events", event.id), undefined, "no orphan row");
  assert.equal(await db.countOutbox(), 0, "no orphan outbox entry");
});

test("a failed write does not disturb writes that already committed", async () => {
  const good = raceEvent("boat_finished");
  await db.localWrite("race_events", good);

  db._hooks.beforeCommit = (tx) => tx.abort();
  try {
    await assert.rejects(() => db.localWrite("race_events", raceEvent()));
  } finally {
    db._hooks.beforeCommit = null;
  }

  assert.deepEqual(await db.get("race_events", good.id), good);
  assert.equal(await db.countOutbox(), 1);
});

test("outbox seq is monotonic, so sync drains in tap order", async () => {
  const events = [raceEvent(), raceEvent(), raceEvent(), raceEvent()];
  for (const e of events) await db.localWrite("race_events", e);

  const outbox = await db.peekOutbox(10);
  const seqs = outbox.map((e) => e.seq);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, "returned in seq order");
  assert.deepEqual(
    outbox.map((e) => e.id),
    events.map((e) => e.id),
    "queued in the order they were tapped"
  );
});

test("peekOutbox respects its limit", async () => {
  for (let i = 0; i < 5; i += 1) await db.localWrite("race_events", raceEvent());
  assert.equal((await db.peekOutbox(2)).length, 2);
  assert.equal(await db.countOutbox(), 5);
});

test("clearOutbox removes only what the backend confirmed", async () => {
  for (let i = 0; i < 3; i += 1) await db.localWrite("race_events", raceEvent());
  const outbox = await db.peekOutbox(10);

  await db.clearOutbox([outbox[0].seq, outbox[1].seq]);

  const left = await db.peekOutbox(10);
  assert.equal(left.length, 1);
  assert.equal(left[0].seq, outbox[2].seq);
});

test("markOutboxAttempt records why a push failed", async () => {
  await db.localWrite("race_events", raceEvent());
  const [entry] = await db.peekOutbox(10);

  await db.markOutboxAttempt([entry.seq], new Error("no signal"));
  await db.markOutboxAttempt([entry.seq], new Error("no signal"));

  const [updated] = await db.peekOutbox(10);
  assert.equal(updated.attempts, 2);
  assert.equal(updated.last_error, "no signal");
});

test("bulkPut writes reference data without queueing it for sync", async () => {
  // Boats pulled DOWN from Supabase must not be pushed straight back up.
  await db.bulkPut("boats", [
    { id: db.newId(), name: "Vaila", class_id: "c1", active: true },
    { id: db.newId(), name: "Kestrel", class_id: "c1", active: true },
  ]);

  assert.equal((await db.getAll("boats")).length, 2);
  assert.equal(await db.countOutbox(), 0);
});

test("indexes support the lookups resume and sign-on need", async () => {
  const dayId = db.newId();
  await db.localWrite("race_days", {
    id: dayId,
    date: "2026-08-15",
    ood_name: "Chris",
    status: "open",
    created_at: Date.now(),
  });
  await db.localWrite("race_days", {
    id: db.newId(),
    date: "2026-08-01",
    ood_name: "Hamish",
    status: "complete",
    created_at: Date.now(),
  });
  await db.localWrite("races", { id: db.newId(), race_day_id: dayId, number: 1, status: "racing" });

  const open = await db.getAllByIndex("race_days", "by_status", "open");
  assert.equal(open.length, 1);
  assert.equal(open[0].id, dayId);

  const races = await db.getAllByIndex("races", "by_race_day", dayId);
  assert.equal(races.length, 1);
});

test("localWrite refuses a row without a client-generated id", async () => {
  await assert.rejects(() => db.localWrite("race_events", { type: "lap_recorded" }), /id/);
  assert.equal(await db.countOutbox(), 0);
});

test("localWrite refuses an unknown table", async () => {
  await assert.rejects(() => db.localWrite("nonsense", { id: db.newId() }), /unknown table/);
});

/* ---------------------------------------------------------------------------
 * Deleting rows that are records of intent rather than records of fact.
 * ------------------------------------------------------------------------ */

test("localDelete removes the row and queues the removal together", async () => {
  const entry = { id: db.newId(), race_id: "r1", boat_id: "b1", helm_id: "h1",
                  base_py: 1122, handicap_factor: 1, personal_py: 1122, fleet: "fast" };
  await db.localWrite("entries", entry);
  await db.clearOutbox((await db.peekOutbox(10)).map((e) => e.seq));

  await db.localDelete("entries", entry.id);

  assert.equal(await db.get("entries", entry.id), undefined, "gone locally");
  const [queued] = await db.peekOutbox(10);
  assert.equal(queued.op, "delete");
  assert.equal(queued.table, "entries");
  assert.equal(queued.id, entry.id);
});

test("race events cannot be deleted", async () => {
  // The append-only rule is a safety property, not a style preference: a race
  // record is evidence. Mistakes are corrected by appending an undo.
  const event = raceEvent();
  await db.localWrite("race_events", event);

  await assert.rejects(() => db.localDelete("race_events", event.id), /append-only/);
  assert.deepEqual(await db.get("race_events", event.id), event, "still there");
});

test("localDelete refuses an unknown table", async () => {
  await assert.rejects(() => db.localDelete("nonsense", "x"), /unknown table/);
});
