/* sync.js — drains the outbox to a backend, forgivingly.
 *
 * The beach has patchy 4G, so this module assumes failure is normal. It pushes
 * outbox entries oldest-first in small batches, retries with exponential
 * backoff, and never removes an entry until the backend has confirmed it.
 *
 * Retries are safe because every push is an upsert keyed on the row's
 * client-generated UUID: a request that actually succeeded but whose response
 * was lost does no damage when it is sent again.
 *
 * Batches stay strictly in seq order and a failing batch blocks the ones behind
 * it. That is deliberate — a race can't be inserted before its race_day.
 */

import * as db from "./db.js";

const BATCH_SIZE = 25;
const BASE_DELAY = 1000;
const MAX_DELAY = 30_000;

/**
 * @param {object} deps
 * @param {{name:string, push:(batch:object[])=>Promise<void>}} deps.backend
 */
/* Who to tell when the sync destination changes.
 *
 * Module-level rather than per-instance because the banner is a property of
 * the app, not of a particular sync engine, and tests construct throwaway
 * engines constantly without wanting to repaint anything. */
const backendListeners = new Set();

export function onBackendChange(fn) {
  backendListeners.add(fn);
  return () => backendListeners.delete(fn);
}

function announceBackend(name) {
  for (const fn of backendListeners) {
    try {
      fn(name);
    } catch (err) {
      console.error("backend listener failed", err);
    }
  }
}

export function createSync({
  backend: initialBackend,
  setTimeout: setTimer = globalThis.setTimeout.bind(globalThis),
  clearTimeout: clearTimer = globalThis.clearTimeout.bind(globalThis),
  isOnline = () => globalThis.navigator?.onLine !== false,
  batchSize = BATCH_SIZE,
  baseDelay = BASE_DELAY,
  maxDelay = MAX_DELAY,
  // ±20% so a fleet of devices coming back into signal doesn't stampede.
  jitter = () => 0.8 + Math.random() * 0.4,
} = {}) {
  let backend = initialBackend;
  const listeners = new Set();
  let status = {
    state: "synced", pending: 0, blocked: 0,
    lastSyncedAt: null, lastError: null,
    // True when the only thing standing between the outbox and the club
    // database is a PIN. Nothing is lost; somebody just has to type it.
    needsAuth: false,
  };
  let inFlight = false;
  let inFlightPromise = null;
  let consecutiveFailures = 0;
  let lastDelay = 0;
  let timer = null;
  let unwire = null;

  function emit(next) {
    const merged = { ...status, ...next };
    const unchanged =
      merged.state === status.state &&
      merged.pending === status.pending &&
      merged.blocked === status.blocked &&
      merged.lastSyncedAt === status.lastSyncedAt &&
      merged.lastError === status.lastError &&
      merged.needsAuth === status.needsAuth;
    status = merged;
    if (unchanged) return;
    for (const fn of listeners) {
      try {
        fn(status);
      } catch (err) {
        console.error("sync listener failed", err);
      }
    }
  }

  function stateFor(pending, blocked = 0) {
    // Something the server refused outright needs a human, and saying so
    // outranks reporting the connection.
    if (blocked > 0) return "error";
    if (!isOnline()) return "offline";
    // One or two failed pushes on patchy signal is business as usual; only call
    // it an error once it looks like something is actually wrong.
    if (pending > 0 && consecutiveFailures >= 3) return "error";
    return pending > 0 ? "waiting" : "synced";
  }

  async function refreshStatus(extra = {}) {
    const pending = await db.countOutbox();
    const blocked = await db.countBlocked();
    // Read the stamp rather than trusting memory: it survives reloads, and a
    // reference-data pull counts as contact just as much as a flush does.
    const lastSyncedAt = await db.lastServerContact();
    emit({ pending, blocked, lastSyncedAt, state: stateFor(pending, blocked), ...extra });
    return pending;
  }

  function scheduleRetry() {
    if (timer !== null) clearTimer(timer);
    const raw = baseDelay * 2 ** Math.max(0, consecutiveFailures - 1);
    lastDelay = Math.round(Math.min(maxDelay, raw) * jitter());
    timer = setTimer(() => {
      timer = null;
      flush();
    }, lastDelay);
  }

  /**
   * Push everything currently queued. Safe to call at any time and from
   * anywhere — concurrent calls collapse into the one already running, AND
   * WAIT FOR IT.
   *
   * That waiting is the whole point. This used to return `status` the instant
   * it saw another flush in flight, so `await sync.flush()` did not await
   * anything. Every localWrite triggers a flush, so a caller that wrote a row
   * and then flushed was always the re-entrant one — which is why closing the
   * race day reported "2 records are still only on this phone" every single
   * time and a refresh showed none: the two rows closeDay had just written
   * were still in the outbox when it counted them, and had gone a moment
   * later. Worse than the wrong number, the last push before the phone goes
   * in a pocket for a week was quietly being skipped.
   */
  function flush() {
    if (inFlightPromise) return inFlightPromise;
    inFlightPromise = runFlush().finally(() => {
      inFlightPromise = null;
    });
    return inFlightPromise;
  }

  async function runFlush() {
    if (!isOnline()) {
      await refreshStatus();
      return status;
    }
    inFlight = true;
    try {
      for (;;) {
        const batch = await db.peekOutbox(batchSize);
        if (!batch.length) {
          consecutiveFailures = 0;
          lastDelay = 0;
          if (timer !== null) {
            clearTimer(timer);
            timer = null;
          }
          await refreshStatus({ lastError: null, needsAuth: false });
          break;
        }
        try {
          await backend.push(batch);
        } catch (err) {
          const message = String(err && err.message ? err.message : err);

          // A request the server will refuse every time — a malformed row, a
          // constraint violation — must not be retried forever. Retrying it
          // would also strand every event tapped after it, because batches go
          // up in order. Set it aside instead: still on the phone, still in
          // the outbox, no longer blocking the race behind it.
          if (err?.retryable === false) {
            await db.markOutboxBlocked(batch.map((e) => e.seq), err);
            await refreshStatus({ lastError: message });
            continue;
          }

          consecutiveFailures += 1;
          await db.markOutboxAttempt(batch.map((e) => e.seq), err);
          await refreshStatus({ lastError: message, needsAuth: Boolean(err?.needsAuth) });
          scheduleRetry();
          break;
        }
        // Only now is it safe to forget these — the backend has them.
        await db.clearOutbox(batch.map((e) => e.seq));
        consecutiveFailures = 0;
        await db.recordServerContact();
        await refreshStatus({ lastError: null, needsAuth: false });
      }
    } finally {
      inFlight = false;
    }
    return status;
  }

  /**
   * Push, and keep pushing until there is genuinely nothing left.
   *
   * A single flush can finish before rows written DURING it reach the queue,
   * so anything that has just written and then wants an honest count — the
   * end of the race day, above all — needs to settle rather than flush once.
   *
   * Bounded, and it gives up the moment trying again would be pointless:
   * offline, signed out, or a batch that just failed. Those are all states
   * where rows legitimately remain and the count should say so.
   */
  async function settle({ passes = 3 } = {}) {
    for (let i = 0; i < passes; i += 1) {
      await flush();
      if ((await db.countOutbox()) === 0) break;
      if (!isOnline() || status.needsAuth || consecutiveFailures > 0) break;
    }
    await refreshStatus();
    return status;
  }

  /** Subscribe to status changes. Fires immediately with the current status. */
  function subscribe(fn) {
    listeners.add(fn);
    fn(status);
    return () => listeners.delete(fn);
  }

  /** Wire up the triggers and do a first drain. */
  function start() {
    if (unwire) return;
    const onOnline = () => flush();
    const onOffline = () => refreshStatus();
    const onVisible = () => {
      if (globalThis.document?.visibilityState === "visible") flush();
    };
    const offWrite = db.onWrite(() => flush());

    globalThis.addEventListener?.("online", onOnline);
    globalThis.addEventListener?.("offline", onOffline);
    globalThis.document?.addEventListener?.("visibilitychange", onVisible);

    unwire = () => {
      offWrite();
      globalThis.removeEventListener?.("online", onOnline);
      globalThis.removeEventListener?.("offline", onOffline);
      globalThis.document?.removeEventListener?.("visibilitychange", onVisible);
    };

    refreshStatus().then(() => flush());
  }

  function stop() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (unwire) unwire();
    unwire = null;
  }

  return {
    flush,
    subscribe,
    settle,
    start,
    stop,
    refreshStatus,
    /** Swap the destination — the dev panel points at the fake backend to
        rehearse bad signal without touching the club's real data. */
    setBackend(next) {
      const changed = backend?.name !== next?.name;
      backend = next;
      consecutiveFailures = 0;
      // devmode.js listens: switching the destination away from Supabase has
      // to repaint the TEST MODE banner immediately, not at the next render.
      if (changed) announceBackend(next?.name ?? null);
    },
    get status() {
      return status;
    },
    /** Diagnostics for the dev panel and tests. */
    stats() {
      return { consecutiveFailures, lastDelay, inFlight, backend: backend.name };
    },
  };
}

/**
 * A stand-in for Supabase. Logs what it is asked to push, fails a configurable
 * share of the time, and stores rows by id so replaying a batch can be shown to
 * change nothing. The dev panel points sync at this to rehearse bad signal
 * without writing to the club's real database.
 */
export function createFakeBackend({ failureRate = 0.3, latency = 150 } = {}) {
  const rows = new Map(); // `${table}:${id}` -> row

  return {
    name: "fake",
    failureRate,
    latency,
    /** Everything the backend has "stored", for assertions and the dev panel. */
    rows,
    async push(batch) {
      await new Promise((r) => setTimeout(r, this.latency));
      if (Math.random() < this.failureRate) {
        console.warn(`[sync] fake backend rejected ${batch.length} entries`);
        throw new Error("fake backend: network unavailable");
      }
      for (const entry of batch) {
        // An upsert: same id twice leaves exactly one row.
        rows.set(`${entry.table}:${entry.id}`, entry.row);
      }
      console.info(
        `[sync] pushed ${batch.length} entries (${batch.map((e) => e.table).join(", ")})`
      );
    },
  };
}

export const fakeBackend = createFakeBackend();

/* The instance the app uses. app.js points it at Supabase on boot; it starts
   on the fake backend so importing this module never reaches the network. */
export const sync = createSync({ backend: fakeBackend });
