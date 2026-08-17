/* storage.js — keeping the race day on the phone, and noticing when we can't.
 *
 * Two different failures, both silent by default, both fatal to a race day.
 *
 * EVICTION. IndexedDB is "best effort" storage until you ask otherwise. Under
 * pressure a browser may clear it — and on iOS, Safari clears the storage of
 * sites that have not been visited for seven days, which is precisely the
 * usage pattern of a sailing club app used on Saturdays. Every unsynced event
 * would go with it. navigator.storage.persist() asks for the day's data to be
 * exempt; installing to the home screen makes iOS grant it without a prompt,
 * which is the real reason the OOD guide insists on installing.
 *
 * QUOTA. A write that fails because the disk is full throws QuotaExceededError
 * from deep inside a transaction. Without this the tap looks like it worked:
 * the page has already moved on, and the event simply is not there. That is
 * the worst failure mode in the whole app, so it is surfaced loudly and
 * immediately rather than logged.
 *
 * Nothing here blocks anything. A phone that refuses persistence still runs
 * the race; the OOD just needs to be told to sync before it goes in a pocket.
 */

const listeners = new Set();

let state = {
  persisted: null, // null = not asked yet
  quotaError: null,
  usage: null,
  quota: null,
};

export function storageState() {
  return { ...state };
}

export function onStorageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce() {
  for (const fn of listeners) {
    try {
      fn(storageState());
    } catch (err) {
      console.error("storage listener failed", err);
    }
  }
}

/**
 * Ask the browser not to evict this app's data.
 *
 * Called on every boot, not once: the answer changes when the app is
 * installed to the home screen, and asking again is free.
 */
export async function requestPersistence() {
  const storage = globalThis.navigator?.storage;
  if (!storage?.persist) {
    state = { ...state, persisted: false };
    announce();
    return false;
  }
  try {
    const already = storage.persisted ? await storage.persisted() : false;
    const granted = already || (await storage.persist());
    state = { ...state, persisted: Boolean(granted) };
  } catch {
    state = { ...state, persisted: false };
  }
  announce();
  return state.persisted;
}

/** How much room is left, when the browser will say. */
export async function refreshEstimate() {
  const storage = globalThis.navigator?.storage;
  if (!storage?.estimate) return state;
  try {
    const { usage = null, quota = null } = await storage.estimate();
    state = { ...state, usage, quota };
    announce();
  } catch {
    // Some browsers refuse. Not knowing is survivable.
  }
  return state;
}

/** Is this the error that means the disk is full? */
export function isQuotaError(err) {
  if (!err) return false;
  return (
    err.name === "QuotaExceededError" ||
    err.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    err.code === 22 ||
    /quota/i.test(err.message ?? "")
  );
}

/**
 * Record that a write failed for want of room.
 *
 * Sticky on purpose: it stays up until the phone has room again and a write
 * succeeds, because the OOD needs to know that some taps did not land even
 * after the offending one has scrolled away.
 */
export function noteQuotaError(err) {
  state = { ...state, quotaError: err?.message || "The phone is out of storage." };
  announce();
  refreshEstimate();
  return state;
}

export function clearQuotaError() {
  if (!state.quotaError) return;
  state = { ...state, quotaError: null };
  announce();
}

/** The sentence shown to the OOD, or null when there is nothing wrong. */
export function storageWarning() {
  if (state.quotaError) {
    return (
      "THIS PHONE IS OUT OF STORAGE — the last thing you tapped may not have been saved. " +
      "Get signal so the day can sync, then free space on the phone. " +
      "Do not clear this app's data until the sync indicator says everything is synced."
    );
  }
  return null;
}

export function resetStorageState() {
  state = { persisted: null, quotaError: null, usage: null, quota: null };
}
