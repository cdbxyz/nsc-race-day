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

/**
 * What kind of phone this is, from the user agent.
 *
 * Only ever a DEFAULT, and a weak one: it narrows "which phone claimed the
 * day" from nothing to "an iPhone", which is worth having when three people
 * are standing on a beach, but it does not identify anybody. The name the
 * OOD types is what actually answers the question, and this is what sits in
 * the box until they do.
 */
export function defaultDeviceName() {
  const ua = globalThis.navigator?.userAgent ?? "";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android phone";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows PC";
  return "This phone";
}

/**
 * Suggested name for a device its owner has not named: "Chris's iPhone".
 *
 * The OOD types their own name at setup anyway, so the useful half of the
 * label is already on screen — taking it costs the OOD nothing and turns
 * "Device 74b9eb claimed it" into a sentence somebody can act on.
 */
export function suggestDeviceName(ownerName) {
  const owner = String(ownerName ?? "").trim();
  const kind = defaultDeviceName();
  if (!owner) return kind;
  /* Always 's, even after an s. Modern British usage takes "Chris's" and
     "Rhys's"; the bare apostrophe belongs to plurals, and a rule that tried
     to tell those apart from personal names would get Welsh names wrong more
     often than it got them right. */
  return `${owner}'s ${kind}`;
}

/**
 * This device's name, as the OTHER phone will see it in the takeover banner.
 *
 * Falls back to the device kind rather than the id: "iPhone" is a poor label
 * but "Device 74b9eb" is a useless one, and the banner's whole job is to let
 * an OOD recognise which phone is holding the day.
 */
export async function deviceName() {
  const name = await db.getMeta(DEVICE_NAME_KEY);
  return name || defaultDeviceName();
}

/** True once someone has actually named this phone, rather than defaulted. */
export async function isNamed() {
  return Boolean(await db.getMeta(DEVICE_NAME_KEY));
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

  // What this phone would call itself, for the takeover prompt's name box.
  const myName = await deviceName();

  if (!claimedBy) {
    return {
      state: "unclaimed", canRecord: true,
      claimedBy: null, claimedAt: null, byName: null, myName,
    };
  }
  if (claimedBy === me) {
    return { state: "owner", canRecord: true, claimedBy, claimedAt, byName, myName };
  }
  return { state: "observer", canRecord: false, claimedBy, claimedAt, byName, myName };
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
