/* The dev fast clock.
 *
 * The point of it is that it is NOT a second code path: the multiplier is fed
 * into the same countdown(), phaseFor() and marksCrossed() the app ships, by
 * scaling the clock they are handed. These tests therefore drive the real
 * timing functions and only vary the speed.
 */

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  SEQUENCE_MS,
  MARKS,
  scaledNow,
  countdown,
  marksCrossed,
  phaseFor,
} from "../js/state.js";
import {
  SPEEDS,
  sequenceSpeed,
  setSequenceSpeed,
  isFastClock,
  onSpeedChange,
} from "../js/devclock.js";

const T0 = Date.parse("2026-08-16T13:00:00Z");
const START_AT = T0 + SEQUENCE_MS;

beforeEach(() => setSequenceSpeed(1));

/* ---- the multiplier itself --------------------------------------------- */

test("at 1x the clock is untouched", () => {
  assert.equal(scaledNow({ anchor: T0, now: T0 + 5_000, speed: 1 }), T0 + 5_000);
});

test("elapsed time is multiplied, the anchor never moves", () => {
  // Ten real seconds at 60x is ten sequence minutes.
  assert.equal(scaledNow({ anchor: T0, now: T0 + 10_000, speed: 60 }), T0 + 600_000);
  assert.equal(scaledNow({ anchor: T0, now: T0, speed: 60 }), T0, "the start is the start");
});

test("with no sequence running there is nothing to scale", () => {
  assert.equal(scaledNow({ anchor: null, now: T0 + 5_000, speed: 60 }), T0 + 5_000);
});

test("a nonsense speed falls back to real time", () => {
  assert.equal(scaledNow({ anchor: T0, now: T0 + 5_000, speed: NaN }), T0 + 5_000);
});

/* ---- a compressed sequence hits every mark ----------------------------- */

/** Run a sequence tick by tick, exactly as the page does, and collect marks. */
function runSequence({ speed, tickMs = 250 }) {
  const seen = [];
  // Seeded just above 10:00, exactly as the page does when Start is tapped,
  // so the class-flag mark is crossed on the first reading.
  let previous = SEQUENCE_MS / 1000 + 1;
  const realDuration = SEQUENCE_MS / speed;

  for (let elapsed = 0; elapsed <= realDuration + tickMs; elapsed += tickMs) {
    const clock = countdown(
      START_AT,
      scaledNow({ anchor: T0, now: T0 + elapsed, speed })
    );
    for (const mark of marksCrossed(previous, clock.remainingSeconds)) seen.push(mark.short);
    previous = clock.remainingSeconds;
  }
  return seen;
}

test("a 60x sequence hits all four marks, in order, inside ten seconds", () => {
  const seen = runSequence({ speed: 60 });
  assert.deepEqual(seen, ["10:00", "5:00", "1:00", "0:00"]);
  assert.equal(SEQUENCE_MS / 60, 10_000, "ten real seconds");
});

test("a 10x sequence hits all four marks too", () => {
  assert.deepEqual(runSequence({ speed: 10 }), ["10:00", "5:00", "1:00", "0:00"]);
});

test("real time hits the same four marks — the compressed run is not special", () => {
  // The same code, the same marks, only slower. Coarse ticks to keep it quick.
  assert.deepEqual(runSequence({ speed: 1, tickMs: 1000 }), ["10:00", "5:00", "1:00", "0:00"]);
});

test("no mark is ever reported twice, however coarse the tick", () => {
  // At 60x a 250ms tick advances 15 sequence seconds, so marks are jumped
  // over rather than landed on — the same case as a sleeping phone.
  const seen = runSequence({ speed: 60, tickMs: 250 });
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual(seen, MARKS.map((m) => m.short));
});

test("the flag states are the real ones throughout a compressed sequence", () => {
  const at = (realSeconds) =>
    phaseFor(
      countdown(START_AT, scaledNow({ anchor: T0, now: T0 + realSeconds * 1000, speed: 60 }))
        .remainingSeconds
    ).label;

  assert.equal(at(0), "Class flag up");
  assert.equal(at(5.5), "P flag up", "half way through ten seconds is half way through ten minutes");
  assert.equal(at(9.5), "P flag down");
  assert.equal(at(10.5), "START");
});

test("the gun still falls at the real ten-minute mark of sequence time", () => {
  const clock = countdown(START_AT, scaledNow({ anchor: T0, now: T0 + 10_000, speed: 60 }));
  assert.equal(clock.started, true);
  assert.equal(clock.display, "0:00");
});

/* ---- the control ------------------------------------------------------- */

test("a fresh load is always real time", () => {
  // Module state, never persisted — this is what a reload restores.
  assert.equal(sequenceSpeed(), 1);
  assert.equal(isFastClock(), false);
});

test("only the offered speeds are accepted", () => {
  assert.deepEqual(SPEEDS, [1, 10, 60]);
  setSequenceSpeed(60);
  assert.equal(sequenceSpeed(), 60);

  setSequenceSpeed(7);
  assert.equal(sequenceSpeed(), 1, "anything else falls back to real time");
});

test("a compressed clock marks races as test data", () => {
  setSequenceSpeed(1);
  assert.equal(isFastClock(), false, "1x races are real");
  setSequenceSpeed(10);
  assert.equal(isFastClock(), true);
  setSequenceSpeed(60);
  assert.equal(isFastClock(), true);
});

test("the speed is nowhere near any persistent store", async () => {
  // The guarantee behind "resets on reload": nothing writes it down.
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../js/devclock.js", import.meta.url), "utf8")
  );
  assert.ok(!/localStorage|sessionStorage|indexedDB|localWrite|setMeta/.test(source));
});

test("subscribers are told when the speed changes", () => {
  const seen = [];
  const off = onSpeedChange((s) => seen.push(s));

  setSequenceSpeed(60);
  setSequenceSpeed(60); // no change, no notification
  setSequenceSpeed(1);

  assert.deepEqual(seen, [60, 1]);
  off();
  setSequenceSpeed(10);
  assert.deepEqual(seen, [60, 1], "unsubscribed");
});
