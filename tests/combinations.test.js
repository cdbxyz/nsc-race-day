/* Crew, combinations and sail numbers.
 *
 * At this club the persistent identity is the pairing — helm (+ crew) in a
 * class. There are no hulls: 017 removed them, because they added a decision
 * at every sign-on and what an OOD actually needs is a number they can read
 * on the water. That number lives on the ENTRY, because a helm may borrow a
 * different boat next week.
 *
 * The rule that must not bend: handicaps follow the HELM, whoever is crewing.
 */

import "fake-indexeddb/auto";
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import * as db from "../js/db.js";
import * as reg from "../js/registers.js";
import * as rd from "../js/raceday.js";
import { entryLabel, entryDetail, entryPeople } from "../js/state.js";
import { factorFor } from "../js/handicap.js";

beforeEach(() => db.clearAll());
after(() => db.closeDB());

const HAMISH = "helm-hamish";
const LISA = "helm-lisa";
const TOM = "helm-tom";

async function setup() {
  const single = await reg.createClass({ name: "Topper", basePy: 1363, crewSize: 1 });
  const double = await reg.createClass({ name: "Laser 2000", basePy: 1122, crewSize: 2 });
  for (const [id, name] of [[HAMISH, "Hamish Fowler"], [LISA, "Lisa Brown"], [TOM, "Tom Gissane"]]) {
    await db.localWrite("helms", { id, name, created_at: db.nowIso() });
  }
  const raceDay = await db.get("race_days", "d1") ?? null;
  const { races } = await rd.createRaceDay({ date: "2026-08-16", oodName: "Chris", raceCount: 2 });
  return { single, double, races };
}

const context = { season: 2026, cachedWins: [], localWins: [], cachedAt: null };

/* ---- crew_size gating --------------------------------------------------- */

test("a class records how many people sail it", async () => {
  const { single, double } = await setup();
  assert.equal(single.crew_size, 1);
  assert.equal(double.crew_size, 2);
});

test("crew size is correctable without a migration", async () => {
  const { single } = await setup();
  const updated = await reg.updateClass(single.id, { crewSize: 2 });
  assert.equal(updated.crew_size, 2);
});

test("an unknown crew size defaults to single-handed", async () => {
  // The safe way round: a missing crew field is a visible omission, a
  // spurious one is a confusing empty box.
  const klass = await reg.createClass({ name: "Mystery", basePy: 1100 });
  assert.equal(klass.crew_size, 1);
});

test("a double-hander may still be sailed solo", async () => {
  const { double, races } = await setup();
  const entry = await rd.addEntry({
    race: races[0], klass: double, helmId: HAMISH, crewId: null, context,
  });
  assert.equal(entry.crew_id, null, "no crew is a normal Sunday, not an error");
});

test("crew and helm cannot be the same person", async () => {
  const { double, races } = await setup();
  await assert.rejects(
    () => rd.addEntry({ race: races[0], klass: double, helmId: HAMISH, crewId: HAMISH, context }),
    /cannot also be the crew/
  );
});

/* ---- entries need no hull ---------------------------------------------- */

test("an entry needs a class, not a boat", async () => {
  const { double, races } = await setup();
  const entry = await rd.addEntry({ race: races[0], klass: double, helmId: HAMISH, context });

  assert.equal(entry.class_id, double.id, "the PY comes from here");
  assert.equal(entry.sail_no, null, "and no hull had to be invented");
  assert.equal(entry.base_py, 1122);
  assert.ok(!("boat_id" in entry), "the column is gone, not merely unused");
});

test("a helm sails one boat per race", async () => {
  const { single, double, races } = await setup();
  await rd.addEntry({ race: races[0], klass: double, helmId: HAMISH, context });
  await assert.rejects(
    () => rd.addEntry({ race: races[0], klass: single, helmId: HAMISH, context }),
    /already signed on/
  );
});

test("there is no boats table left to write to", async () => {
  // The pairing-shaped-hull workaround cannot come back if the store is gone.
  assert.ok(!db.TABLES.includes("boats"));
  await assert.rejects(
    () => db.localWrite("boats", { id: "b1", name: "Hamish + Lisa" }),
    /unknown table/
  );
});

/* ---- handicaps follow the helm ----------------------------------------- */

test("HANDICAPS FOLLOW THE HELM: crew makes no difference whatsoever", async () => {
  // The rule this whole feature must not disturb. Same helm, same class,
  // different crew — and a crew who has wins of their own — must produce an
  // identical factor and personal PY.
  const { double, races } = await setup();
  const withWins = {
    season: 2026,
    cachedWins: [
      { helm_id: HAMISH, season: 2026, wins: 1 },
      { helm_id: LISA, season: 2026, wins: 3 },
    ],
    localWins: [],
    cachedAt: null,
  };

  const soloEntry = await rd.addEntry({
    race: races[0], klass: double, helmId: HAMISH, crewId: null, context: withWins,
  });
  const crewedEntry = await rd.addEntry({
    race: races[1], klass: double, helmId: HAMISH, crewId: LISA, context: withWins,
  });

  assert.equal(soloEntry.handicap_factor, 0.97, "Hamish's one win");
  assert.equal(crewedEntry.handicap_factor, 0.97, "unchanged by Lisa's three");
  assert.equal(crewedEntry.personal_py, soloEntry.personal_py);
  assert.equal(factorFor(3), 0.95, "Lisa's own factor exists but is irrelevant here");
});

test("changing the crew never touches the handicap", async () => {
  const { double, races } = await setup();
  const entry = await rd.addEntry({
    race: races[0], klass: double, helmId: HAMISH, crewId: LISA, context,
  });

  const changed = await rd.setEntryCrew(entry.id, TOM);

  assert.equal(changed.crew_id, TOM);
  assert.equal(changed.handicap_factor, entry.handicap_factor);
  assert.equal(changed.personal_py, entry.personal_py);
  assert.equal(changed.base_py, entry.base_py);
  assert.equal(changed.fleet, entry.fleet);
});

/* ---- combinations ------------------------------------------------------ */

test("signing on records the combination, so nobody has to maintain it", async () => {
  const { single, double, races } = await setup();
  await db.localWrite("races", { ...races[0], start_at: "2026-08-16T13:00:00Z" });
  await rd.addEntry({ race: races[0], klass: double, helmId: HAMISH, crewId: LISA, context });
  await rd.addEntry({ race: races[0], klass: single, helmId: TOM, context });

  const combos = await reg.listCombinations();

  assert.equal(combos.length, 2);
  const hamish = combos.find((c) => c.helm_id === HAMISH);
  assert.equal(hamish.crew_id, LISA);
  assert.equal(hamish.class_id, double.id);
  assert.equal(hamish.times_raced, 1);
  assert.equal(combos.find((c) => c.helm_id === TOM).crew_id, null, "solo stays solo");
});

test("swapping crew makes a different combination", async () => {
  const { double, races } = await setup();
  await db.localWrite("races", { ...races[0], start_at: "2026-08-16T13:00:00Z" });
  await db.localWrite("races", { ...races[1], start_at: "2026-08-16T15:00:00Z" });
  await rd.addEntry({ race: races[0], klass: double, helmId: HAMISH, crewId: LISA, context });
  await rd.addEntry({ race: races[1], klass: double, helmId: HAMISH, crewId: TOM, context });

  const combos = await reg.listCombinations();
  assert.equal(combos.length, 2, "both pairings are offered, one tap each");
  assert.deepEqual(combos.map((c) => c.crew_id).sort(), [LISA, TOM].sort());
});

test("solo and crewed in the same class are distinct rows", async () => {
  /* The nullable-crew uniqueness rule. In SQL null <> null, so a naive unique
     constraint would not constrain solo rows at all — and treating solo as
     "the crewed row with something missing" would merge two real pairings. */
  const { double, races } = await setup();
  await rd.addEntry({ race: races[0], klass: double, helmId: HAMISH, context });
  await rd.addEntry({ race: races[1], klass: double, helmId: HAMISH, crewId: LISA, context });

  const combos = await reg.listCombinations();
  assert.equal(combos.length, 2);
  assert.deepEqual(combos.map((c) => c.crew_id).sort(), [LISA, null].sort());
});

test("the same combination sailed twice is one row with a count", async () => {
  const { double, races } = await setup();
  await db.localWrite("races", { ...races[0], start_at: "2026-08-16T13:00:00Z" });
  await db.localWrite("races", { ...races[1], start_at: "2026-08-16T15:00:00Z" });
  await rd.addEntry({ race: races[0], klass: double, helmId: HAMISH, crewId: LISA, context });
  await rd.addEntry({ race: races[1], klass: double, helmId: HAMISH, crewId: LISA, context });

  const combos = await reg.listCombinations();
  assert.equal(combos.length, 1, "no duplicate");
  assert.equal(combos[0].times_raced, 2);
  assert.equal(combos[0].last_raced, "2026-08-16T15:00:00Z", "and remembers the latest outing");
});

test("a retrospective entry does not make an old pairing look recent", async () => {
  const { double, races } = await setup();
  await db.localWrite("races", { ...races[0], start_at: "2026-08-16T15:00:00Z" });
  await db.localWrite("races", { ...races[1], start_at: "2020-01-01T10:00:00Z" });
  await rd.addEntry({ race: races[0], klass: double, helmId: HAMISH, crewId: LISA, context });
  await rd.addEntry({ race: races[1], klass: double, helmId: TOM, context });

  const hamish = (await reg.listCombinations()).find((c) => c.helm_id === HAMISH);
  assert.equal(hamish.last_raced, "2026-08-16T15:00:00Z");
});

test("creating the same combination twice never duplicates it", async () => {
  const { double } = await setup();
  const first = await reg.createCombination({ helmId: HAMISH, crewId: LISA, classId: double.id });
  const again = await reg.createCombination({ helmId: HAMISH, crewId: LISA, classId: double.id });

  assert.equal(again.id, first.id, "the existing row is returned, not a second one");
  assert.equal((await reg.listCombinations()).length, 1);
});

test("a retired pairing is revived by signing it on, not duplicated", async () => {
  const { double, races } = await setup();
  const combo = await reg.createCombination({ helmId: HAMISH, crewId: LISA, classId: double.id });
  await reg.retireCombination(combo.id);
  assert.equal((await reg.listCombinations()).length, 0, "hidden from the default list");

  await rd.addEntry({ race: races[0], klass: double, helmId: HAMISH, crewId: LISA, context });

  const combos = await reg.listCombinations();
  assert.equal(combos.length, 1, "back, and still one row");
  assert.equal(combos[0].id, combo.id);
  assert.equal(combos[0].times_raced, 1);
});

test("retiring keeps the row, because history belongs to it", async () => {
  const { double } = await setup();
  const combo = await reg.createCombination({ helmId: HAMISH, crewId: LISA, classId: double.id });
  await reg.retireCombination(combo.id);

  assert.equal((await reg.listCombinations()).length, 0);
  assert.equal((await reg.listCombinations({ includeRetired: true })).length, 1);
  assert.ok(await db.get("combinations", combo.id), "never deleted");
});

/* ---- the sign-on order -------------------------------------------------- */

test("most-raced first, then most-recent", async () => {
  const { double } = await setup();
  const mk = async (helmId, crewId, times, last) => {
    const c = await reg.createCombination({ helmId, crewId, classId: double.id });
    await db.localWrite("combinations", { ...c, times_raced: times, last_raced: last });
  };
  await mk(HAMISH, null, 2, "2026-01-01T00:00:00Z");
  await mk(LISA, null, 9, "2020-01-01T00:00:00Z");
  await mk(TOM, null, 2, "2026-08-01T00:00:00Z");

  const order = (await reg.listCombinations()).map((c) => c.helm_id);
  assert.deepEqual(order, [LISA, TOM, HAMISH], "9 first; then the two on 2, recent first");
});

/* ---- sail numbers ------------------------------------------------------- */

test("the register's number pre-fills the entry", async () => {
  const { double, races } = await setup();
  await reg.createCombination({
    helmId: HAMISH, crewId: LISA, classId: double.id, defaultSailNo: "2298",
  });

  const combo = (await reg.listCombinations())[0];
  const entry = await rd.addEntry({
    race: races[0], klass: double, helmId: HAMISH, crewId: LISA,
    sailNo: combo.default_sail_no, context,
  });

  assert.equal(entry.sail_no, "2298");
});

test("a borrowed boat overrides the entry without rewriting the register", async () => {
  const { double, races } = await setup();
  await reg.createCombination({
    helmId: HAMISH, crewId: LISA, classId: double.id, defaultSailNo: "2298",
  });

  const entry = await rd.addEntry({
    race: races[0], klass: double, helmId: HAMISH, crewId: LISA,
    sailNo: "9999", context,
  });

  assert.equal(entry.sail_no, "9999", "this race only");
  const combo = (await reg.listCombinations())[0];
  assert.equal(combo.default_sail_no, "2298", "what they usually sail is unchanged");
});

test("a pairing with no remembered number adopts the first one used", async () => {
  const { double, races } = await setup();
  await rd.addEntry({
    race: races[0], klass: double, helmId: HAMISH, crewId: LISA, sailNo: "2298", context,
  });
  const combo = (await reg.listCombinations())[0];
  assert.equal(combo.default_sail_no, "2298");
});

test("the sail number can be changed per race after signing on", async () => {
  const { double, races } = await setup();
  const entry = await rd.addEntry({
    race: races[0], klass: double, helmId: HAMISH, sailNo: "2298", context,
  });
  const changed = await rd.setEntrySailNo(entry.id, "1234");
  assert.equal(changed.sail_no, "1234");

  const cleared = await rd.setEntrySailNo(entry.id, "   ");
  assert.equal(cleared.sail_no, null, "and cleared entirely");
});

/* ---- the club-wide list, on a phone that has raced nothing -------------- */

test("a fresh phone shows the club's combinations, not its own history", async () => {
  /* The whole reason combinations became a table. A rotating OOD on a phone
     that has never run a race must see every pairing the club races, on the
     first morning of the fortnight, offline. bulkPut is the reference pull. */
  await db.clearAll();
  await db.bulkPut("helms", [
    { id: HAMISH, name: "Hamish Fowler" },
    { id: LISA, name: "Lisa Brown" },
  ]);
  await db.bulkPut("classes", [{ id: "c-double", name: "Laser 2000", base_py: 1122, crew_size: 2 }]);
  await db.bulkPut("combinations", [
    { id: "cm1", helm_id: HAMISH, crew_id: LISA, class_id: "c-double",
      default_sail_no: "2298", times_raced: 7, last_raced: "2026-08-02T13:00:00Z", active: true },
  ]);

  assert.equal((await db.getAll("entries")).length, 0, "no local race history at all");

  const combos = await reg.listCombinations();
  assert.equal(combos.length, 1);
  assert.equal(combos[0].times_raced, 7, "the club's count, not this phone's");
  assert.equal(entryLabel(combos[0]), "Hamish Fowler + Lisa Brown");
});

test("a pulled combination and a local one merge without duplicating", async () => {
  /* The phone created a pairing offline; the server later sends back the row
     it synced. Same id, so the reference pull overwrites rather than adds. */
  const { double } = await setup();
  const local = await reg.createCombination({
    helmId: HAMISH, crewId: LISA, classId: double.id, defaultSailNo: "2298",
  });
  assert.equal((await reg.listCombinations()).length, 1);

  await db.bulkPut("combinations", [
    { ...local, times_raced: 12, last_raced: "2026-08-02T13:00:00Z" },
  ]);

  const combos = await reg.listCombinations();
  assert.equal(combos.length, 1, "one pairing, not two");
  assert.equal(combos[0].times_raced, 12, "the server's count wins on a refresh");
});

test("a combination created offline is not queued twice", async () => {
  const { double } = await setup();
  const before = (await db.allOutbox()).filter((e) => e.table === "combinations").length;
  await reg.createCombination({ helmId: HAMISH, crewId: LISA, classId: double.id });
  await reg.createCombination({ helmId: HAMISH, crewId: LISA, classId: double.id });

  const queued = (await db.allOutbox()).filter((e) => e.table === "combinations");
  assert.equal((await reg.listCombinations()).length, 1);
  // Two writes of the SAME id is not a duplicate — the server upserts on it.
  const ids = new Set(queued.map((e) => e.id));
  assert.equal(ids.size, 1, `one combination id in the outbox, saw ${ids.size}`);
  void before;
});

/* ---- display ------------------------------------------------------------ */

const helm = { name: "Hamish Fowler" };
const crew = { name: "Lisa Brown" };
const klass = { name: "Laser 2000" };

test("the combination is the name", () => {
  assert.equal(entryLabel({ helm, crew, klass }), "Hamish Fowler + Lisa Brown");
  assert.equal(entryLabel({ helm, klass }), "Hamish Fowler", "single-hander is just the helm");
});

test("the sail number is detail, never the name", () => {
  // "Hamish Fowler + Lisa Fowler · Laser 2000 · 2298"
  assert.equal(entryLabel({ helm, crew, klass }), "Hamish Fowler + Lisa Brown");
  assert.equal(
    entryDetail({ klass, sailNo: "2298" }),
    "Laser 2000 · 2298",
    "the number identifies the boat on the water, not the people in it"
  );
});

test("the detail line never repeats the people", () => {
  assert.equal(entryDetail({ helm, crew, klass }), "Laser 2000");
});

test("the sail number is read off the entry", () => {
  assert.equal(entryDetail({ entry: { sail_no: "2298" }, klass }), "Laser 2000 · 2298");
  assert.equal(entryDetail({ entry: { sail_no: null }, klass }), "Laser 2000", "and omitted when absent");
});

test("an entry with nothing known does not render as blank", () => {
  assert.equal(entryLabel({}), "unknown");
});

/* ---- the tally counts people ------------------------------------------- */

test("everyone aboard is counted, not just the boat", () => {
  assert.equal(entryPeople({ helm, crew }).length, 2, "an unaccounted pair is two people");
  assert.equal(entryPeople({ helm }).length, 1);
  assert.equal(entryPeople({}).length, 0);
});

