/* raceday.js — creating and reading a race day, and the sign-on entries.
 *
 * All writes go through localWrite, so the whole of setup and sign-on works
 * with no signal and syncs later exactly like race events do.
 */

import * as db from "./db.js";
import { entrySnapshot, seasonFor, winsForHelm, lapsFor } from "./handicap.js";
import { cachedSeasonWins, lastRefreshedAt } from "./backend.js";

/** Races that have been published on this device, for the same-day rule. */
const LOCAL_WINS_KEY = "local_published_wins";

/* ---- series ------------------------------------------------------------- */

export async function listSeries() {
  const series = await db.getAll("series");
  return series.sort(
    (a, b) => (b.season ?? 0) - (a.season ?? 0) || a.name.localeCompare(b.name)
  );
}

export async function createSeries({ name, season }) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("A series needs a name.");
  const row = {
    id: db.newId(),
    name: trimmed,
    season: Number(season) || new Date().getFullYear(),
    discard_rule: null,
  };
  await db.localWrite("series", row);
  return row;
}

/* ---- race days ---------------------------------------------------------- */

export async function openRaceDay() {
  const open = await db.getAllByIndex("race_days", "by_status", "open");
  if (!open.length) return null;
  open.sort(
    (a, b) =>
      String(b.date || "").localeCompare(String(a.date || "")) ||
      String(b.created_at || "").localeCompare(String(a.created_at || ""))
  );
  return open[0];
}

/**
 * The most recent race day, open or closed. Results stay readable after
 * stand-down: someone always wants the PDF again on Monday.
 */
export async function latestRaceDay() {
  const open = await openRaceDay();
  if (open) return open;
  const days = await db.getAll("race_days");
  if (!days.length) return null;
  days.sort(
    (a, b) =>
      String(b.date || "").localeCompare(String(a.date || "")) ||
      String(b.created_at || "").localeCompare(String(a.created_at || ""))
  );
  return days[0];
}

/** Names used on previous race days, most recent first — for suggestions. */
export async function recentOfficerNames() {
  const days = await db.getAll("race_days");
  days.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const names = [];
  for (const day of days) {
    for (const name of [day.ood_name, day.ro1_name, day.ro2_name]) {
      const trimmed = String(name ?? "").trim();
      if (trimmed && !names.includes(trimmed)) names.push(trimmed);
    }
  }
  return names;
}

/**
 * Create the race day and its planned races in one go. The races start in
 * 'setup' so sign-on has something to attach entries to.
 */
export async function createRaceDay({
  date,
  oodName,
  ro1Name,
  ro2Name,
  raceName = "",
  seriesId = null,
  raceCount = 1,
  fastLaps = 3,
  slowLaps = 2,
}) {
  if (!date) throw new Error("A race day needs a date.");
  if (!String(oodName ?? "").trim()) throw new Error("A race day needs an OOD.");

  const raceDay = {
    id: db.newId(),
    date,
    ood_name: String(oodName).trim(),
    ro1_name: String(ro1Name ?? "").trim() || null,
    ro2_name: String(ro2Name ?? "").trim() || null,
    status: "open",
    created_at: db.nowIso(),
  };
  await db.localWrite("race_days", raceDay);

  const races = [];
  const count = Math.max(1, Math.min(Number(raceCount) || 1, 10));
  for (let number = 1; number <= count; number += 1) {
    const race = {
      id: db.newId(),
      race_day_id: raceDay.id,
      series_id: seriesId || null,
      number,
      // Only the first race is named at setup; the rest are nameable later.
      name: number === 1 ? String(raceName ?? "").trim() || null : null,
      status: "setup",
      sequence_start_at: null,
      start_at: null,
      fast_laps: Number(fastLaps) || 3,
      slow_laps: Number(slowLaps) || 2,
      published_at: null,
    };
    await db.localWrite("races", race);
    races.push(race);
  }

  return { raceDay, races };
}

/**
 * Add another race to the day. Race days grow — the OOD plans one, the wind
 * holds, and suddenly there are three — so this must not mean going back to
 * setup.
 */
export async function addRace(raceDay, { name = "" } = {}) {
  const races = await racesForDay(raceDay.id);
  const previous = races[races.length - 1] ?? null;
  const race = {
    id: db.newId(),
    race_day_id: raceDay.id,
    // Carry the series and lap plan from the last race: the next one is
    // almost always the same again.
    series_id: previous?.series_id ?? null,
    number: (previous?.number ?? 0) + 1,
    name: String(name ?? "").trim() || null,
    status: "setup",
    sequence_start_at: null,
    start_at: null,
    fast_laps: previous?.fast_laps ?? 3,
    slow_laps: previous?.slow_laps ?? 2,
    published_at: null,
  };
  await db.localWrite("races", race);
  return race;
}

/** Name or rename a race. Race-level data, so it syncs like any other row. */
export async function setRaceName(race, name) {
  const row = { ...race, name: String(name ?? "").trim() || null };
  await db.localWrite("races", row);
  return row;
}

export async function racesForDay(raceDayId) {
  const races = await db.getAllByIndex("races", "by_race_day", raceDayId);
  return races.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

/* How far through the day each status is. Used to make status changes
   monotonic: revisiting the checklist must not drag a racing race backwards. */
const PROGRESS = {
  setup: 0,
  prestart: 1,
  sequence: 2,
  racing: 3,
  finished: 4,
  published: 5,
  abandoned: 6,
};

/** Advance a race's status, never rewind it. */
export async function setRaceStatusIfEarlier(race, status, extra = {}) {
  if ((PROGRESS[race.status] ?? 0) >= (PROGRESS[status] ?? 0)) return race;
  const row = { ...race, status, ...extra };
  await db.localWrite("races", row);
  return row;
}

/** The race the OOD is working on: the first that has not been sailed yet. */
export async function currentRace(raceDayId) {
  const races = await racesForDay(raceDayId);
  // The first race still in play. A race under way outranks a later one
  // sitting in setup, so the OOD is never sent back to sign-on mid-sequence.
  const inPlay = races.find((r) => (PROGRESS[r.status] ?? 0) < PROGRESS.finished);
  return inPlay ?? races[races.length - 1] ?? null;
}

/* ---- same-day wins ------------------------------------------------------ */

/**
 * Races published on this device. Phase 5 appends to this at publish time;
 * kept in `meta` rather than on the race row because it is local bookkeeping
 * and must never be pushed to a column that does not exist.
 */
export async function localPublishedWins() {
  return (await db.getMeta(LOCAL_WINS_KEY)) ?? [];
}

export async function recordLocalWin({ raceId, helmId, season, publishedAt }) {
  const wins = await localPublishedWins();
  if (wins.some((w) => w.race_id === raceId && w.helm_id === helmId)) return wins;
  const next = [
    ...wins,
    {
      race_id: raceId,
      helm_id: helmId,
      season: Number(season),
      published_at: publishedAt ?? db.nowIso(),
    },
  ];
  await db.setMeta(LOCAL_WINS_KEY, next);
  return next;
}

/**
 * Everything needed to work out a helm's factor, gathered once per sign-on
 * render rather than per boat.
 */
export async function handicapContext(season) {
  const [cached, localWins, cachedAt] = await Promise.all([
    cachedSeasonWins(),
    localPublishedWins(),
    lastRefreshedAt(),
  ]);
  return { season, cachedWins: cached, localWins, cachedAt };
}

export function winsFor(helmId, context) {
  return winsForHelm(helmId, context.season, context.cachedWins, context.localWins, {
    cachedAt: context.cachedAt,
  });
}

/* ---- entries ------------------------------------------------------------ */

export async function entriesForRace(raceId) {
  const entries = await db.getAllByIndex("entries", "by_race", raceId);
  return entries;
}

/**
 * The combinations this club actually races: helm (+ crew) in a class, most
 * recently first. Derived from entry history rather than stored, so it is
 * always the truth about who has been sailing what.
 *
 * Identity is helm + crew + class: swapping crew makes a different
 * combination, because that is how the club thinks about it.
 *
 * @returns {Array<{key, helmId, crewId, classId, boatId, lastSeen}>}
 */
export async function recentCombinations() {
  const [entries, races] = await Promise.all([db.getAll("entries"), db.getAll("races")]);
  const raceById = new Map(races.map((r) => [r.id, r]));

  const byKey = new Map();
  for (const entry of entries) {
    if (!entry.class_id) continue;
    const race = raceById.get(entry.race_id);
    const when = String(race?.start_at ?? race?.sequence_start_at ?? "");
    const key = `${entry.helm_id}|${entry.crew_id ?? ""}|${entry.class_id}`;
    const existing = byKey.get(key);
    if (!existing || when > existing.lastSeen) {
      byKey.set(key, {
        key,
        helmId: entry.helm_id,
        crewId: entry.crew_id ?? null,
        classId: entry.class_id,
        boatId: entry.boat_id ?? null,
        lastSeen: when,
      });
    }
  }

  return [...byKey.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/** Boats that have raced, most recently first — the sign-on search order. */
export async function boatsByRecentUse() {
  const [entries, races] = await Promise.all([db.getAll("entries"), db.getAll("races")]);
  const raceById = new Map(races.map((r) => [r.id, r]));
  const lastSeen = new Map();
  for (const entry of entries) {
    const race = raceById.get(entry.race_id);
    const when = race?.start_at ?? race?.sequence_start_at ?? null;
    const previous = lastSeen.get(entry.boat_id);
    if (!previous || String(when ?? "") > String(previous)) {
      lastSeen.set(entry.boat_id, when ?? "");
    }
  }
  return lastSeen;
}

/** The helm who last sailed this boat. */
export async function lastKnownHelms() {
  const [entries, races] = await Promise.all([db.getAll("entries"), db.getAll("races")]);
  const raceById = new Map(races.map((r) => [r.id, r]));
  const best = new Map();
  for (const entry of entries) {
    const race = raceById.get(entry.race_id);
    const when = String(race?.start_at ?? race?.sequence_start_at ?? "");
    const current = best.get(entry.boat_id);
    if (!current || when > current.when) {
      best.set(entry.boat_id, { helmId: entry.helm_id, when });
    }
  }
  return new Map([...best].map(([boatId, v]) => [boatId, v.helmId]));
}

/**
 * Sign a boat on. The PY, factor and fleet are snapshotted here and never
 * recomputed, so a published result never shifts under a later win.
 */
/**
 * Sign a combination on.
 *
 * The class is what matters — that is where the PY comes from. A hull is
 * optional, because most boats here are identified by who is sailing them.
 * Crew is optional even in a double-hander: sailing one short is normal.
 *
 * The PY, factor and fleet are snapshotted here and never recomputed, so a
 * published result never shifts under a later win.
 */
export async function addEntry({
  race,
  klass,
  helmId,
  crewId = null,
  boat = null,
  context,
  factorOverride = null,
}) {
  if (!race) throw new Error("No race to sign on to.");
  if (!helmId) throw new Error("Every entry needs a helm.");
  if (!klass) throw new Error("Pick a class — that is where the PY comes from.");
  if (crewId && crewId === helmId) throw new Error("The helm cannot also be the crew.");

  const existing = await entriesForRace(race.id);
  // A helm sails one boat per race; that is the real duplicate rule now.
  if (existing.some((e) => e.helm_id === helmId)) {
    throw new Error("That helm is already signed on for this race.");
  }
  if (boat && existing.some((e) => e.boat_id === boat.id)) {
    throw new Error(`${boat.name ?? "That hull"} is already signed on.`);
  }

  const wins = winsFor(helmId, context);
  const snap = entrySnapshot({ basePy: klass.base_py, wins, factorOverride });

  const row = {
    id: db.newId(),
    race_id: race.id,
    class_id: klass.id,
    boat_id: boat?.id ?? null,
    helm_id: helmId,
    // Crew is recorded for the tally and the result sheet; it has no bearing
    // on the handicap, which follows the helm alone.
    crew_id: crewId || null,
    base_py: snap.base_py,
    handicap_factor: snap.handicap_factor,
    personal_py: snap.personal_py,
    fleet: snap.fleet,
    laps_override: null,
  };
  await db.localWrite("entries", row);
  return row;
}

/** Change or clear an entry's crew. Never touches the handicap. */
export async function setEntryCrew(entryId, crewId) {
  const entry = await db.get("entries", entryId);
  if (!entry) throw new Error("That entry has gone.");
  if (crewId && crewId === entry.helm_id) throw new Error("The helm cannot also be the crew.");
  const row = { ...entry, crew_id: crewId || null };
  await db.localWrite("entries", row);
  return row;
}

/** Change an entry's helm, recomputing the snapshot for the new person. */
export async function setEntryHelm(entryId, helmId, context) {
  const entry = await db.get("entries", entryId);
  if (!entry) throw new Error("That entry has gone.");
  if (entry.crew_id && entry.crew_id === helmId) {
    throw new Error("That person is already the crew on this entry.");
  }
  const others = (await entriesForRace(entry.race_id)).filter((e) => e.id !== entryId);
  if (others.some((e) => e.helm_id === helmId)) {
    throw new Error("That helm is already signed on for this race.");
  }
  const wins = winsFor(helmId, context);
  const snap = entrySnapshot({ basePy: entry.base_py, wins });
  const row = {
    ...entry,
    helm_id: helmId,
    handicap_factor: snap.handicap_factor,
    personal_py: snap.personal_py,
  };
  await db.localWrite("entries", row);
  return row;
}

/** Committee discretion: pin the factor by hand, recorded on the entry. */
export async function setEntryFactor(entryId, factor) {
  const entry = await db.get("entries", entryId);
  if (!entry) throw new Error("That entry has gone.");
  const snap = entrySnapshot({ basePy: entry.base_py, wins: 0, factorOverride: factor });
  const row = {
    ...entry,
    handicap_factor: snap.handicap_factor,
    personal_py: snap.personal_py,
  };
  await db.localWrite("entries", row);
  return row;
}

export async function setEntryLaps(entryId, lapsOverride) {
  const entry = await db.get("entries", entryId);
  if (!entry) throw new Error("That entry has gone.");
  const value =
    lapsOverride === null || lapsOverride === "" ? null : Math.max(0, Number(lapsOverride));
  await db.localWrite("entries", { ...entry, laps_override: value });
}

/**
 * Sign-on is only editable before the race exists on the water.
 *
 * Once a sequence has started, the sign-on list is the day's tally record —
 * it is what the stand-down check reads to work out whether every boat that
 * went out has come back. Deleting an entry after that point would erase a
 * boat that was really there, which is precisely the thing nobody may do.
 * Mistakes from then on are handled with codes (DNS, DNC, RET), which leave
 * the boat visible and explain what happened to it.
 */
export const EDITABLE_STATUSES = new Set(["setup", "prestart"]);

export function canRemoveEntries(race) {
  return Boolean(race) && EDITABLE_STATUSES.has(race.status);
}

export async function removeEntry(entryId, race) {
  const target = race ?? (await raceForEntry(entryId));
  if (!canRemoveEntries(target)) {
    throw new Error(
      "This race has already started. Use a code (DNS, DNC or RET) so the boat stays on the tally."
    );
  }
  await db.localDelete("entries", entryId);
}

async function raceForEntry(entryId) {
  const entry = await db.get("entries", entryId);
  if (!entry) return null;
  return db.get("races", entry.race_id);
}

export function entryLaps(entry, race) {
  return lapsFor({
    fleet: entry.fleet,
    lapsOverride: entry.laps_override,
    fastLaps: race?.fast_laps,
    slowLaps: race?.slow_laps,
  });
}

/* ---- carrying forward --------------------------------------------------- */

/**
 * The previous race's entries, ready to be carried into this one. Factors are
 * recomputed rather than copied: a helm who won Race 1 races Race 2 off a
 * lower PY, which is the whole point of the same-day rule.
 */
export async function carryForwardCandidates(race, context) {
  const races = await racesForDay(race.race_day_id);
  const previous = races
    .filter((r) => r.number < race.number)
    .sort((a, b) => b.number - a.number)[0];
  if (!previous) return [];

  const [previousEntries, alreadyHere] = await Promise.all([
    entriesForRace(previous.id),
    entriesForRace(race.id),
  ]);

  const [boats, classes] = await Promise.all([db.getAll("boats"), db.getAll("classes")]);
  const boatById = new Map(boats.map((b) => [b.id, b]));
  const classById = new Map(classes.map((c) => [c.id, c]));

  const signedOnHelms = new Set(alreadyHere.map((e) => e.helm_id));

  return previousEntries
    .filter((entry) => !signedOnHelms.has(entry.helm_id))
    .map((entry) => {
      const boat = entry.boat_id ? boatById.get(entry.boat_id) ?? null : null;
      const klass = classById.get(entry.class_id) ?? null;
      const wins = winsFor(entry.helm_id, context);
      const basePy = klass?.base_py ?? entry.base_py;
      return {
        boat,
        klass,
        helmId: entry.helm_id,
        crewId: entry.crew_id ?? null,
        previousEntry: entry,
        wins,
        snapshot: entrySnapshot({ basePy, wins }),
      };
    })
    .filter((candidate) => candidate.klass);
}

export function seasonForRace(race, series) {
  return seasonFor({
    seriesSeason: series?.season ?? null,
    raceDate: race?.race_date ?? null,
  });
}
