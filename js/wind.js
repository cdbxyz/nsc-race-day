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
