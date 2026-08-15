/* Sign-on is the day's tally record.
 *
 * The stand-down check at the end of the day reads this list to work out
 * whether every boat that went out has come back. So an entry may be removed
 * while the race is still on paper, and never once it exists on the water — a
 * boat that was really there must stay visible, with a code explaining what
 * happened to it.
 */

import "fake-indexeddb/auto";
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import * as db from "../js/db.js";
import { canRemoveEntries, removeEntry, EDITABLE_STATUSES } from "../js/raceday.js";

beforeEach(() => db.clearAll());
after(() => db.closeDB());

const RACE_DAY = "55555555-0000-0000-0000-000000000001";

async function setup(status) {
  const raceId = db.newId();
  const entryId = db.newId();
  await db.localWrite("race_days", {
    id: RACE_DAY, date: "2026-08-15", ood_name: "Chris", status: "open", created_at: db.nowIso(),
  });
  await db.localWrite("races", {
    id: raceId, race_day_id: RACE_DAY, number: 1, status, fast_laps: 3, slow_laps: 2,
  });
  await db.localWrite("entries", {
    id: entryId, race_id: raceId, boat_id: "b1", helm_id: "h1",
    base_py: 1122, handicap_factor: 1, personal_py: 1122, fleet: "fast", laps_override: null,
  });
  return { raceId, entryId, race: await db.get("races", raceId) };
}

/* ---- the boundary ---- */

test("entries can be removed while the race is still on paper", () => {
  for (const status of ["setup", "prestart"]) {
    assert.equal(canRemoveEntries({ status }), true, status);
  }
});

test("entries cannot be removed once the race exists on the water", () => {
  // From the sequence onwards a boat has been out there, and the tally has to
  // show it whatever happened next.
  for (const status of ["sequence", "racing", "finished", "published", "abandoned"]) {
    assert.equal(canRemoveEntries({ status }), false, status);
  }
});

test("the editable set is exactly the two pre-water statuses", () => {
  assert.deepEqual([...EDITABLE_STATUSES].sort(), ["prestart", "setup"]);
});

test("no race at all is not removable", () => {
  assert.equal(canRemoveEntries(null), false);
  assert.equal(canRemoveEntries(undefined), false);
});

/* ---- the guard actually holds ---- */

test("removing during setup deletes the entry and queues the delete", async () => {
  const { entryId } = await setup("setup");
  await db.clearOutbox((await db.peekOutbox(50)).map((e) => e.seq));

  await removeEntry(entryId);

  assert.equal(await db.get("entries", entryId), undefined);
  const [queued] = await db.peekOutbox(10);
  assert.equal(queued.op, "delete");
  assert.equal(queued.table, "entries");
});

test("removing once the sequence has started is refused, and nothing is lost", async () => {
  const { entryId } = await setup("sequence");
  await db.clearOutbox((await db.peekOutbox(50)).map((e) => e.seq));

  await assert.rejects(() => removeEntry(entryId), /already started/);

  assert.ok(await db.get("entries", entryId), "the boat is still on the tally");
  assert.equal(await db.countOutbox(), 0, "and nothing was queued");
});

test("the refusal tells the OOD what to do instead", async () => {
  const { entryId } = await setup("racing");
  await assert.rejects(() => removeEntry(entryId), /DNS, DNC or RET/);
});

test("the race is looked up when it is not passed in", async () => {
  // The page passes the race it already has; anything else must still be safe.
  const { entryId } = await setup("racing");
  await assert.rejects(() => removeEntry(entryId), /already started/);
});

test("a passed-in race is honoured", async () => {
  const { entryId, race } = await setup("prestart");
  await removeEntry(entryId, race);
  assert.equal(await db.get("entries", entryId), undefined);
});

test("an entry that has already gone does not throw a confusing error", async () => {
  await assert.rejects(() => removeEntry(db.newId()), /already started/);
});
