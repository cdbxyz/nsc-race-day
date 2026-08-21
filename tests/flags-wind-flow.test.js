/* Three things an OOD must be able to trust:
 *
 *   - what is flying while racing is postponed,
 *   - what wind was recorded, and that it can be left blank,
 *   - and that moving forward never starts anything.
 */

import "fake-indexeddb/auto";
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as db from "../js/db.js";
import * as rd from "../js/raceday.js";
import * as reg from "../js/registers.js";
import * as log from "../js/raceevents.js";
import { sequenceState, SEQUENCE_MS } from "../js/state.js";

/* Race signals are separate deliberate taps, seconds apart. Writing them
   back to back would land them in the same millisecond, which is a case no
   OOD can produce and the log has no way to order. */
const aMomentLater = () => new Promise((r) => setTimeout(r, 3));
import { FORCES, FORCE_CHOICES, forceLabel, windText, windShort } from "../js/wind.js";

beforeEach(() => db.clearAll());
after(() => db.closeDB());

async function aRace() {
  const klass = await reg.createClass({ name: "Laser 2000", basePy: 1122, crewSize: 2 });
  const helm = await reg.createMember({ name: "Hamish Fowler" });
  const { raceDay } = await rd.createRaceDay({ date: "2026-08-21", oodName: "Chris", raceCount: 1 });
  const [race] = await rd.racesForDay(raceDay.id);
  const context = await rd.handicapContext(2026);
  await rd.addEntry({ race, klass, helmId: helm.id, context });
  return { raceDay, race };
}

/* ---- AP: postponed ------------------------------------------------------ */

test("a postponed race is postponed, and knows it from the log alone", async () => {
  const { race } = await aRace();
  await log.startSequence(race.id);
  await aMomentLater();
  await log.postpone(race.id);

  const events = await log.eventsForRace(race.id);
  const state = sequenceState(events);

  assert.equal(state.postponed, true);
  assert.equal(state.running, false, "no countdown while AP is up");
  assert.equal(state.startAt, null);
});

test("the AP state survives a reload, because it is derived", async () => {
  /* A phone pocketed during a postponement and reopened an hour later must
     still say what is on the pole. Nothing is cached to make that true. */
  const { race } = await aRace();
  await log.startSequence(race.id);
  await aMomentLater();
  await log.postpone(race.id);

  // Everything the page has after a reload is the log.
  const reread = sequenceState(await log.eventsForRace(race.id));
  assert.equal(reread.postponed, true);
});

test("restarting the sequence clears AP — the moment it comes down", async () => {
  const { race } = await aRace();
  await log.startSequence(race.id);
  await aMomentLater();
  await log.postpone(race.id);
  await aMomentLater();
  await log.startSequence(race.id);

  const state = sequenceState(await log.eventsForRace(race.id));
  assert.equal(state.postponed, false, "AP is down");
  assert.equal(state.running, true, "and the ten minutes are running again");
  assert.equal(state.startAt - state.startedAt, SEQUENCE_MS);
});

test("the sequence page shows AP, and the artwork is precached", async () => {
  const page = await readFile(new URL("../js/pages/sequence.js", import.meta.url), "utf8");
  assert.match(page, /apPanel\(\)/);
  assert.match(page, /img\/flags\/ap\.svg/);
  assert.match(page, /AP flying — racing postponed/);
  assert.match(page, /Lower AP and restart/);

  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  assert.match(sw, /"\.\/img\/flags\/ap\.svg"/, "no signal on a postponed beach either");
});

test("AP is shown only while postponed, never beside a running clock", async () => {
  const page = await readFile(new URL("../js/pages/sequence.js", import.meta.url), "utf8");
  // It lives in the arm panel, which renders only when nothing is running.
  assert.match(page, /if \(sequence\.postponed\) body\.append\(apPanel\(\)\);/);
});

/* ---- wind: tap to select, tap again to clear ---------------------------- */

test("there is one box per force, and the stored value is that force", () => {
  assert.equal(FORCE_CHOICES.length, 9, "F0-F8, ungrouped");
  assert.deepEqual(FORCE_CHOICES.map((c) => c.force), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  // Every box maps to an integer the schema and the results sheet accept.
  for (const choice of FORCE_CHOICES) {
    assert.equal(Number.isInteger(choice.force), true);
    assert.equal(choice.name, FORCES.find(([n]) => n === choice.force)[1]);
  }
});

test("adjacent forces are told apart by name, not just by number", () => {
  // "Light air" and "Light breeze" are F1 and F2; a clipped label would make
  // the pair a coin toss at arm's length.
  const names = FORCE_CHOICES.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, "no two boxes read the same");
  assert.equal(FORCE_CHOICES[1].name, "Light air");
  assert.equal(FORCE_CHOICES[2].name, "Light breeze");
});

test("wind is stored, and both halves are independently optional", async () => {
  const { race } = await aRace();

  let row = await rd.setRaceWind(race, { direction: "SW", force: 4 });
  assert.equal(row.wind_direction, "SW");
  assert.equal(row.wind_force, 4);

  // Deselecting the direction leaves the force alone.
  row = await rd.setRaceWind(row, { direction: null, force: 4 });
  assert.equal(row.wind_direction, null);
  assert.equal(row.wind_force, 4);

  // And deselecting the force leaves nothing behind.
  row = await rd.setRaceWind(row, { direction: null, force: null });
  assert.equal(row.wind_force, null);
  assert.equal(windText(row), null, "an OOD who skipped it is not blocked");
});

test("force 0 is a recorded value, not an absence", async () => {
  /* Calm is the reason a race gets abandoned. It must not be indistinguishable
     from "nobody looked". */
  const { race } = await aRace();
  const row = await rd.setRaceWind(race, { direction: null, force: 0 });
  assert.equal(row.wind_force, 0);
  assert.equal(windText(row), "F0 Calm");
  assert.equal(windShort(row), "F0");
});

test("the stored force prints the same way everywhere", async () => {
  const { race } = await aRace();
  const row = await rd.setRaceWind(race, { direction: "NE", force: 6 });

  assert.equal(forceLabel(6), "F6 Strong breeze");
  assert.equal(windText(row), "NE F6 Strong breeze", "results sheet and PDF");
  assert.equal(windShort(row), "NE F6", "CSV column");
});

test("the wind survives a reload", async () => {
  const { race } = await aRace();
  await rd.setRaceWind(race, { direction: "S", force: 3 });
  const reread = await db.get("races", race.id);
  assert.equal(windShort(reread), "S F3");
});

test("both pages build the control from one place", async () => {
  /* Two implementations of the same pair is how they drift into different
     controls for the same value. */
  const ui = await readFile(new URL("../js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /export function windControls/);
  assert.match(ui, /chosenForce === n \? null : n/, "tap the chosen box to clear it");
  assert.match(ui, /chosenDirection === point \? null : point/);

  for (const file of ["../js/pages/sequence.js", "../js/pages/results.js"]) {
    const src = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(src, /windControls\(/, `${file} must use the shared control`);
    assert.ok(!/selectField\(\s*\n?\s*"Strength"/.test(src), `${file} must not keep a select`);
  }
});

/* ---- moving forward starts nothing -------------------------------------- */

test("the forward step writes no sequence_started event", async () => {
  /* Arming the gun is never a side effect of navigating. This drives the same
     writes the checklist's forward button makes, and asserts what it does NOT
     do. */
  const { race } = await aRace();
  assert.equal(race.status, "setup");

  // What the checklist button does: finish the checklist, mark prestart, go.
  const moved = await rd.setRaceStatusIfEarlier(race, "prestart");

  const events = await log.eventsForRace(race.id);
  assert.deepEqual(events.map((e) => e.type), [], "no events at all");
  assert.equal(sequenceState(events).running, false);
  assert.equal(moved.status, "prestart", "a status, which is not a gun");
});

test("only the explicit tap arms the sequence", async () => {
  const { race } = await aRace();
  await rd.setRaceStatusIfEarlier(race, "prestart");
  assert.equal(sequenceState(await log.eventsForRace(race.id)).running, false);

  // The Start button, and nothing else, writes this.
  await log.startSequence(race.id);
  assert.equal(sequenceState(await log.eventsForRace(race.id)).running, true);
});

test("no navigation handler writes a race event", async () => {
  /* Read the pages: a handler whose whole job is to navigate must not also
     append to the log. */
  for (const file of [
    "../js/pages/checklist.js",
    "../js/pages/signon.js",
    "../js/pages/live.js",
    "../js/pages/results.js",
    "../js/pages/home.js",
  ]) {
    const src = await readFile(new URL(file, import.meta.url), "utf8");
    const handlers = src.match(/onclick:\s*\(\)\s*=>\s*navigate\([^)]*\)/g) ?? [];
    for (const handler of handlers) {
      assert.ok(!/log\.|record|append/.test(handler), `${file}: ${handler}`);
    }
  }
});

test("forward buttons are labelled as destinations, not as acts", async () => {
  const checklist = await readFile(new URL("../js/pages/checklist.js", import.meta.url), "utf8");
  assert.match(checklist, /Go to start sequence →/);
  assert.ok(
    !/text: complete \? "Start sequence →"/.test(checklist),
    "'Start sequence' reads as starting the sequence"
  );

  const results = await readFile(new URL("../js/pages/results.js", import.meta.url), "utf8");
  assert.match(results, /Add a race and sign on →/, "says when it will create a race");
  assert.match(results, /Sign on Race \$\{race\.number\} →/, "and when it will not");
});

test("the pre-start page says nothing has begun, and names the flag", async () => {
  const page = await readFile(new URL("../js/pages/sequence.js", import.meta.url), "utf8");
  assert.match(page, /Nothing has started yet/);
  assert.match(page, /class\.svg/, "the flag to have in hand");
  assert.match(page, /it does not sound anything/, "the horn is still the OOD's job");
});
