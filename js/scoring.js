/* scoring.js — a port of the club's race calculator, not a rewrite.
 *
 * The maths here has been scoring Nefyn's races for years and the results it
 * produces are the ones members expect. It is reproduced exactly, including
 * the details that look like details and are not:
 *
 *   - ties are decided on the ROUNDED corrected second, not the raw float, so
 *     two boats a hundredth apart tie exactly as they always have;
 *   - `starters` counts finishers plus CODED boats only, so a half-filled row
 *     in the old calculator never inflated anyone's penalty;
 *   - max laps comes from the boat that sailed furthest among those actually
 *     being scored.
 *
 * Pure, per CLAUDE.md: plain numbers in, plain numbers out. The event log is
 * turned into those numbers by state.js, so the manual-entry fallback and the
 * tests use this identical code path.
 */

/** RRS codes, with the wording the calculator prints. */
export const CODES = {
  DNC: "did not come to the starting area",
  DNS: "did not start",
  OCS: "on the course side at the start",
  DNF: "did not finish",
  RET: "retired",
  DSQ: "disqualified",
};

export const CODE_ORDER = ["DNC", "DNS", "OCS", "DNF", "RET", "DSQ"];

function num(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Score a race.
 *
 * @param {Array<{id, name, klass?, personalPy, basePy?, factor?,
 *                elapsedSeconds, laps, code?}>} boats
 * @param {{lapMode?: boolean}} options lapMode off scores on elapsed alone,
 *        which is the calculator's non-lap mode and the manual fallback.
 * @returns {{scored: Array, out: Array, maxLaps: number, starters: number,
 *            penalty: number}}
 */
export function scoreRace(boats = [], { lapMode = true } = {}) {
  const rows = boats.map((boat) => {
    const elapsed = num(boat.elapsedSeconds);
    const py = num(boat.personalPy);
    const laps = num(boat.laps);

    const row = {
      id: boat.id,
      // The combination — there are no hulls to take a name from.
      name: (boat.name ?? "").trim(),
      klass: (boat.klass ?? "").trim(),
      helm: (boat.helm ?? "").trim(),
      basePy: boat.basePy == null ? null : num(boat.basePy),
      factor: boat.factor == null ? null : num(boat.factor),
      py,
      laps,
      elapsed,
      corrected: null,
      ladj: null,
      reason: "",
      code: boat.code || "",
    };

    // Why a boat is not being scored. Order matters: a code wins over missing
    // data, because a coded boat is a result rather than an omission.
    if (row.code) row.reason = CODES[row.code] || row.code;
    else if (elapsed <= 0) row.reason = "no elapsed time";
    else if (py <= 0) row.reason = "no PY number";
    else if (lapMode && laps <= 0) row.reason = "no lap count";

    return row;
  });

  const scored = rows.filter((row) => !row.reason);

  let maxLaps = 0;
  for (const row of scored) if (row.laps > maxLaps) maxLaps = row.laps;
  if (!maxLaps) maxLaps = 1;

  for (const row of scored) {
    row.ladj = lapMode ? (row.elapsed * maxLaps) / row.laps : row.elapsed;
    row.corrected = lapMode
      ? (row.elapsed * maxLaps * 1000) / (row.py * row.laps)
      : (row.elapsed * 1000) / row.py;
    // Positions and ties are decided on whole seconds.
    row.rounded = Math.round(row.corrected);
  }

  scored.sort((a, b) => a.rounded - b.rounded || a.name.localeCompare(b.name));

  const best = scored.length ? scored[0].rounded : 0;
  const worst = scored.length ? scored[scored.length - 1].rounded : 0;

  scored.forEach((row, index) => {
    if (index > 0 && row.rounded === scored[index - 1].rounded) {
      row.place = scored[index - 1].place;
      row.tied = true;
    } else {
      row.place = index + 1;
      row.tied = false;
    }
    row.gap = row.rounded - best;
    // How far along the behind-leader bar this boat sits.
    row.frac = worst > best ? (row.rounded - best) / (worst - best) : 0;
  });

  // The first boat of a tied pair only learns it is tied once the second is
  // seen, so mark it on a second pass.
  scored.forEach((row, index) => {
    const next = scored[index + 1];
    if (next && next.rounded === row.rounded) row.tied = true;
  });

  const out = rows.filter(
    (row) => row.reason && (row.code || row.name || row.py > 0 || row.elapsed > 0)
  );

  /* RRS low point: a finisher scores its place, boats tied on corrected time
     share the average of the places they occupy, and any coded boat scores
     starters + 1. Only coded boats count towards starters — an incomplete row
     is not a boat that came to the line. */
  const starters = scored.length + out.filter((row) => row.code).length;
  const penalty = starters + 1;

  for (const row of scored) {
    const tiedWith = scored.filter((other) => other.rounded === row.rounded);
    let sum = 0;
    tiedWith.forEach((_, index) => {
      sum += row.place + index;
    });
    row.points = sum / tiedWith.length;
  }
  for (const row of out) row.points = row.code ? penalty : null;

  return { scored, out, maxLaps, starters, penalty };
}

/* ---------------------------------------------------------------------------
 * Formatting, carried over so the printed sheet reads the same
 * ------------------------------------------------------------------------ */

/** Points: whole numbers plain, shared points to one decimal. */
export function formatPoints(value) {
  if (value == null) return "—";
  return Math.round(value * 10) % 10 === 0 ? String(Math.round(value)) : value.toFixed(1);
}

/** h:mm:ss, as the calculator prints elapsed and corrected times. */
export function hms(seconds) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function gapText(seconds) {
  if (!seconds) return "leader";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `+${m}:${String(s).padStart(2, "0")}` : `+${s}s`;
}

/** "1122 × 0.97 = 1088", or just the PY when no adjustment applies. */
export function pyText(row) {
  if (row.basePy == null || row.factor == null || row.factor === 1) {
    return String(Math.round(row.py));
  }
  return `${Math.round(row.basePy)} × ${row.factor} = ${Math.round(row.py)}`;
}

/** The position column, with the '=' marker the calculator uses for ties. */
export function placeText(row) {
  return `${row.tied ? "=" : ""}${row.place}`;
}
