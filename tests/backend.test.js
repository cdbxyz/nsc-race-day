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
    entry("boats", "b1"),
    entry("classes", "c1"),
  ]);

  assert.deepEqual(
    calls.map((c) => c.table),
    ["classes", "boats", "race_days", "races", "entries", "race_events"]
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
