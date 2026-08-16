/* The fast clock, end to end — and the start_at bug it exposed.
 *
 * The bug: sequenceState().startAt is the gun on the COUNTDOWN's clock, which
 * the dev fast clock compresses. The old startRacing() wrote that value
 * straight into races.start_at as though it were wall clock. At 60x the
 * sequence really takes ten seconds, so start_at landed ~590 real seconds in
 * the FUTURE, every elapsed time came out negative, scoring.js quite correctly
 * refused to score a single boat, and "Publish results" greyed out with no
 * explanation.
 *
 * These tests drive the real pure functions the pages call. Nothing here
 * simulates the fix — wallClockAt() is the same function sequence.js uses.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  SEQUENCE_MS,
  sequenceState,
  countdown,
  scaledNow,
  wallClockAt,
  raceState,
  raceClock,
  resultInputs,
  implausibleElapsed,
  MAX_PLAUSIBLE_ELAPSED_SECONDS,
  startTimeCheck,
} from "../js/state.js";
import { scoreRace } from "../js/scoring.js";

const T0 = Date.parse("2026-08-16T13:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

let seq = 0;
const event = (type, at, extra = {}) => ({
  id: `e${++seq}`,
  race_id: "r1",
  entry_id: null,
  type,
  payload: null,
  occurred_at: iso(at),
  ...extra,
});

const RACE = { id: "r1", number: 1, fast_laps: 3, slow_laps: 2, status: "racing" };
const ENTRY = {
  id: "en1",
  race_id: "r1",
  class_id: "c1",
  helm_id: "h1",
  personal_py: 1122,
  base_py: 1122,
  handicap_factor: 1,
  fleet: "fast",
};

/**
 * The gun, exactly as sequence.js computes it: the wall-clock instant the
 * countdown crosses zero.
 */
function gunAt(events, speed) {
  const sequence = sequenceState(events);
  return wallClockAt({ anchor: sequence.startedAt, scaled: sequence.startAt, speed });
}

/* ---- scaledNow and wallClockAt are exact inverses ----------------------- */

test("wallClockAt undoes scaledNow at every speed", () => {
  for (const speed of [1, 10, 60]) {
    for (const offset of [0, 1, 250, 9_999, 600_000]) {
      const scaled = scaledNow({ anchor: T0, now: T0 + offset, speed });
      assert.equal(
        wallClockAt({ anchor: T0, scaled, speed }),
        T0 + offset,
        `speed ${speed}, offset ${offset}`
      );
    }
  }
});

test("with no sequence running there is nothing to invert", () => {
  assert.equal(wallClockAt({ anchor: null, scaled: T0, speed: 60 }), T0);
  assert.equal(wallClockAt({ anchor: T0, scaled: null, speed: 60 }), null);
});

/* ---- start_at is the zero-crossing moment, at any speed ----------------- */

test("at 1x the gun is ten minutes after the tap, to the millisecond", () => {
  const events = [event("sequence_started", T0)];
  assert.equal(gunAt(events, 1), T0 + SEQUENCE_MS);
});

test("at 60x the gun is ten REAL seconds after the tap", () => {
  const events = [event("sequence_started", T0)];
  assert.equal(gunAt(events, 60), T0 + 10_000);
  assert.equal(SEQUENCE_MS / 60, 10_000);
});

test("at 10x the gun is one real minute after the tap", () => {
  const events = [event("sequence_started", T0)];
  assert.equal(gunAt(events, 10), T0 + 60_000);
});

test("the recorded gun is the moment the countdown actually calls zero", () => {
  // Tick the real countdown loop and note when it first reports started,
  // then check the recorded gun agrees to within one tick.
  for (const speed of [1, 60]) {
    const events = [event("sequence_started", T0)];
    const sequence = sequenceState(events);
    let firstStartedAt = null;

    for (let real = 0; real <= SEQUENCE_MS / speed + 1000; real += 250) {
      const clock = countdown(
        sequence.startAt,
        scaledNow({ anchor: sequence.startedAt, now: T0 + real, speed })
      );
      if (clock.started) {
        firstStartedAt = T0 + real;
        break;
      }
    }

    const recorded = gunAt(events, speed);
    assert.ok(firstStartedAt != null, `speed ${speed}: countdown never started`);
    assert.ok(
      firstStartedAt - recorded >= 0 && firstStartedAt - recorded < 250,
      `speed ${speed}: recorded ${recorded}, detected ${firstStartedAt}`
    );
  }
});

test("the recorded gun is exact even if the phone sleeps through it", () => {
  // Nothing observes the crossing; the value is computed, not sampled.
  const events = [event("sequence_started", T0)];
  assert.equal(gunAt(events, 60), T0 + 10_000, "still exact after a long sleep");
});

/* ---- postpone and general recall ---------------------------------------- */

test("postpone then restart guns from the RESTART, not the first tap", () => {
  const events = [
    event("sequence_started", T0),
    event("postponed", T0 + 120_000),
    event("sequence_started", T0 + 300_000),
  ];
  assert.equal(gunAt(events, 1), T0 + 300_000 + SEQUENCE_MS);
  assert.equal(gunAt(events, 60), T0 + 300_000 + 10_000);
});

test("a postponed sequence has no gun at all until it is restarted", () => {
  const events = [event("sequence_started", T0), event("postponed", T0 + 120_000)];
  const sequence = sequenceState(events);
  assert.equal(sequence.running, false);
  assert.equal(sequence.postponed, true);
  assert.equal(gunAt(events, 60), null);
});

test("a general recall restarts the ten minutes from the recall", () => {
  const events = [
    event("sequence_started", T0),
    event("general_recall", T0 + 400_000),
  ];
  assert.equal(gunAt(events, 1), T0 + 400_000 + SEQUENCE_MS);
  assert.equal(gunAt(events, 60), T0 + 400_000 + 10_000);
});

test("sequence_start_at is the arming moment, not the gun minus ten minutes", () => {
  /* Those coincide only at 1x with no recall. Relying on the coincidence is
     what let the original bug through. */
  const events = [event("sequence_started", T0), event("general_recall", T0 + 400_000)];
  const sequence = sequenceState(events);
  assert.equal(sequence.startedAt, T0 + 400_000);
  assert.notEqual(sequence.startedAt, gunAt(events, 60) - SEQUENCE_MS);
});

/* ---- a whole 60x race, sequence through laps to finish ------------------ */

/** A complete race run on the fast clock, in real wall-clock milliseconds. */
function fastRace({ speed = 60 } = {}) {
  const events = [event("sequence_started", T0)];
  const gun = gunAt(events, speed);

  // Three laps and a finish, at scaled 10/20/30/40 minutes — which at 60x is
  // real 10/20/30/40 seconds after the gun.
  const atScaledMinutes = (mins) => gun + (mins * 60_000) / speed;
  events.push(
    event("lap_recorded", atScaledMinutes(10), { entry_id: ENTRY.id }),
    event("lap_recorded", atScaledMinutes(20), { entry_id: ENTRY.id }),
    event("lap_recorded", atScaledMinutes(30), { entry_id: ENTRY.id }),
    event("boat_finished", atScaledMinutes(40), { entry_id: ENTRY.id })
  );
  return { events, gun, race: { ...RACE, start_at: iso(gun) } };
}

test("a 60x race runs from sequence to finish in well under a minute", () => {
  const { events, gun } = fastRace();
  const last = Math.max(...events.map((e) => Date.parse(e.occurred_at)));
  assert.ok(last - T0 < 60_000, `whole race took ${(last - T0) / 1000}s of real time`);
  assert.equal(gun - T0, 10_000, "and the sequence was ten of those seconds");
});

test("the live page shows a 60x race at its scaled times, not its real ones", () => {
  const { events, race, gun } = fastRace();
  const state = raceState({ race, entries: [ENTRY], events, speed: 60 });
  const boat = state.boats[0];

  assert.deepEqual(
    boat.splits.map((s) => s.ms),
    [600_000, 1_200_000, 1_800_000, 2_400_000],
    "L1 10:00, L2 20:00, L3 30:00, F 40:00 — what the OOD watched"
  );
  assert.equal(boat.elapsedMs, 2_400_000);

  // And the clock agrees, forty scaled minutes after the gun.
  const realNow = gun + 40_000;
  assert.equal(
    raceClock(state.startAt, scaledNow({ anchor: state.startAt, now: realNow, speed: 60 })),
    "40:00"
  );
});

test("the same race at 1x display shows its real, short times", () => {
  const { events, race } = fastRace();
  const state = raceState({ race, entries: [ENTRY], events, speed: 1 });
  assert.deepEqual(
    state.boats[0].splits.map((s) => s.ms),
    [10_000, 20_000, 30_000, 40_000],
    "the log is forty real seconds long, and says so"
  );
});

test("every elapsed time in a 60x race is positive — the bug is gone", () => {
  const { events, race } = fastRace();
  const rows = resultInputs({ race, entries: [ENTRY], events });
  for (const row of rows) {
    assert.ok(row.elapsedSeconds > 0, `elapsed was ${row.elapsedSeconds}`);
    assert.equal(row.implausible, null);
  }
});

test("a 60x race scores, so publish is available", () => {
  const { events, race } = fastRace();
  const rows = resultInputs({ race, entries: [ENTRY], events }).map((r) => ({
    ...r,
    name: "Hamish Fowler",
    py: r.personalPy,
  }));
  const results = scoreRace(rows);
  assert.equal(results.scored.length, 1, "the boat scored");
  assert.equal(results.out.length, 0);
});

/* ---- the old bug, pinned so it cannot come back ------------------------- */

test("writing the SCALED gun would put every boat before the start", () => {
  /* This is the old behaviour, reproduced deliberately: start_at set to
     sequenceState().startAt rather than the wall-clock crossing. */
  const { events } = fastRace();
  const sequence = sequenceState(events);
  const buggyRace = { ...RACE, start_at: iso(sequence.startAt) };

  const rows = resultInputs({ race: buggyRace, entries: [ENTRY], events });
  assert.ok(rows[0].elapsedSeconds < 0, "negative, exactly as reported");
  assert.match(rows[0].implausible, /before the start/);

  const results = scoreRace(rows.map((r) => ({ ...r, name: "Hamish Fowler", py: r.personalPy })));
  assert.equal(results.scored.length, 0, "nothing scores");
  assert.equal(results.out[0].reason, "no elapsed time", "which is why publish was dead");
});

/* ---- results are real, deliberately ------------------------------------- */

test("results are computed from real stored time even at 60x", () => {
  const { events, race } = fastRace();

  const asDisplayed = raceState({ race, entries: [ENTRY], events, speed: 60 }).boats[0];
  const asScored = resultInputs({ race, entries: [ENTRY], events })[0];

  assert.equal(asDisplayed.elapsedMs, 2_400_000, "the OOD watched forty minutes");
  assert.equal(asScored.elapsedSeconds, 40, "the sheet records forty seconds");
  assert.notEqual(asDisplayed.elapsedMs / 1000, asScored.elapsedSeconds);
});

test("resultInputs takes no speed at all — there is no way to scale a result", () => {
  const { events, race } = fastRace();
  const a = resultInputs({ race, entries: [ENTRY], events });
  const b = resultInputs({ race, entries: [ENTRY], events, speed: 60 });
  assert.deepEqual(
    a.map((r) => r.elapsedSeconds),
    b.map((r) => r.elapsedSeconds),
    "an accidentally-passed speed changes nothing"
  );
});

/* ---- the implausible-time guard ----------------------------------------- */

test("a negative elapsed time is named, not hidden", () => {
  assert.match(implausibleElapsed({ elapsedSeconds: -530 }), /before the start/);
});

test("zero is implausible for a boat that finished", () => {
  assert.match(implausibleElapsed({ elapsedSeconds: 0 }), /no time between/);
});

test("an absurdly long race is implausible too", () => {
  assert.match(
    implausibleElapsed({ elapsedSeconds: MAX_PLAUSIBLE_ELAPSED_SECONDS + 1 }),
    /cannot be right/
  );
  assert.equal(implausibleElapsed({ elapsedSeconds: 3 * 3600 }), null, "three hours is a long race, not a broken one");
});

test("a coded boat has no time to be wrong about", () => {
  assert.equal(implausibleElapsed({ elapsedSeconds: -530, code: "RET" }), null);
  assert.equal(implausibleElapsed({ elapsedSeconds: 0, code: "DNF" }), null);
});

test("a boat still racing is not flagged", () => {
  assert.equal(implausibleElapsed({ elapsedSeconds: 0, finished: false }), null);
});

test("an ordinary finish is not flagged", () => {
  assert.equal(implausibleElapsed({ elapsedSeconds: 2700 }), null);
});

/* ---- the two race timestamps must agree ---------------------------------
 *
 * A systematic start-time error shifts every boat by the same amount, so
 * every elapsed time still looks like an ordinary race and implausibleElapsed
 * sees nothing wrong. This is the check that catches it.
 */

const SEQ_START = T0;
const GUN = T0 + SEQUENCE_MS;
const goodRace = {
  ...RACE,
  sequence_start_at: iso(SEQ_START),
  start_at: iso(GUN),
};
const goodEvents = [event("sequence_started", SEQ_START)];

test("a normal race passes the check", () => {
  assert.equal(startTimeCheck({ race: goodRace, events: goodEvents }), null);
});

test("a race that has not started is not an inconsistency", () => {
  assert.equal(startTimeCheck({ race: { ...RACE, start_at: null }, events: [] }), null);
});

test("a missing sequence start is flagged", () => {
  const check = startTimeCheck({
    race: { ...goodRace, sequence_start_at: null },
    events: goodEvents,
  });
  assert.match(check.problem, /sequence start time is missing/);
});

test("a gun recorded before its own sequence is flagged", () => {
  const check = startTimeCheck({
    race: { ...goodRace, start_at: iso(SEQ_START - 60_000) },
    events: goodEvents,
  });
  assert.match(check.problem, /before the sequence started/);
});

test("a gap that is not ten minutes is flagged, with the size of the error", () => {
  // start_at four minutes late: every boat's elapsed time is four minutes short.
  const check = startTimeCheck({
    race: { ...goodRace, start_at: iso(GUN + 4 * 60_000) },
    events: goodEvents,
  });
  assert.match(check.problem, /do not agree/);
  assert.match(check.detail, /4:00/, "says how far out it is");
  assert.match(check.detail, /same amount/);
});

test("both columns shifted together are still caught, via the log", () => {
  /* This is the case the gap check cannot see: the two timestamps agree
     perfectly with each other and disagree with what actually happened. */
  const shift = 7 * 60_000;
  const check = startTimeCheck({
    race: {
      ...goodRace,
      sequence_start_at: iso(SEQ_START + shift),
      start_at: iso(GUN + shift),
    },
    events: goodEvents,
  });
  assert.match(check.problem, /do not match the event log/);
  assert.match(check.detail, /7:00/);
});

test("a per-boat check would have missed a systematic shift entirely", () => {
  // The point of the whole exercise: every time still looks perfectly normal.
  const shift = 7 * 60_000;
  const { events, gun } = fastRace({ speed: 1 });
  const shifted = {
    ...RACE,
    sequence_start_at: iso(gun - SEQUENCE_MS + shift),
    start_at: iso(gun + shift),
  };
  const rows = resultInputs({ race: shifted, entries: [ENTRY], events });
  assert.equal(rows[0].implausible, null, "nothing wrong per boat");
  assert.ok(startTimeCheck({ race: shifted, events }), "but the race-level check fires");
});

test("a small discrepancy inside tolerance is not nagged about", () => {
  assert.equal(
    startTimeCheck({ race: { ...goodRace, start_at: iso(GUN + 800) }, events: goodEvents }),
    null
  );
});

test("a postponement re-anchors both the log and the check", () => {
  const restart = T0 + 300_000;
  const events = [
    event("sequence_started", T0),
    event("postponed", T0 + 120_000),
    event("sequence_started", restart),
  ];
  const race = {
    ...RACE,
    sequence_start_at: iso(restart),
    start_at: iso(restart + SEQUENCE_MS),
  };
  assert.equal(startTimeCheck({ race, events }), null, "the restart is the anchor");

  // And the ORIGINAL tap is now wrong, because it is not the anchor any more.
  const stale = { ...race, sequence_start_at: iso(T0), start_at: iso(T0 + SEQUENCE_MS) };
  assert.ok(startTimeCheck({ race: stale, events }), "the pre-postponement times are flagged");
});

test("a general recall re-anchors the check too", () => {
  const recall = T0 + 400_000;
  const events = [event("sequence_started", T0), event("general_recall", recall)];
  const race = {
    ...RACE,
    sequence_start_at: iso(recall),
    start_at: iso(recall + SEQUENCE_MS),
  };
  assert.equal(startTimeCheck({ race, events }), null);
});

test("a compressed sequence passes only when it is allowed", () => {
  const race = {
    ...RACE,
    sequence_start_at: iso(SEQ_START),
    start_at: iso(SEQ_START + 10_000), // 60x
  };
  assert.ok(
    startTimeCheck({ race, events: goodEvents }),
    "a real race day gets no latitude for a ten-second sequence"
  );
  assert.equal(
    startTimeCheck({
      race,
      events: goodEvents,
      allowedSequenceMs: [SEQUENCE_MS, SEQUENCE_MS / 10, SEQUENCE_MS / 60],
    }),
    null,
    "a day already branded test data does"
  );
});
