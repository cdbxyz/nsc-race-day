/* The scoring engine.
 *
 * This decides who won, so the bar is that it reproduces the club's existing
 * calculator exactly — not approximately. The demonstration race built into
 * that calculator is the golden case, and the numbers below were worked out
 * from its own formulae rather than from this implementation.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  scoreRace,
  formatPoints,
  hms,
  gapText,
  pyText,
  placeText,
  CODES,
  CODE_ORDER,
} from "../js/scoring.js";

const boat = (name, py, elapsedSeconds, laps, extra = {}) => ({
  id: name,
  name,
  personalPy: py,
  elapsedSeconds,
  laps,
  ...extra,
});

/* ---- the calculator's demonstration race -------------------------------- */

/* Fly       PY 943   1:00:00  3 laps
 * Vaila     PY 930   0:59:00  3 laps
 * Sirocco   PY 1010  0:41:30  2 laps
 * Kittiwake DNF
 *
 * max laps 3, so:
 *   Fly     3600 x 3 / 3 = 3600 lap-adjusted, x1000/943  = 3817.6  -> 3818
 *   Vaila   3540 x 3 / 3 = 3540 lap-adjusted, x1000/930  = 3806.5  -> 3806
 *   Sirocco 2490 x 3 / 2 = 3735 lap-adjusted, x1000/1010 = 3698.0  -> 3698
 */
const DEMONSTRATION = [
  boat("Fly", 943, 3600, 3),
  boat("Vaila", 930, 3540, 3),
  boat("Sirocco", 1010, 2490, 2),
  boat("Kittiwake", 1099, 0, 0, { code: "DNF" }),
];

test("the demonstration race matches the old calculator exactly", () => {
  const { scored, out, maxLaps, starters, penalty } = scoreRace(DEMONSTRATION);

  assert.equal(maxLaps, 3, "from the boat that sailed furthest");

  assert.deepEqual(
    scored.map((r) => [r.name, r.place, r.rounded, r.points]),
    [
      ["Sirocco", 1, 3698, 1],
      ["Vaila", 2, 3806, 2],
      ["Fly", 3, 3818, 3],
    ]
  );

  assert.equal(Math.round(scored[0].ladj), 3735, "Sirocco's two laps scaled to three");
  assert.equal(Math.round(scored[1].ladj), 3540);
  assert.equal(Math.round(scored[2].ladj), 3600);

  assert.equal(starters, 4, "three finishers plus one coded boat");
  assert.equal(penalty, 5, "starters + 1");
  assert.deepEqual(out.map((r) => [r.name, r.code, r.points]), [["Kittiwake", "DNF", 5]]);
});

test("the demonstration race is unchanged by personal handicaps of 1.0", () => {
  // The acceptance condition: adding the handicap machinery must not move a
  // single result while every factor is 1.
  const withFactors = DEMONSTRATION.map((b) => ({
    ...b,
    basePy: b.personalPy,
    factor: 1.0,
  }));

  const plain = scoreRace(DEMONSTRATION);
  const factored = scoreRace(withFactors);

  assert.deepEqual(
    factored.scored.map((r) => [r.name, r.place, r.rounded, r.points]),
    plain.scored.map((r) => [r.name, r.place, r.rounded, r.points])
  );
});

test("a personal handicap changes the order, and shows its working", () => {
  // Fly's helm has won twice, so 943 x 0.96 = 905.28 and Fly takes the race.
  const boats = [
    { ...boat("Fly", 905.28, 3600, 3), basePy: 943, factor: 0.96 },
    { ...boat("Vaila", 930, 3540, 3), basePy: 930, factor: 1.0 },
    { ...boat("Sirocco", 1010, 2490, 2), basePy: 1010, factor: 1.0 },
  ];
  const { scored } = scoreRace(boats);

  assert.equal(Math.round((3600 * 3 * 1000) / (905.28 * 3)), 3977);
  assert.deepEqual(scored.map((r) => r.name), ["Sirocco", "Vaila", "Fly"]);
  assert.equal(pyText(scored[2]), "943 × 0.96 = 905", "the sheet explains itself");
});

/* ---- ties --------------------------------------------------------------- */

test("boats tied on the rounded second share the averaged points", () => {
  const boats = [
    boat("Alpha", 1000, 3000, 1),
    boat("Bravo", 1000, 3000, 1),
    boat("Charlie", 1000, 4000, 1),
  ];
  const { scored } = scoreRace(boats);

  assert.deepEqual(scored.map((r) => [r.name, r.place, r.tied, r.points]), [
    ["Alpha", 1, true, 1.5],
    ["Bravo", 1, true, 1.5],
    ["Charlie", 3, false, 3],
  ]);
  assert.equal(placeText(scored[0]), "=1", "the '=' marker");
  assert.equal(placeText(scored[2]), "3");
});

test("ties are decided on the rounded second, not the raw float", () => {
  // 3000.4 and 3000.3 corrected both round to 3000 and therefore tie, which
  // is exactly what the old calculator does. (3000.6 would round to 3001 and
  // beat them both — a tenth of a second decides it, on the rounded value.)
  const boats = [boat("Alpha", 1000, 3000.4, 1), boat("Bravo", 1000, 3000.3, 1)];
  const { scored } = scoreRace(boats);

  assert.notEqual(scored[0].corrected, scored[1].corrected, "not identical underneath");
  assert.equal(scored[0].rounded, scored[1].rounded);
  assert.deepEqual(scored.map((r) => r.points), [1.5, 1.5]);
});

test("three-way ties average across all three places", () => {
  const boats = ["Alpha", "Bravo", "Charlie"].map((n) => boat(n, 1000, 3000, 1));
  const { scored } = scoreRace(boats);
  assert.deepEqual(scored.map((r) => r.points), [2, 2, 2], "(1+2+3)/3");
  assert.deepEqual(scored.map((r) => r.place), [1, 1, 1]);
});

test("a tie further down the fleet still resolves the places above it", () => {
  const boats = [
    boat("Winner", 1000, 2000, 1),
    boat("Alpha", 1000, 3000, 1),
    boat("Bravo", 1000, 3000, 1),
  ];
  const { scored } = scoreRace(boats);
  assert.deepEqual(scored.map((r) => [r.place, r.points]), [
    [1, 1],
    [2, 2.5],
    [2, 2.5],
  ]);
});

/* ---- codes and starters ------------------------------------------------- */

test("every coded boat scores starters + 1", () => {
  const boats = [
    boat("Alpha", 1000, 3000, 1),
    boat("Bravo", 1000, 3100, 1),
    boat("Charlie", 1000, 0, 0, { code: "RET" }),
    boat("Delta", 1000, 0, 0, { code: "DSQ" }),
  ];
  const { out, starters, penalty } = scoreRace(boats);

  assert.equal(starters, 4);
  assert.equal(penalty, 5);
  assert.deepEqual(out.map((r) => [r.name, r.points]), [["Charlie", 5], ["Delta", 5]]);
});

test("a row with no data does not count as a starter", () => {
  // The old calculator kept blank rows on screen; they must not inflate the
  // penalty for boats that genuinely retired.
  const boats = [
    boat("Alpha", 1000, 3000, 1),
    boat("Bravo", 1000, 0, 0, { code: "DNF" }),
    { id: "blank", name: "", personalPy: 0, elapsedSeconds: 0, laps: 0 },
  ];
  const { starters, penalty, out } = scoreRace(boats);

  assert.equal(starters, 2, "one finisher and one coded boat");
  assert.equal(penalty, 3);
  assert.deepEqual(out.map((r) => r.name), ["Bravo"], "the blank row is dropped entirely");
});

test("a code beats missing data as the reason a boat is not scored", () => {
  const { out } = scoreRace([boat("Alpha", 0, 0, 0, { code: "DNS" })]);
  assert.equal(out[0].reason, CODES.DNS);
  assert.equal(out[0].points, 2, "the only starter, so starters + 1");
});

test("boats missing a time, a PY or laps are set aside with a reason", () => {
  const boats = [
    boat("NoTime", 1000, 0, 3),
    boat("NoPy", 0, 3000, 3),
    boat("NoLaps", 1000, 3000, 0),
  ];
  const { scored, out } = scoreRace(boats);
  assert.equal(scored.length, 0);
  assert.deepEqual(out.map((r) => r.reason), ["no elapsed time", "no PY number", "no lap count"]);
  assert.deepEqual(out.map((r) => r.points), [null, null, null], "no points without a code");
});

/* ---- lap adjustment ----------------------------------------------------- */

test("a boat that sailed fewer laps is scaled up to the longest", () => {
  const boats = [boat("Long", 1000, 3600, 3), boat("Short", 1000, 1200, 1)];
  const { scored, maxLaps } = scoreRace(boats);

  assert.equal(maxLaps, 3);
  const short = scored.find((r) => r.name === "Short");
  assert.equal(short.ladj, 3600, "1200 x 3 / 1");
  assert.equal(short.rounded, 3600);
});

test("non-lap mode scores on elapsed alone", () => {
  const boats = [boat("Alpha", 1000, 3600, 3), boat("Bravo", 1000, 1200, 1)];
  const { scored } = scoreRace(boats, { lapMode: false });

  assert.deepEqual(scored.map((r) => r.name), ["Bravo", "Alpha"]);
  assert.equal(scored[0].ladj, 1200, "no scaling");
  assert.equal(scored[0].rounded, 1200);
});

test("without laps recorded, non-lap mode still scores the boat", () => {
  const { scored } = scoreRace([boat("Alpha", 1000, 3600, 0)], { lapMode: false });
  assert.equal(scored.length, 1);
});

test("max laps falls back to 1 when nothing is scorable", () => {
  assert.equal(scoreRace([]).maxLaps, 1);
});

/* ---- behind-leader ------------------------------------------------------ */

test("the gap and the bar fraction are measured from the leader", () => {
  const boats = [
    boat("Alpha", 1000, 3000, 1),
    boat("Bravo", 1000, 3300, 1),
    boat("Charlie", 1000, 3600, 1),
  ];
  const { scored } = scoreRace(boats);

  assert.deepEqual(scored.map((r) => r.gap), [0, 300, 600]);
  assert.deepEqual(scored.map((r) => r.frac), [0, 0.5, 1]);
  assert.equal(gapText(scored[0].gap), "leader");
  assert.equal(gapText(scored[1].gap), "+5:00");
});

test("a single boat has no spread to draw", () => {
  const { scored } = scoreRace([boat("Alone", 1000, 3000, 1)]);
  assert.equal(scored[0].frac, 0);
  assert.equal(gapText(scored[0].gap), "leader");
});

/* ---- formatting --------------------------------------------------------- */

test("points print whole where whole, one decimal where shared", () => {
  assert.equal(formatPoints(3), "3");
  assert.equal(formatPoints(3.5), "3.5");
  assert.equal(formatPoints(null), "—");
});

test("times print as the calculator prints them", () => {
  assert.equal(hms(3600), "1:00:00");
  assert.equal(hms(3817.6), "1:03:38");
  assert.equal(hms(0), "0:00:00");
});

test("the PY column shows its working only when a factor applies", () => {
  assert.equal(pyText({ py: 1088.34, basePy: 1122, factor: 0.97 }), "1122 × 0.97 = 1088");
  assert.equal(pyText({ py: 1122, basePy: 1122, factor: 1 }), "1122");
  assert.equal(pyText({ py: 943, basePy: null, factor: null }), "943");
});

test("the codes and their order are the calculator's", () => {
  assert.deepEqual(CODE_ORDER, ["DNC", "DNS", "OCS", "DNF", "RET", "DSQ"]);
  assert.equal(CODES.OCS, "on the course side at the start");
});

/* ---- sorting ------------------------------------------------------------ */

test("boats level on corrected time are ordered by name", () => {
  const boats = [boat("Zulu", 1000, 3000, 1), boat("Alpha", 1000, 3000, 1)];
  const { scored } = scoreRace(boats);
  assert.deepEqual(scored.map((r) => r.name), ["Alpha", "Zulu"]);
});
