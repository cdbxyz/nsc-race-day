/* The handicap engine.
 *
 * This decides how fairly the club races, so it gets pinned down hard. The
 * worked example from ARCHITECTURE.md is here as a golden case.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  FLEET_BOUNDARY,
  factorFor,
  fleetFor,
  personalPy,
  lapsFor,
  winsForHelm,
  entrySnapshot,
  seasonFor,
} from "../js/handicap.js";

/* ---- factorFor ---------------------------------------------------------- */

test("the factor ladder, including the boundaries that matter", () => {
  assert.equal(factorFor(0), 1.0, "no wins, no penalty");
  assert.equal(factorFor(1), 0.97);
  assert.equal(factorFor(2), 0.96);
  assert.equal(factorFor(3), 0.95);
});

test("the factor is capped at three wins", () => {
  // A good season should not compound indefinitely.
  assert.equal(factorFor(4), 0.95);
  assert.equal(factorFor(7), 0.95);
  assert.equal(factorFor(30), 0.95);
});

test("nonsense win counts fall back to no adjustment", () => {
  for (const value of [-1, null, undefined, NaN, "", "abc"]) {
    assert.equal(factorFor(value), 1.0, String(value));
  }
});

/* ---- fleetFor ----------------------------------------------------------- */

test("the fleet boundary is exclusive: 1168 sails slow", () => {
  assert.equal(fleetFor(1167), "fast");
  assert.equal(fleetFor(FLEET_BOUNDARY), "slow", "1168 itself is slow");
  assert.equal(fleetFor(1169), "slow");
});

test("typical club boats land in the right fleet", () => {
  assert.equal(fleetFor(1122), "fast", "Laser 2000");
  assert.equal(fleetFor(1100), "fast", "Wayfarer");
  assert.equal(fleetFor(1345), "slow", "Heron");
});

/* ---- personalPy --------------------------------------------------------- */

test("the Hamish example from the spec", () => {
  // "Hamish · Laser 2000 · 1122 × 0.97 = 1088 (1 win) · Fast, 3 laps"
  const factor = factorFor(1);
  const py = personalPy(1122, factor);

  assert.equal(factor, 0.97);
  assert.equal(py, 1088.34, "stored exact");
  assert.equal(Math.round(py), 1088, "displayed as 1088");
  assert.equal(fleetFor(1122), "fast");
  assert.equal(lapsFor({ fleet: "fast", fastLaps: 3, slowLaps: 2 }), 3);
});

test("the worked example from ARCHITECTURE section 4", () => {
  // "Vaila, PY 930 × 0.97 = 902.1"
  assert.equal(personalPy(930, 0.97), 902.1);
});

test("personal PY is not silently rounded to a whole number", () => {
  // Rounding here would shift every corrected time computed from it.
  assert.notEqual(personalPy(1122, 0.97), 1088);
});

test("float noise is kept out of stored values", () => {
  // 1122 * 0.97 is 1088.3400000000001 in raw floating point.
  assert.equal(personalPy(1122, 0.97), 1088.34);
  assert.equal(personalPy(1345, 0.96), 1291.2);
});

test("a factor of 1.0 leaves the base PY alone", () => {
  assert.equal(personalPy(1168, 1.0), 1168);
});

/* ---- lapsFor ------------------------------------------------------------ */

test("laps come from the fleet plan unless the boat overrides", () => {
  const plan = { fastLaps: 3, slowLaps: 2 };
  assert.equal(lapsFor({ fleet: "fast", ...plan }), 3);
  assert.equal(lapsFor({ fleet: "slow", ...plan }), 2);
  assert.equal(lapsFor({ fleet: "fast", lapsOverride: 1, ...plan }), 1, "override wins");
});

test("a zero-lap override is honoured, not treated as absent", () => {
  assert.equal(lapsFor({ fleet: "fast", lapsOverride: 0, fastLaps: 3 }), 0);
});

test("a shortened course changes the lap plan", () => {
  assert.equal(lapsFor({ fleet: "fast", fastLaps: 2, slowLaps: 1 }), 2);
  assert.equal(lapsFor({ fleet: "slow", fastLaps: 2, slowLaps: 1 }), 1);
});

/* ---- winsForHelm -------------------------------------------------------- */

const HAMISH = "helm-hamish";
const CHRIS = "helm-chris";

test("wins come from the cached view", () => {
  const cache = [
    { helm_id: HAMISH, season: 2026, wins: 2 },
    { helm_id: CHRIS, season: 2026, wins: 1 },
  ];
  assert.equal(winsForHelm(HAMISH, 2026, cache), 2);
  assert.equal(winsForHelm(CHRIS, 2026, cache), 1);
  assert.equal(winsForHelm("helm-nobody", 2026, cache), 0);
});

test("wins are counted per season, not across the club's history", () => {
  const cache = [
    { helm_id: HAMISH, season: 2025, wins: 5 },
    { helm_id: HAMISH, season: 2026, wins: 1 },
  ];
  assert.equal(winsForHelm(HAMISH, 2026, cache), 1, "last season does not follow you");
  assert.equal(winsForHelm(HAMISH, 2025, cache), 5);
});

test("a win published on this device today stacks on the cached total", () => {
  // The confirmed same-day rule: win Race 1, carry the lower factor into
  // Race 2 that afternoon — with no signal all day.
  const cache = [{ helm_id: HAMISH, season: 2026, wins: 1 }];
  const localWins = [
    { helm_id: HAMISH, season: 2026, published_at: "2026-08-15T13:40:00Z" },
  ];

  const wins = winsForHelm(HAMISH, 2026, cache, localWins, {
    cachedAt: "2026-08-15T09:00:00Z",
  });

  assert.equal(wins, 2);
  assert.equal(factorFor(wins), 0.96, "Race 2 factor drops");
});

test("a local win already included in the cache is not counted twice", () => {
  // The race was published this morning and the cache was refreshed after it.
  const cache = [{ helm_id: HAMISH, season: 2026, wins: 1 }];
  const localWins = [
    { helm_id: HAMISH, season: 2026, published_at: "2026-08-15T09:00:00Z" },
  ];

  const wins = winsForHelm(HAMISH, 2026, cache, localWins, {
    cachedAt: "2026-08-15T10:00:00Z",
  });

  assert.equal(wins, 1, "the cache already knows about it");
});

test("with no cache refresh ever, every local win counts", () => {
  const localWins = [
    { helm_id: HAMISH, season: 2026, published_at: "2026-08-15T13:40:00Z" },
    { helm_id: HAMISH, season: 2026, published_at: "2026-08-15T15:20:00Z" },
  ];
  assert.equal(winsForHelm(HAMISH, 2026, [], localWins, { cachedAt: null }), 2);
});

test("two wins in one day stack all the way down the ladder", () => {
  const localWins = [
    { helm_id: HAMISH, season: 2026, published_at: "2026-08-15T13:40:00Z" },
    { helm_id: HAMISH, season: 2026, published_at: "2026-08-15T15:20:00Z" },
    { helm_id: HAMISH, season: 2026, published_at: "2026-08-15T16:50:00Z" },
  ];
  const wins = winsForHelm(HAMISH, 2026, [], localWins);
  assert.equal(wins, 3);
  assert.equal(factorFor(wins), 0.95);
});

test("another helm's local win does not affect this one", () => {
  const localWins = [{ helm_id: CHRIS, season: 2026, published_at: "2026-08-15T13:40:00Z" }];
  assert.equal(winsForHelm(HAMISH, 2026, [], localWins), 0);
});

test("a local win in another season is ignored", () => {
  const localWins = [{ helm_id: HAMISH, season: 2025, published_at: "2025-08-15T13:40:00Z" }];
  assert.equal(winsForHelm(HAMISH, 2026, [], localWins), 0);
});

test("no helm means no wins", () => {
  assert.equal(winsForHelm(null, 2026, [{ helm_id: null, season: 2026, wins: 3 }]), 0);
});

/* ---- entrySnapshot ------------------------------------------------------ */

test("a snapshot ties the factor, PY and fleet together", () => {
  const snap = entrySnapshot({ basePy: 1122, wins: 1 });
  assert.deepEqual(snap, {
    base_py: 1122,
    handicap_factor: 0.97,
    personal_py: 1088.34,
    fleet: "fast",
    wins: 1,
  });
});

test("a committee override replaces the computed factor and is reflected in the PY", () => {
  const snap = entrySnapshot({ basePy: 1122, wins: 3, factorOverride: 1.0 });
  assert.equal(snap.handicap_factor, 1.0);
  assert.equal(snap.personal_py, 1122);
  assert.equal(snap.wins, 3, "the win count is still recorded");
});

test("a boat on the boundary snapshots into the slow fleet", () => {
  assert.equal(entrySnapshot({ basePy: 1168, wins: 0 }).fleet, "slow");
});

/* ---- seasonFor ---------------------------------------------------------- */

test("the season comes from the series when there is one", () => {
  assert.equal(seasonFor({ seriesSeason: 2026, raceDate: "2027-01-04" }), 2026);
});

test("without a series the season is the year it was sailed", () => {
  assert.equal(seasonFor({ seriesSeason: null, raceDate: "2026-08-15" }), 2026);
});
