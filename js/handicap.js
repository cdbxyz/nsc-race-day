/* handicap.js — the personal handicap engine (ARCHITECTURE.md section 5).
 *
 * Pure: no DOM, no IO, no clock. Everything it needs is passed in, so the
 * whole thing is testable and behaves identically on a phone with no signal.
 *
 * A helm's factor comes from how many races they have already won this season.
 * The factor is stamped onto the entry at sign-on and never recalculated
 * afterwards, so a result sheet from March still explains itself in September.
 */

/** Boats with a base PY below this sail in the fast fleet. 1168 itself is slow. */
export const FLEET_BOUNDARY = 1168;

/** Default laps per fleet. A race may override these; a boat may override again. */
export const DEFAULT_LAPS = { fast: 3, slow: 2 };

/* 0 wins → full PY, then progressively less as the season goes on, floored at
   0.95. Beating three people once should not follow you around forever. */
const FACTORS = [1.0, 0.97, 0.96, 0.95];

/**
 * The handicap factor for a helm with this many qualifying wins.
 * Capped: 3 wins and 30 wins are treated the same.
 *
 * @param {number} winCount
 * @returns {number} 1.0 | 0.97 | 0.96 | 0.95
 */
export function factorFor(winCount) {
  const wins = Number(winCount);
  if (!Number.isFinite(wins) || wins <= 0) return FACTORS[0];
  const index = Math.min(Math.floor(wins), FACTORS.length - 1);
  return FACTORS[index];
}

/**
 * Which fleet a boat sails in. Fast is *strictly* below the boundary, so a
 * boat on exactly 1168 is slow — confirmed during scoping.
 *
 * @param {number} basePy
 * @returns {"fast"|"slow"}
 */
export function fleetFor(basePy) {
  return Number(basePy) < FLEET_BOUNDARY ? "fast" : "slow";
}

/**
 * The PY actually used for this entry.
 *
 * Kept exact rather than rounded: ARCHITECTURE.md section 4 shows
 * "930 × 0.97 = 902.1" on a result sheet, and rounding here would quietly
 * shift every corrected time. Round when displaying, not when storing.
 *
 * @returns {number}
 */
export function personalPy(basePy, factor) {
  // Two decimals is well beyond what a PY needs and kills float noise like
  // 1122 * 0.97 = 1088.3400000000001.
  return Math.round(Number(basePy) * Number(factor) * 100) / 100;
}

/** How many laps this entry is due, most specific rule first. */
export function lapsFor({ fleet, lapsOverride, fastLaps, slowLaps }) {
  if (lapsOverride != null && lapsOverride !== "") return Number(lapsOverride);
  return fleet === "fast"
    ? Number(fastLaps ?? DEFAULT_LAPS.fast)
    : Number(slowLaps ?? DEFAULT_LAPS.slow);
}

function toMillis(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * How many qualifying wins a helm has this season.
 *
 * Two sources, because the phone must get this right with no signal:
 *
 *   cachedWins           the helm_season_wins view, pulled while online. This
 *                        is authoritative for everything the server knows.
 *   localPublishedRaces  races published on THIS device that the cache may not
 *                        include yet — which is how a helm who wins Race 1
 *                        carries the reduced factor into Race 2 the same
 *                        afternoon, offline. Same-day application is confirmed
 *                        behaviour (ARCHITECTURE.md section 5).
 *
 * The two must not double-count. A race published before the cache was last
 * refreshed is already in the cached total, so `cachedAt` filters those out.
 * With no cachedAt (never refreshed) every local win counts.
 *
 * @param {string} helmId
 * @param {number} season
 * @param {Array<{helm_id:string, season:number, wins:number}>} cachedWins
 * @param {Array<{helm_id:string, season:number, published_at:string|number}>} localPublishedRaces
 * @param {{cachedAt?: string|number|null}} options
 * @returns {number}
 */
export function winsForHelm(
  helmId,
  season,
  cachedWins = [],
  localPublishedRaces = [],
  { cachedAt = null } = {}
) {
  if (!helmId) return 0;
  const wantedSeason = Number(season);

  const cached =
    cachedWins.find(
      (row) => row.helm_id === helmId && Number(row.season) === wantedSeason
    )?.wins ?? 0;

  const cachedAtMs = toMillis(cachedAt);

  const local = localPublishedRaces.filter((race) => {
    if (race.helm_id !== helmId) return false;
    if (Number(race.season) !== wantedSeason) return false;
    if (cachedAtMs == null) return true;
    const publishedMs = toMillis(race.published_at);
    // Published after the last refresh, so the cache cannot know about it.
    return publishedMs != null && publishedMs > cachedAtMs;
  }).length;

  return Number(cached) + local;
}

/**
 * Everything an entry needs, computed together so the caller cannot mix a
 * factor from one helm with a PY from another boat.
 *
 * @returns {{base_py:number, handicap_factor:number, personal_py:number,
 *            fleet:string, wins:number}}
 */
export function entrySnapshot({ basePy, wins, factorOverride = null }) {
  const base = Number(basePy);
  const factor = factorOverride == null ? factorFor(wins) : Number(factorOverride);
  return {
    base_py: base,
    handicap_factor: factor,
    personal_py: personalPy(base, factor),
    fleet: fleetFor(base),
    wins: Number(wins) || 0,
  };
}

/** The season a race belongs to: the series' season, else the year it was sailed. */
export function seasonFor({ seriesSeason, raceDate }) {
  if (seriesSeason != null && seriesSeason !== "") return Number(seriesSeason);
  if (!raceDate) return new Date().getFullYear();
  return Number(String(raceDate).slice(0, 4));
}
