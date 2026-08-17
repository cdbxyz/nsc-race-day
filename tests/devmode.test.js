/* Non-production modes must be impossible to miss and impossible to keep.
 *
 * The fake sync destination is the dangerous one. With it selected every tap
 * still commits to IndexedDB, the outbox still drains, and the sync pill
 * still says "All synced" — while nothing at all reaches the club's database.
 * A whole race day could be run and thrown away without a single visible
 * symptom.
 *
 * So two properties are pinned here:
 *
 *   1. Every active mode is announced, loudly, with no way to dismiss it.
 *   2. No mode can survive a reload, because nothing writes one down.
 */

import "fake-indexeddb/auto";
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as db from "../js/db.js";
import * as rd from "../js/raceday.js";
import * as reg from "../js/registers.js";
import { sync, fakeBackend, createFakeBackend, onBackendChange } from "../js/sync.js";
import { supabaseBackend } from "../js/backend.js";
import { setSequenceSpeed } from "../js/devclock.js";
import { activeModes, isProduction, wouldBeTestData, onModeChange } from "../js/devmode.js";

/** Whatever a fresh load gives you: the real database, at real speed. */
function backToProduction() {
  sync.setBackend(supabaseBackend);
  setSequenceSpeed(1);
}

beforeEach(async () => {
  backToProduction();
  await db.clearAll();
});
after(async () => {
  backToProduction();
  await db.closeDB();
});

/* ---- what counts as production ------------------------------------------ */

test("the real backend at real speed is production", () => {
  assert.equal(isProduction(), true);
  assert.deepEqual(activeModes(), []);
  assert.equal(wouldBeTestData(), false);
});

test("a fake destination is announced in the words the club needs", () => {
  sync.setBackend(fakeBackend);

  const modes = activeModes();
  assert.equal(modes.length, 1);
  assert.equal(modes[0].id, "backend");
  assert.equal(modes[0].label, "TEST MODE — records are not reaching the club database");
  assert.match(modes[0].detail, /thrown away/);
  assert.equal(isProduction(), false);
});

test("a fast clock is announced too", () => {
  setSequenceSpeed(60);
  const modes = activeModes();
  assert.equal(modes.length, 1);
  assert.equal(modes[0].id, "clock");
  assert.match(modes[0].label, /FAST CLOCK 60/);
});

test("both at once are both announced — neither hides the other", () => {
  sync.setBackend(fakeBackend);
  setSequenceSpeed(60);
  assert.deepEqual(activeModes().map((m) => m.id), ["backend", "clock"]);
});

test("any destination that is not supabase counts, not just the one fake", () => {
  // A future third backend must not slip through by not being named "fake".
  sync.setBackend(createFakeBackend());
  assert.equal(isProduction(), false);

  sync.setBackend({ name: "something-else", async push() {} });
  assert.equal(isProduction(), false, "the rule is allow-list, not deny-list");
});

/* ---- the banner is told the moment anything changes --------------------- */

test("switching the destination announces immediately", () => {
  const seen = [];
  const off = onModeChange((modes) => seen.push(modes.map((m) => m.id)));

  sync.setBackend(fakeBackend);
  sync.setBackend(supabaseBackend);

  assert.deepEqual(seen, [["backend"], []]);
  off();
});

test("switching the clock announces immediately", () => {
  const seen = [];
  const off = onModeChange((modes) => seen.push(modes.map((m) => m.id)));

  setSequenceSpeed(10);
  setSequenceSpeed(1);

  assert.deepEqual(seen, [["clock"], []]);
  off();
});

test("setting the same destination twice does not re-announce", () => {
  sync.setBackend(supabaseBackend);
  const seen = [];
  const off = onBackendChange((name) => seen.push(name));

  sync.setBackend(supabaseBackend);
  assert.deepEqual(seen, [], "no change, no noise");

  sync.setBackend(fakeBackend);
  assert.deepEqual(seen, ["fake"]);
  off();
});

/* ---- nothing survives a reload ------------------------------------------ */

test("no dev mode is written to any storage API", async () => {
  /* The guarantee behind "reloading always returns to production": there is
     nowhere for the state to come back from. Asserted against the source of
     every module that holds a dev mode. */
  for (const file of ["../js/devclock.js", "../js/devmode.js"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.ok(
      !/localStorage|sessionStorage|indexedDB|localWrite|setMeta|document\.cookie/.test(source),
      `${file} must not persist a dev mode`
    );
  }
});

test("sync.js never persists the chosen destination", async () => {
  const source = await readFile(new URL("../js/sync.js", import.meta.url), "utf8");
  const setBackend = source.slice(source.indexOf("setBackend(next)"));
  assert.ok(
    !/localStorage|sessionStorage|setMeta|document\.cookie/.test(setBackend.slice(0, 600)),
    "setBackend must not write the destination down"
  );
});

test("boot points sync at the real database unconditionally", async () => {
  // This is what makes a reload a reset: app.js does it every single time,
  // with nothing read back from storage to override it.
  const source = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(source, /sync\.setBackend\(supabaseBackend\)/);
  assert.ok(
    !/setBackend\((?!supabaseBackend)/.test(source),
    "app.js must never point sync anywhere else"
  );
});

test("the banner has no dismiss control", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const bar = html.slice(html.indexOf('id="testmode-bar"'));
  const element = bar.slice(0, bar.indexOf("</div>") + 6);
  assert.ok(!/dismiss|hidden="false"|button/i.test(element), "no way to close it");
  assert.match(element, /role="alert"/);

  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  // Just this one function: other shell bars legitimately wire up buttons.
  const start = app.indexOf("function wireTestModeBanner");
  const wiring = app.slice(start, app.indexOf("\n}", app.indexOf("paint(activeModes())")));
  assert.ok(wiring.length > 100, "found the function body");
  assert.ok(!/dismiss|addEventListener/.test(wiring), "and nothing wires one up");
});

/* ---- a rehearsal is branded and cannot move a handicap ------------------ */

test("a day created on the fake destination is test data from birth", async () => {
  sync.setBackend(fakeBackend);
  const { raceDay } = await rd.createRaceDay({ date: "2026-08-16", oodName: "Chris" });
  assert.equal(raceDay.is_test_data, true);
  assert.equal(rd.isTestDay(raceDay), true);
});

test("a day created on the fast clock is test data from birth", async () => {
  setSequenceSpeed(60);
  const { raceDay } = await rd.createRaceDay({ date: "2026-08-16", oodName: "Chris" });
  assert.equal(rd.isTestDay(raceDay), true);
});

test("a real day is not branded", async () => {
  const { raceDay } = await rd.createRaceDay({ date: "2026-08-16", oodName: "Chris" });
  assert.equal(rd.isTestDay(raceDay), false);
});

test("switching to fake mid-day still brands the day", async () => {
  const { raceDay } = await rd.createRaceDay({ date: "2026-08-16", oodName: "Chris" });
  assert.equal(rd.isTestDay(raceDay), false, "started honestly");

  // What the sequence page does when the gun is armed.
  sync.setBackend(fakeBackend);
  assert.equal(wouldBeTestData(), true);
  const branded = await rd.markRaceDayAsTest(raceDay);
  assert.equal(rd.isTestDay(branded), true);
});

test("a branded day is stored branded, not just returned branded", async () => {
  sync.setBackend(fakeBackend);
  const { raceDay } = await rd.createRaceDay({ date: "2026-08-16", oodName: "Chris" });
  const stored = await db.get("race_days", raceDay.id);
  assert.equal(stored.is_test_data, true, "survives a reload of the page");
});

test("branding is what suppresses local wins, and it is set", async () => {
  /* results.js publishes with `rd.isTestDay(raceDay) ? null : winner`, so
     the branding above is the whole of the win suppression. Pinned here so
     the link between the two cannot be quietly broken. */
  const source = await readFile(new URL("../js/pages/results.js", import.meta.url), "utf8");
  assert.match(source, /isTestDay\(raceDay\)\s*\?\s*null\s*:/);

  sync.setBackend(fakeBackend);
  const { raceDay } = await rd.createRaceDay({ date: "2026-08-16", oodName: "Chris" });
  assert.equal(rd.isTestDay(raceDay), true, "so no win is recorded for this day");
});

test("a rehearsal day never reaches the real wins table", async () => {
  sync.setBackend(fakeBackend);
  const klass = await reg.createClass({ name: "Solo", basePy: 1142 });
  const helm = await reg.createMember({ name: "Hamish Fowler" });
  const { raceDay } = await rd.createRaceDay({ date: "2026-08-16", oodName: "Chris" });
  const [race] = await rd.racesForDay(raceDay.id);
  const context = await rd.handicapContext(2026);
  await rd.addEntry({ race, klass, helmId: helm.id, context });

  const wins = await db.getAll("handicap_wins").catch(() => []);
  assert.equal(wins.length, 0);
  assert.equal(rd.isTestDay(raceDay), true);
});
