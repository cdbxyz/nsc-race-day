/* devmode.js — is this a real race day, or a rehearsal?
 *
 * The dev panel can put the app into states that look completely normal and
 * are not. The dangerous one is the sync destination: pointed at the fake
 * backend, every tap still commits to IndexedDB, the outbox still drains, and
 * the sync pill still says "All synced" — while nothing whatsoever reaches
 * the club's database. A whole race day could be run and lost that way, and
 * nobody would find out until someone went looking for the results.
 *
 * So non-production state is not allowed to be quiet. Two guarantees:
 *
 *   1. It is IMPOSSIBLE TO MISS. Every active mode paints a banner in the app
 *      shell — above every page, including the live race and the results
 *      sheet — and it cannot be dismissed.
 *
 *   2. It CANNOT SURVIVE A RELOAD. Every mode here lives in module memory and
 *      nothing writes it down. Reloading the app is always, unconditionally,
 *      a return to production. tests/devmode.test.js asserts that no storage
 *      API appears in any of the modules involved.
 *
 * This module owns neither piece of state — the destination belongs to
 * sync.js and the clock to devclock.js. It exists so that "are we in a real
 * race day?" has exactly one answer, and so that adding a third dev mode
 * means adding it here rather than remembering to paint another banner.
 */

import { sync, onBackendChange } from "./sync.js";
import { isFastClock, sequenceSpeed, onSpeedChange } from "./devclock.js";

const listeners = new Set();

/**
 * Every non-production mode currently active.
 *
 * @returns {Array<{id: string, label: string, detail: string}>}
 */
export function activeModes() {
  const modes = [];

  if (sync.stats().backend !== "supabase") {
    modes.push({
      id: "backend",
      label: "TEST MODE — records are not reaching the club database",
      detail:
        "The sync destination is the fake backend. Everything recorded here is being thrown away. Reload the app to return to the real database.",
    });
  }

  if (isFastClock()) {
    modes.push({
      id: "clock",
      label: `FAST CLOCK ${sequenceSpeed()}× — this is not a real race`,
      detail:
        "The sequence and race clock are compressed. Any race started now is permanently marked as test data. Reload to return to real time.",
    });
  }

  return modes;
}

/** True when the app is in a state whose records count. */
export function isProduction() {
  return activeModes().length === 0;
}

/**
 * Whether a race day started right now would be real.
 *
 * Used at race-day creation and at the start of every sequence, so a day is
 * branded as test data by the same rule however it got that way — a fast
 * clock or a fake destination. A branded day never records local wins, so a
 * rehearsal cannot move anybody's handicap.
 */
export function wouldBeTestData() {
  return !isProduction();
}

export function onModeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce() {
  const modes = activeModes();
  for (const fn of listeners) {
    try {
      fn(modes);
    } catch (err) {
      console.error("dev mode listener failed", err);
    }
  }
}

// Both sources push here, so a subscriber never has to know there are two.
onBackendChange(announce);
onSpeedChange(announce);
