/* device.js — which phone is this, and is it the one running the day?
 *
 * A race day is run from one phone. If a second phone opens the same day and
 * also starts tapping laps, both sets of taps commit locally, both outboxes
 * drain, and the club database quietly ends up with a race where half the
 * boats have two lap counts. Nothing would look wrong on either screen.
 *
 * So a day names the device running it. This is a SOFT lock, deliberately:
 *
 *   - The second device can see everything. Read-only, but complete: an OOD
 *     handing over wants the incoming phone to show the race first.
 *
 *   - Taking over is one visible tap, never automatic. The common case is a
 *     handover — a dying battery, a swap at lunch — not a conflict.
 *
 *   - The losing device KEEPS EVERYTHING and keeps draining its outbox. It
 *     loses the ability to record anything new, and nothing else. Discarding
 *     unsynced events is the one unrecoverable act in this system, and the
 *     phone that just lost the claim is often holding the only copy of the
 *     last few taps.
 *
 * Last claim wins, and claimed_at lets both devices see which is newer.
 */

import * as db from "./db.js";

const DEVICE_ID_KEY = "device_id";
const DEVICE_NAME_KEY = "device_name";

let cachedId = null;

/**
 * This device's id, created once and kept for the life of the install.
 *
 * In IndexedDB rather than localStorage so it shares the fate of the race
 * data: a phone that has been wiped is a new device, which is correct — it
 * has no unsynced events left to protect.
 */
export async function deviceId() {
  if (cachedId) return cachedId;
  let id = await db.getMeta(DEVICE_ID_KEY);
  if (!id) {
    id = db.newId();
    await db.setMeta(DEVICE_ID_KEY, id);
  }
  cachedId = id;
  return id;
}

/** A human label for the takeover prompt: "Chris's iPhone", or the short id. */
export async function deviceName() {
  const name = await db.getMeta(DEVICE_NAME_KEY);
  if (name) return name;
  const id = await deviceId();
  return `Device ${id.slice(0, 6)}`;
}

export async function setDeviceName(name) {
  const trimmed = String(name ?? "").trim();
  await db.setMeta(DEVICE_NAME_KEY, trimmed || null);
  return trimmed;
}

/** Forget the cached id — for tests, and after a wipe. */
export function resetDeviceCache() {
  cachedId = null;
}

/**
 * Where this device stands on a given race day.
 *
 * An unclaimed day is claimable by anyone: days created before this feature
 * existed, and days synced down from the club database, have no claim at all
 * and must not be read-only for everybody.
 *
 * @returns {Promise<{state: "owner"|"observer"|"unclaimed", canRecord: boolean,
 *   claimedBy: string|null, claimedAt: string|null, byName: string|null}>}
 */
export async function claimState(raceDay) {
  const me = await deviceId();
  const claimedBy = raceDay?.claimed_by ?? null;
  const claimedAt = raceDay?.claimed_at ?? null;
  const byName = raceDay?.claimed_by_name ?? null;

  if (!claimedBy) {
    return { state: "unclaimed", canRecord: true, claimedBy: null, claimedAt: null, byName: null };
  }
  if (claimedBy === me) {
    return { state: "owner", canRecord: true, claimedBy, claimedAt, byName };
  }
  return { state: "observer", canRecord: false, claimedBy, claimedAt, byName };
}

/**
 * Claim the day for this device.
 *
 * Used both for the first claim and for a takeover — they are the same act,
 * and treating them the same is what keeps the rule simple: last claim wins.
 * Writing through localWrite means the claim syncs like any other row, so the
 * other phone learns about it as soon as both have signal.
 */
export async function claimRaceDay(raceDay) {
  if (!raceDay) throw new Error("There is no race day to claim.");
  const row = {
    ...raceDay,
    claimed_by: await deviceId(),
    claimed_by_name: await deviceName(),
    claimed_at: db.nowIso(),
  };
  await db.localWrite("race_days", row);
  return row;
}

/** Claim the day only if nobody has. Never steals — see claimRaceDay. */
export async function claimIfUnclaimed(raceDay) {
  if (!raceDay || raceDay.claimed_by) return raceDay;
  return claimRaceDay(raceDay);
}
