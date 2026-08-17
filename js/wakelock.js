/* wakelock.js — keep the screen on during the sequence and the live race.
 *
 * A phone that sleeps mid-race is not a disaster — every timer is computed
 * from stored timestamps, so it wakes up correct — but it is a nuisance when
 * boats are crossing the line. This asks the browser to keep the screen lit
 * and re-asks whenever the page comes back, because the lock is dropped every
 * time the phone is locked or the app is backgrounded.
 *
 * Entirely best-effort. Safari only gained Wake Lock recently and some
 * browsers refuse it outright; nothing here fails if it is unavailable.
 */

let sentinel = null;
let wanted = false;
let wired = false;

function supported() {
  return typeof navigator !== "undefined" && "wakeLock" in navigator;
}

async function acquire() {
  if (!wanted || !supported() || sentinel) return;
  try {
    sentinel = await navigator.wakeLock.request("screen");
    sentinel.addEventListener("release", () => {
      sentinel = null;
    });
  } catch (err) {
    // Refused (low battery, permissions policy, unsupported). Carry on.
    console.info("[wakelock] not held:", err.message);
    sentinel = null;
  }
}

function wire() {
  if (wired || typeof document === "undefined") return;
  wired = true;
  document.addEventListener("visibilitychange", () => {
    // The lock is dropped whenever the page is hidden, so re-take it on return.
    if (document.visibilityState === "visible") acquire();
  });
}

/** Ask for the screen to stay on. Safe to call repeatedly. */
export function keepAwake() {
  wanted = true;
  wire();
  acquire();
}

/** Stop asking, and let go of the lock. */
export async function allowSleep() {
  wanted = false;
  const held = sentinel;
  sentinel = null;
  try {
    await held?.release();
  } catch {
    // Already gone.
  }
}

export function isHeld() {
  return Boolean(sentinel);
}

/** Whether this browser can keep the screen on at all. */
export function isSupported() {
  return supported();
}

/**
 * What to tell the OOD when the screen will not stay on.
 *
 * There is no honest software fallback — the no-sleep video trick burns
 * battery on the one device that cannot spare it, and battery is the thing
 * that actually ends race days. So the fallback is a sentence and a
 * reassurance: the phone sleeping costs nothing, because every timer is
 * computed from stored timestamps rather than accumulated.
 *
 * Returns null when the screen is being held, or when we can hold it.
 */
export function sleepWarning() {
  if (supported()) return null;
  return (
    "This browser will not keep the screen awake, so the phone may sleep. " +
    "Nothing is lost if it does — the clock is worked out from the recorded times, " +
    "not counted up — but set Auto-Lock to Never in Settings before the gun."
  );
}
