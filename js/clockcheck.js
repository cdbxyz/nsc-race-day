/* clockcheck.js — is this phone's clock telling the truth?
 *
 * Every timestamp in this app is taken from the device at the moment of the
 * tap (ARCHITECTURE.md D3). That is the right design — it is the only way a
 * race recorded with no signal has honest times — but it puts the whole
 * results sheet at the mercy of the phone's clock. A phone an hour out
 * produces elapsed times an hour wrong, and nothing on screen looks unusual:
 * the countdown counts down, the race clock climbs, the splits look sane.
 * It is only when the rows reach the club database beside another device's
 * that anyone finds out, months later.
 *
 * So the clock is checked against the one authority already in every reply.
 * Every PostgREST response carries a `Date` header — the server's own clock,
 * free, no extra request, on a connection we were making anyway.
 *
 * Two deliberate limits:
 *
 *   - This is ADVISORY. It never rewrites a stored timestamp and never
 *     blocks a write. A wrong clock is a thing to tell the OOD about, not a
 *     reason to refuse the day's data — the events are still the best record
 *     that exists, and the offset is recoverable afterwards if it is known.
 *
 *   - Round-trip time is not subtracted. On one bar of 4G a request can take
 *     seconds, so the measured offset is only good to a few seconds either
 *     way, and the threshold is set well above that. We are looking for a
 *     phone set to the wrong hour or the wrong day, not for NTP drift.
 */

const listeners = new Set();

/** Below this, say nothing: it is network latency, not a wrong clock. */
export const TOLERANCE_MS = 90_000;

let offsetMs = null;
let checkedAt = null;

/**
 * Record the server's clock from a response's Date header.
 *
 * @param {Headers|null} headers
 * @param {number} receivedAt local clock when the reply arrived
 * @returns {number|null} the offset in ms (positive = device ahead of server)
 */
export function noteServerDate(headers, receivedAt = Date.now()) {
  const raw = headers?.get?.("date");
  if (!raw) return offsetMs;

  const serverAt = Date.parse(raw);
  if (!Number.isFinite(serverAt)) return offsetMs;

  const next = receivedAt - serverAt;
  const changed = offsetMs == null || Math.abs(next - offsetMs) > 1000;
  offsetMs = next;
  checkedAt = receivedAt;
  if (changed) announce();
  return offsetMs;
}

/** The last measured offset, or null if the server has never been reached. */
export function clockOffset() {
  return offsetMs;
}

export function lastCheckedAt() {
  return checkedAt;
}

/**
 * A sentence about the device clock, or null when there is nothing to say.
 *
 * The HTTP Date header has one-second resolution, so the offset is reported
 * in whole minutes — claiming more precision than that would be a fiction.
 */
export function clockWarning() {
  if (offsetMs == null) return null;
  if (Math.abs(offsetMs) <= TOLERANCE_MS) return null;

  const minutes = Math.round(Math.abs(offsetMs) / 60_000);
  const amount =
    minutes >= 120
      ? `${Math.round(minutes / 60)} hours`
      : minutes >= 2
        ? `${minutes} minutes`
        : "about a minute";
  const direction = offsetMs > 0 ? "ahead of" : "behind";

  return (
    `This phone's clock is ${amount} ${direction} the club database. ` +
    "Every time recorded on it — the gun, every lap, every finish — is out by that much. " +
    "Fix the phone's date and time in Settings, then tell whoever checks the results."
  );
}

export function onClockChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce() {
  const warning = clockWarning();
  for (const fn of listeners) {
    try {
      fn(warning, offsetMs);
    } catch (err) {
      console.error("clock listener failed", err);
    }
  }
}

/** Tests and a wiped phone start from nothing known. */
export function resetClockCheck() {
  offsetMs = null;
  checkedAt = null;
}
