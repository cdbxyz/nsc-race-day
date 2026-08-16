/* calendar.js — the season programme.
 *
 * A committee-agreed list of what is being sailed and when, so the OOD does
 * not have to remember on the day and a trophy race is named correctly on its
 * results sheet. Editable in the register, because it starts life as a draft
 * proposal and gets corrected.
 */

import * as db from "./db.js";

/** Pursuit starts are a different format. v1 cannot run one. */
export const PURSUIT_CALCULATOR_URL = "https://cdbxyz.github.io/nsc-race-calc";

export async function listCalendar(season = null) {
  const rows = await db.getAll("race_calendar");
  return rows
    .filter((row) => season == null || Number(row.season) === Number(season))
    .sort(
      (a, b) =>
        String(a.date).localeCompare(String(b.date)) ||
        String(a.start_time ?? "").localeCompare(String(b.start_time ?? ""))
    );
}

/** Everything scheduled on one date, earliest first. Usually none or one. */
export async function racesOn(date) {
  const rows = await listCalendar();
  return rows.filter((row) => row.date === date);
}

export async function createCalendarEntry({ season, date, name, startTime, isPursuit = false }) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("A calendar entry needs a race name.");
  if (!date) throw new Error("A calendar entry needs a date.");

  const row = {
    id: db.newId(),
    season: Number(season) || Number(String(date).slice(0, 4)),
    date,
    name: trimmed,
    start_time: startTime || "14:00",
    series: null,
    is_pursuit: Boolean(isPursuit),
    created_at: db.nowIso(),
  };
  await db.localWrite("race_calendar", row);
  return row;
}

export async function updateCalendarEntry(id, changes) {
  const current = await db.get("race_calendar", id);
  if (!current) throw new Error("That calendar entry has gone.");
  const row = {
    ...current,
    ...(changes.name != null ? { name: String(changes.name).trim() } : {}),
    ...(changes.date != null ? { date: changes.date } : {}),
    ...(changes.startTime != null ? { start_time: changes.startTime } : {}),
    ...(changes.isPursuit != null ? { is_pursuit: Boolean(changes.isPursuit) } : {}),
  };
  await db.localWrite("race_calendar", row);
  return row;
}

export async function removeCalendarEntry(id) {
  await db.localDelete("race_calendar", id);
}

/** "14:00" from "14:00:00", for display. */
export function shortTime(value) {
  return String(value ?? "").slice(0, 5);
}
