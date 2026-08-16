/* raceevents.js — appending to the race log.
 *
 * Every function here writes exactly one event, with the timestamp taken at
 * the moment of the tap, and returns once it is committed to IndexedDB. The
 * UI is expected to await these before it repaints: the record must exist
 * before the OOD sees confirmation of it (ARCHITECTURE.md D1, D3).
 *
 * Nothing here ever updates or deletes an event. Corrections are new events.
 */

import * as db from "./db.js";

async function append(raceId, type, { entryId = null, payload = null } = {}) {
  const row = {
    id: db.newId(),
    race_id: raceId,
    entry_id: entryId,
    type,
    payload,
    // Tap time, on this device. Never a server clock, and never the time the
    // write happened to complete.
    occurred_at: db.nowIso(),
  };
  await db.localWrite("race_events", row);
  return row;
}

export function eventsForRace(raceId) {
  return db.getAllByIndex("race_events", "by_race", raceId);
}

/* ---- the sequence ---- */

export const startSequence = (raceId) => append(raceId, "sequence_started");
export const postpone = (raceId) => append(raceId, "postponed");
export const generalRecall = (raceId) => append(raceId, "general_recall");

/* ---- racing ---- */

export const recordLap = (raceId, entryId) => append(raceId, "lap_recorded", { entryId });
export const recordFinish = (raceId, entryId) => append(raceId, "boat_finished", { entryId });
export const applyCode = (raceId, entryId, code) =>
  append(raceId, "code_applied", { entryId, payload: { code } });

/* ---- race level ---- */

export const shortenCourse = (raceId, { fastLaps, slowLaps }) =>
  append(raceId, "course_shortened", {
    payload: { fast_laps: Number(fastLaps), slow_laps: Number(slowLaps) },
  });

export const abandonRace = (raceId) => append(raceId, "race_abandoned");

/**
 * The dev panel forced a race into a status by hand.
 *
 * Kept as an escape hatch for the situation nobody predicted, on a beach,
 * with no developer available — but it must never be silent. A race found in
 * a strange status months later has to be explainable, so the override is an
 * event like any other, carrying what the status was and what it was changed
 * to, and it appears in the history drawer among the taps around it.
 */
export const overrideStatus = (raceId, { from, to }) =>
  append(raceId, "status_overridden", { payload: { from: from ?? null, to: to ?? null } });

/**
 * Close the race. Explicit, never automatic: the OOD decides when the last
 * boat is home. Undoable, because a race closed by mistake is still running.
 */
export const endRace = (raceId) => append(raceId, "race_ended");

/**
 * Adjust a boat's result before publishing. The payload keys are a contract
 * shared with 003_views.sql, which computes the same answers in Postgres —
 * change one and you must change the other.
 */
export const correct = (raceId, entryId, { laps, elapsed_seconds, code }) =>
  append(raceId, "correction", {
    entryId,
    payload: { laps, elapsed_seconds, code: code ?? null },
  });

/**
 * Undo an earlier event by appending a tombstone. The original stays in the
 * log for good — this is a safety record, and "it was recorded and then
 * corrected" is a different fact from "it never happened".
 */
export const undoEvent = (raceId, eventId) =>
  append(raceId, "event_undone", { payload: { undoes: eventId } });

/* ---- race status ---- */

/** Move the race on. The status is a projection of the log, kept on the row
    so other screens and Supabase can read it without replaying events. */
export async function setRaceStatus(race, status, extra = {}) {
  const row = { ...race, status, ...extra };
  await db.localWrite("races", row);
  return row;
}
