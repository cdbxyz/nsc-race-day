/* Crew and combinations.
 *
 * At this club the persistent identity is the pairing — helm (+ crew) in a
 * class — not the hull. The old boat-name-first model produced boats called
 * "Hamish + Lisa", which is a workaround pretending to be data.
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
  assert.equal(entry.boat_id, null, "and no hull had to be invented");
  assert.equal(entry.base_py, 1122);
});

test("a helm sails one boat per race", async () => {
  const { single, double, races } = await setup();
  await rd.addEntry({ race: races[0], klass: double, helmId: HAMISH, context });
  await assert.rejects(
    () => rd.addEntry({ race: races[0], klass: single, helmId: HAMISH, context }),
    /already signed on/
  );
});

test("the boat register refuses a crew pairing as a name", async () => {
  const { double } = await setup();
  await assert.rejects(
    () => reg.createBoat({ name: "Hamish + Lisa", classId: double.id }),
    /hulls, not pairings/
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

test("combinations are derived from what has actually been sailed", async () => {
  const { single, double, races } = await setup();
  await db.localWrite("races", { ...races[0], start_at: "2026-08-16T13:00:00Z" });
  await rd.addEntry({ race: races[0], klass: double, helmId: HAMISH, crewId: LISA, context });
  await rd.addEntry({ race: races[0], klass: single, helmId: TOM, context });

  const combos = await rd.recentCombinations();

  assert.equal(combos.length, 2);
  const hamish = combos.find((c) => c.helmId === HAMISH);
  assert.equal(hamish.crewId, LISA);
  assert.equal(hamish.classId, double.id);
  assert.equal(combos.find((c) => c.helmId === TOM).crewId, null);
});

test("swapping crew makes a different combination", async () => {
  const { double, races } = await setup();
  await db.localWrite("races", { ...races[0], start_at: "2026-08-16T13:00:00Z" });
  await db.localWrite("races", { ...races[1], start_at: "2026-08-16T15:00:00Z" });
  await rd.addEntry({ race: races[0], klass: double, helmId: HAMISH, crewId: LISA, context });
  await rd.addEntry({ race: races[1], klass: double, helmId: HAMISH, crewId: TOM, context });

  const combos = await rd.recentCombinations();

  assert.equal(combos.length, 2, "both pairings are offered, one tap each");
  assert.deepEqual(combos.map((c) => c.crewId), [TOM, LISA], "most recent first");
});

test("the same combination sailed twice appears once", async () => {
  const { double, races } = await setup();
  await db.localWrite("races", { ...races[0], start_at: "2026-08-16T13:00:00Z" });
  await db.localWrite("races", { ...races[1], start_at: "2026-08-16T15:00:00Z" });
  await rd.addEntry({ race: races[0], klass: double, helmId: HAMISH, crewId: LISA, context });
  await rd.addEntry({ race: races[1], klass: double, helmId: HAMISH, crewId: LISA, context });

  const combos = await rd.recentCombinations();
  assert.equal(combos.length, 1);
  assert.equal(combos[0].lastSeen, "2026-08-16T15:00:00Z", "and remembers the latest outing");
});

/* ---- display ------------------------------------------------------------ */

const helm = { name: "Hamish Fowler" };
const crew = { name: "Lisa Brown" };
const klass = { name: "Laser 2000" };

test("with no hull, the combination is the name", () => {
  assert.equal(entryLabel({ helm, crew, klass }), "Hamish Fowler + Lisa Brown");
  assert.equal(entryLabel({ helm, klass }), "Hamish Fowler", "single-hander is just the helm");
});

test("a real hull still leads", () => {
  const boat = { name: "Vaila", sail_no: "2001" };
  assert.equal(entryLabel({ boat, helm, crew, klass }), "Vaila");
  assert.equal(
    entryDetail({ boat, helm, crew, klass }),
    "Hamish Fowler + Lisa Brown · Laser 2000 · 2001",
    "the people and the sail number move to the second line"
  );
});

test("the detail line does not repeat the people when they are the name", () => {
  assert.equal(entryDetail({ helm, crew, klass }), "Laser 2000");
});

test("a sail number shows even with no boat name", () => {
  assert.equal(entryLabel({ boat: { sail_no: "2298" }, helm, klass }), "Hamish Fowler");
  assert.equal(entryDetail({ boat: { sail_no: "2298" }, helm, klass }), "Laser 2000 · 2298");
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

/* A hull recorded as a sail number and nothing else.
 *
 * This is the common case at sign-on, not an edge one: the form asks for a
 * sail number and never for a hull name, so `name` is stored null. listBoats()
 * sorted on a.name.localeCompare(b.name) and threw on the first such boat,
 * which took the whole sign-on page down with it.
 */
test("a hull with only a sail number can be listed", async () => {
  const klass = await reg.createClass({ name: "Solo", basePy: 1142 });
  await reg.createBoat({ name: "", sailNo: "5721", classId: klass.id });
  await reg.createBoat({ name: "Kittiwake", sailNo: "", classId: klass.id });

  const boats = await reg.listBoats();
  assert.equal(boats.length, 2);
  assert.deepEqual(
    boats.map((b) => b.sail_no ?? b.name),
    ["5721", "Kittiwake"],
    "sorted on what is shown, not on a name that may not exist"
  );
});
