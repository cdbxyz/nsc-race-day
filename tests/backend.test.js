/* The Supabase push path.
 *
 * sync.js guarantees batches arrive in tap order; this module has to turn that
 * into an order Postgres will accept, because a race cannot be inserted before
 * the race day it belongs to.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createSupabaseBackend } from "../js/backend.js";

function recorder({ signedIn = true } = {}) {
  const calls = [];
  const backend = createSupabaseBackend({
    isSignedIn: () => signedIn,
    upsert: async (table, rows) => {
      calls.push({ table, rows });
    },
  });
  return { backend, calls };
}

const entry = (table, id, row = {}) => ({ table, id, row: { id, ...row } });

test("parents are pushed before children whatever order they were tapped in", async () => {
  const { backend, calls } = recorder();

  // Deliberately backwards: the event was tapped first in the outbox, but its
  // race and race day must reach the server ahead of it.
  await backend.push([
    entry("race_events", "e1"),
    entry("entries", "en1"),
    entry("races", "r1"),
    entry("race_days", "d1"),
    entry("combinations", "cm1"),
    entry("classes", "c1"),
  ]);

  assert.deepEqual(
    calls.map((c) => c.table),
    ["classes", "combinations", "race_days", "races", "entries", "race_events"]
  );
});

test("a repeated id in one batch is sent once, keeping the last version", async () => {
  const { backend, calls } = recorder();

  await backend.push([
    entry("races", "r1", { status: "racing" }),
    entry("races", "r1", { status: "finished" }),
  ]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].rows.length, 1, "one row per id, or the upsert is ambiguous");
  assert.equal(calls[0].rows[0].status, "finished", "the later write wins");
});

test("rows for one table go up in a single request", async () => {
  const { backend, calls } = recorder();

  await backend.push([
    entry("race_events", "e1"),
    entry("race_events", "e2"),
    entry("race_events", "e3"),
  ]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].rows.length, 3);
});

test("without a session the batch is kept, not dropped", async () => {
  const { backend, calls } = recorder({ signedIn: false });

  // sync.js treats a throw as "retry later", which is exactly right here:
  // the events must survive until someone enters the PIN.
  await assert.rejects(() => backend.push([entry("race_events", "e1")]), /not signed in/);
  assert.equal(calls.length, 0);
});

test("an unknown table still gets pushed, after the known ones", async () => {
  const { backend, calls } = recorder();

  // indexOf returns -1 for anything unlisted; make sure that doesn't quietly
  // sort a future table to the front, ahead of its parents.
  await backend.push([entry("future_table", "x1"), entry("race_days", "d1")]);

  assert.deepEqual(calls.map((c) => c.table), ["race_days", "future_table"]);
});

/* ---------------------------------------------------------------------------
 * Deletes.
 *
 * A boat signed on by mistake has to come off again. Deletes reorder badly
 * against upserts — create-then-delete and delete-then-create mean opposite
 * things — so a batch containing one is replayed exactly as it was tapped.
 * ------------------------------------------------------------------------ */

function recorderWithDelete({ signedIn = true } = {}) {
  const calls = [];
  const backend = createSupabaseBackend({
    isSignedIn: () => signedIn,
    upsert: async (table, rows) => calls.push({ op: "upsert", table, ids: rows.map((r) => r.id) }),
    remove: async (table, id) => calls.push({ op: "delete", table, id }),
  });
  return { backend, calls };
}

const del = (table, id) => ({ table, id, op: "delete", row: null });

test("a delete reaches the server", async () => {
  const { backend, calls } = recorderWithDelete();
  await backend.push([del("entries", "en1")]);
  assert.deepEqual(calls, [{ op: "delete", table: "entries", id: "en1" }]);
});

test("create-then-delete in one batch stays in that order", async () => {
  const { backend, calls } = recorderWithDelete();
  await backend.push([entry("entries", "en1"), del("entries", "en1")]);

  assert.deepEqual(calls.map((c) => c.op), ["upsert", "delete"],
    "reordering these would leave the row behind on the server");
});

test("delete-then-create in one batch also stays in that order", async () => {
  const { backend, calls } = recorderWithDelete();
  await backend.push([del("entries", "en1"), entry("entries", "en1")]);

  assert.deepEqual(calls.map((c) => c.op), ["delete", "upsert"],
    "reordering these would destroy the row the OOD just re-added");
});

test("batches without deletes keep the grouped, dependency-ordered path", async () => {
  const { backend, calls } = recorderWithDelete();
  await backend.push([entry("race_events", "e1"), entry("race_days", "d1")]);

  assert.deepEqual(calls.map((c) => c.table), ["race_days", "race_events"]);
});
