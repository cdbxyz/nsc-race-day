/* Wind, and the season programme. */

import "fake-indexeddb/auto";
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import * as db from "../js/db.js";
import * as cal from "../js/calendar.js";
import { COMPASS, FORCES, forceLabel, windText, windShort } from "../js/wind.js";

beforeEach(() => db.clearAll());
after(() => db.closeDB());

/* ---- wind --------------------------------------------------------------- */

test("direction is the eight points a race officer works to", () => {
  assert.deepEqual(COMPASS, ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]);
});

test("strength is Beaufort, which an OOD can judge without an instrument", () => {
  assert.equal(forceLabel(4), "F4 Moderate breeze");
  assert.equal(forceLabel(0), "F0 Calm");
  assert.equal(FORCES.length, 9, "F0 to F8 covers anything the club sails in");
});

test("wind reads as one phrase, and as a short form for a column", () => {
  const race = { wind_direction: "SW", wind_force: 4 };
  assert.equal(windText(race), "SW F4 Moderate breeze");
  assert.equal(windShort(race), "SW F4");
});

test("a half-recorded wind still says what is known", () => {
  assert.equal(windText({ wind_direction: "N", wind_force: null }), "N");
  assert.equal(windText({ wind_direction: null, wind_force: 3 }), "F3 Gentle breeze");
});

test("nothing recorded reads as nothing, not as a stray zero", () => {
  assert.equal(windText({}), null);
  assert.equal(windShort({}), "");
  assert.equal(windText({ wind_direction: null, wind_force: null }), null);
});

test("a flat calm is recorded, not treated as missing", () => {
  // F0 is a real observation and the reason a race gets abandoned.
  assert.equal(windText({ wind_direction: null, wind_force: 0 }), "F0 Calm");
  assert.equal(windShort({ wind_force: 0 }), "F0");
});

/* ---- the programme ------------------------------------------------------ */

async function seedFortnight() {
  const rows = [
    ["2026-08-02", "Whitaker Cup", "14:00", false],
    ["2026-08-08", "Commodore's Tankard", "13:00", false],
    ["2026-08-08", "Richard Burrell Trophy", "15:00", false],
    ["2026-08-14", "Crowther Cup", "14:00", true],
  ];
  for (const [date, name, startTime, isPursuit] of rows) {
    await cal.createCalendarEntry({ season: 2026, date, name, startTime, isPursuit });
  }
}

test("the programme comes back in date then time order", async () => {
  await seedFortnight();
  const entries = await cal.listCalendar(2026);
  assert.deepEqual(entries.map((e) => e.name), [
    "Whitaker Cup",
    "Commodore's Tankard",
    "Richard Burrell Trophy",
    "Crowther Cup",
  ]);
});

test("a date can carry two races", async () => {
  await seedFortnight();
  const both = await cal.racesOn("2026-08-08");
  assert.equal(both.length, 2);
  assert.deepEqual(both.map((r) => cal.shortTime(r.start_time)), ["13:00", "15:00"]);
});

test("a date with no racing has no entries, which is an absence not a blank", async () => {
  await seedFortnight();
  assert.deepEqual(await cal.racesOn("2026-08-15"), []);
  assert.deepEqual(await cal.racesOn("2026-08-16"), []);
});

test("a pursuit race is flagged so the OOD is not stranded on the day", async () => {
  await seedFortnight();
  const [crowther] = await cal.racesOn("2026-08-14");
  assert.equal(crowther.is_pursuit, true);
  assert.match(cal.PURSUIT_CALCULATOR_URL, /nsc-race-calc/);
});

test("the club spelling is Whitaker, with one t", async () => {
  await seedFortnight();
  const [race] = await cal.racesOn("2026-08-02");
  assert.equal(race.name, "Whitaker Cup");
  assert.ok(!/Whittaker/.test(race.name), "the two-t misspelling must not creep back");
});

test("entries are editable, because this starts life as a draft proposal", async () => {
  await seedFortnight();
  const [entry] = await cal.racesOn("2026-08-02");

  const renamed = await cal.updateCalendarEntry(entry.id, { name: "Whitaker Cup (rescheduled)", startTime: "15:30" });
  assert.equal(renamed.name, "Whitaker Cup (rescheduled)");
  assert.equal(cal.shortTime(renamed.start_time), "15:30");

  await cal.removeCalendarEntry(entry.id);
  assert.deepEqual(await cal.racesOn("2026-08-02"), []);
});

test("a calendar entry needs a name and a date", async () => {
  await assert.rejects(() => cal.createCalendarEntry({ season: 2026, date: "2026-08-02", name: "  " }), /name/);
  await assert.rejects(() => cal.createCalendarEntry({ season: 2026, name: "Cup" }), /date/);
});

test("the season defaults from the date rather than being guessed", async () => {
  const entry = await cal.createCalendarEntry({ date: "2027-07-04", name: "Next year" });
  assert.equal(entry.season, 2027);
});
