/* devclock.js — a fast clock for testing the start sequence.
 *
 * A ten-minute sequence is a long time to wait when you are checking that the
 * P flag comes down at the right moment. This compresses it: at 60x a whole
 * sequence runs in ten seconds.
 *
 * Two things it deliberately does NOT do.
 *
 * It is not a second code path. The multiplier is fed into the same pure
 * timing functions the app ships — countdown(), phaseFor(), marksCrossed() —
 * by scaling the clock they are handed. What you test is what races.
 *
 * It does not touch stored timestamps. Every occurred_at written to the event
 * log is real wall clock, because a log with invented times in it is worse
 * than no log. Only the reading of the clock is compressed, never the record.
 *
 * In memory only: a reload is always back to 1x, so a fast clock cannot
 * follow anyone to a real race day.
 */

export const SPEEDS = [1, 10, 60];

let speed = 1;
const listeners = new Set();

export function sequenceSpeed() {
  return speed;
}

/** True when the clock is compressed, which makes a race test data. */
export function isFastClock() {
  return speed !== 1;
}

export function setSequenceSpeed(next) {
  const chosen = SPEEDS.includes(Number(next)) ? Number(next) : 1;
  if (chosen === speed) return speed;
  speed = chosen;
  for (const fn of listeners) {
    try {
      fn(speed);
    } catch (err) {
      console.error("speed listener failed", err);
    }
  }
  return speed;
}

export function onSpeedChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
