/* wind.js — recording the conditions.
 *
 * Beaufort force rather than knots: an OOD can judge F4 from the state of the
 * water without an anemometer, and the club's own language is "a good force
 * four". Knots would invite a number nobody actually measured.
 *
 * Direction is where the wind comes FROM, on eight points — the resolution a
 * race officer works to when setting a line.
 */

export const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export const FORCES = [
  [0, "Calm"],
  [1, "Light air"],
  [2, "Light breeze"],
  [3, "Gentle breeze"],
  [4, "Moderate breeze"],
  [5, "Fresh breeze"],
  [6, "Strong breeze"],
  [7, "Near gale"],
  [8, "Gale"],
];

/**
 * The tap targets, and the short word on each.
 *
 * Nine boxes, one per force, NOT grouped into ranges. Grouping would have
 * fitted six boxes instead of nine, but it would have changed what gets
 * stored: `wind_force` is a plain integer that prints as "F4" on the sheet,
 * the PDF and the CSV, and a box labelled "F0–1" has no honest integer to
 * write. Collapsing the top end is worse still — "F6+" loses the difference
 * between a windy race and one nobody should have sailed, which is exactly
 * the distinction a results sheet is read for months later.
 *
 * Nine fits: three columns at 390px gives ~109px a box — the force large,
 * the full Beaufort name small beneath it. Full names rather than clipped
 * ones because "Light air" and "Light breeze" are adjacent forces, and a box
 * reading just "Light" beside another reading "Light air" is a coin toss.
 * The name is what makes this a glance-pick; it is the reason Beaufort beats
 * knots for an OOD with no anemometer.
 */
export const FORCE_CHOICES = FORCES.map(([n, name]) => ({ force: n, name }));

export function forceLabel(force) {
  if (force == null || force === "") return null;
  const found = FORCES.find(([n]) => n === Number(force));
  return found ? `F${found[0]} ${found[1]}` : `F${force}`;
}

/** "SW F4 moderate breeze", or null when nothing was recorded. */
export function windText(race) {
  const direction = race?.wind_direction ?? null;
  const force = race?.wind_force ?? null;
  if (!direction && force == null) return null;
  const label = forceLabel(force);
  return [direction, label].filter(Boolean).join(" ");
}

/** Compact form for a results column or a CSV cell. */
export function windShort(race) {
  const direction = race?.wind_direction ?? null;
  const force = race?.wind_force ?? null;
  if (!direction && force == null) return "";
  return [direction, force == null ? null : `F${force}`].filter(Boolean).join(" ");
}
