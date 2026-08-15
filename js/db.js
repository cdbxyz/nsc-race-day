/* db.js — IndexedDB wrapper and outbox.
 *
 * On race day the phone is the source of truth. Every user action lands here
 * synchronously before anything else happens (ARCHITECTURE.md D1), and only
 * afterwards does sync.js try to get it to Supabase.
 *
 * The one rule that matters in this file: localWrite() puts the row and its
 * outbox entry in ONE transaction and resolves only when that transaction
 * COMMITS. If it resolves, the tap survived. If it rejects, nothing was
 * written at all — never half.
 */

const DB_NAME = "nsc-race-day";
const DB_VERSION = 1;

/* Table stores mirror the Supabase schema in ARCHITECTURE.md section 4.
   Everything here is keyed on a client-generated UUID, which is also the
   upsert key on the server — that is what makes sync retries idempotent. */
export const TABLES = [
  "classes",
  "boats",
  "helms",
  "race_days",
  "series",
  "races",
  "entries",
  "race_events",
  "checklist_templates",
  "checklist_runs",
];

const INDEXES = {
  boats: { by_class: "class_id" },
  race_days: { by_status: "status" },
  races: { by_race_day: "race_day_id", by_status: "status" },
  entries: { by_race: "race_id", by_boat: "boat_id" },
  race_events: { by_race: "race_id", by_occurred_at: "occurred_at" },
  checklist_runs: { by_race_day: "race_day_id" },
};

/* Test seam. Tests set beforeCommit to make the transaction fail after both
   writes have been issued, proving localWrite() is genuinely atomic — neither
   half survives. Always null in the app. */
export const _hooks = { beforeCommit: null };

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    // Read indexedDB at call time, not import time, so tests can substitute it.
    const req = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const table of TABLES) {
        if (db.objectStoreNames.contains(table)) continue;
        const store = db.createObjectStore(table, { keyPath: "id" });
        for (const [name, keyPath] of Object.entries(INDEXES[table] || {})) {
          store.createIndex(name, keyPath);
        }
      }
      // seq + autoIncrement gives the outbox guaranteed FIFO ordering, which
      // sync.js relies on: a race_day must reach the server before its races.
      if (!db.objectStoreNames.contains("outbox")) {
        db.createObjectStore("outbox", { keyPath: "seq", autoIncrement: true });
      }
      // Small key/value scratch: last-refreshed stamps, device id, and so on.
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another tab"));
  });
  return dbPromise;
}

/** Close the connection and forget it. Used by the dev panel and by tests. */
export async function closeDB() {
  if (!dbPromise) return;
  const db = await dbPromise.catch(() => null);
  if (db) db.close();
  dbPromise = null;
}

export function newId() {
  return crypto.randomUUID();
}

/**
 * The current time, in the form every timestamp column expects.
 *
 * CONVENTION: anything destined for a Postgres `timestamptz` — created_at,
 * occurred_at, start_at, published_at — is stored as an ISO 8601 string, in
 * IndexedDB as well as in Supabase. Epoch milliseconds are rejected outright
 * by Postgres ("date/time field value out of range"), and because the outbox
 * drains in order, one such row would block every event behind it.
 *
 * ISO strings also sort correctly as strings, so local ordering still works.
 * Purely local values (the outbox's own bookkeeping, meta stamps) stay as
 * numbers — they never leave the device.
 */
export function nowIso() {
  return new Date().toISOString();
}

/* ---- write notification -------------------------------------------------
   db.js must not import sync.js (sync.js imports db.js), so instead anyone
   interested in "something was just written" subscribes here. */
const writeListeners = new Set();

export function onWrite(fn) {
  writeListeners.add(fn);
  return () => writeListeners.delete(fn);
}

function notifyWrite() {
  for (const fn of writeListeners) {
    try {
      fn();
    } catch (err) {
      console.error("onWrite listener failed", err);
    }
  }
}

/* ---- promise helpers ---- */

function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Resolve when the transaction COMMITS, not when a request succeeds. A request
// can report success and still be rolled back if a later one in the same
// transaction fails, so oncomplete is the only trustworthy signal.
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
  });
}

/* ---- the core write ---- */

/**
 * Commit a row and its outbox entry in a single transaction.
 * Resolves only once that transaction has committed to disk.
 *
 * @param {string} table one of TABLES
 * @param {object} row must carry a client-generated `id`
 * @returns {Promise<object>} the row as written
 */
export async function localWrite(table, row) {
  if (!TABLES.includes(table)) throw new Error(`unknown table: ${table}`);
  if (!row || !row.id) throw new Error(`row for ${table} needs a client-generated id`);

  const db = await openDB();
  const tx = db.transaction([table, "outbox"], "readwrite");
  const done = txDone(tx);

  tx.objectStore(table).put(row);
  tx.objectStore("outbox").add({
    id: row.id, // the server upserts on this — replaying a batch is harmless
    table,
    op: "upsert",
    row,
    created_at: Date.now(),
    attempts: 0,
    last_error: null,
  });
  if (_hooks.beforeCommit) _hooks.beforeCommit(tx);

  await done;
  notifyWrite();
  return row;
}

/**
 * Remove a row and queue the removal, in one transaction.
 *
 * Only for rows that are records of intent rather than records of fact:
 * a boat signed on by mistake, a class typed wrong. Race events are
 * append-only and must never come through here — a mis-tapped lap is undone by
 * appending an `event_undone`, never by deleting the original.
 */
export async function localDelete(table, id) {
  if (!TABLES.includes(table)) throw new Error(`unknown table: ${table}`);
  if (table === "race_events") {
    throw new Error("race_events is append-only — append an event_undone instead");
  }
  if (!id) throw new Error(`localDelete needs an id`);

  const db = await openDB();
  const tx = db.transaction([table, "outbox"], "readwrite");
  const done = txDone(tx);

  tx.objectStore(table).delete(id);
  tx.objectStore("outbox").add({
    id,
    table,
    op: "delete",
    row: null,
    created_at: Date.now(),
    attempts: 0,
    last_error: null,
  });

  await done;
  notifyWrite();
}

/**
 * Write rows without queueing them for sync. For reference data pulled DOWN
 * from Supabase (boat register, helms, season wins) — pushing it back up would
 * be a pointless round trip.
 */
export async function bulkPut(table, rows) {
  if (!TABLES.includes(table)) throw new Error(`unknown table: ${table}`);
  if (!rows.length) return 0;
  const db = await openDB();
  const tx = db.transaction(table, "readwrite");
  const done = txDone(tx);
  const store = tx.objectStore(table);
  for (const row of rows) store.put(row);
  await done;
  return rows.length;
}

/* ---- reads ---- */

export async function get(table, id) {
  const db = await openDB();
  return reqDone(db.transaction(table, "readonly").objectStore(table).get(id));
}

export async function getAll(table) {
  const db = await openDB();
  return reqDone(db.transaction(table, "readonly").objectStore(table).getAll());
}

export async function getAllByIndex(table, index, value) {
  const db = await openDB();
  const store = db.transaction(table, "readonly").objectStore(table);
  return reqDone(store.index(index).getAll(value));
}

/* ---- meta ---- */

export async function getMeta(id) {
  const db = await openDB();
  const row = await reqDone(db.transaction("meta", "readonly").objectStore("meta").get(id));
  return row ? row.value : undefined;
}

/* When we last got a reply from the server — from either an outbox flush or a
   reference-data pull. Persisted so it survives a reload, because "All synced"
   with an empty outbox is otherwise indistinguishable from having never
   reached the server at all. */
export const LAST_CONTACT_KEY = "last_contact_at";

export async function recordServerContact(at = Date.now()) {
  return setMeta(LAST_CONTACT_KEY, at);
}

export async function lastServerContact() {
  return (await getMeta(LAST_CONTACT_KEY)) ?? null;
}

export async function setMeta(id, value) {
  const db = await openDB();
  const tx = db.transaction("meta", "readwrite");
  const done = txDone(tx);
  tx.objectStore("meta").put({ id, value });
  await done;
  return value;
}

/* ---- outbox, for sync.js ---- */

/**
 * The oldest `limit` entries still worth sending, in seq order.
 *
 * Blocked entries are skipped. They are never deleted — a blocked row is still
 * a race record — but they must not sit at the head of the queue holding up
 * everything tapped after them.
 */
export async function peekOutbox(limit) {
  const db = await openDB();
  const store = db.transaction("outbox", "readonly").objectStore("outbox");
  // getAll on an autoIncrement store returns key order, which is seq order.
  const all = await reqDone(store.getAll());
  const sendable = [];
  for (const entry of all) {
    if (entry.blocked) continue;
    sendable.push(entry);
    if (limit && sendable.length >= limit) break;
  }
  return sendable;
}

/** Entries still waiting to be sent. */
export async function countOutbox() {
  const db = await openDB();
  const store = db.transaction("outbox", "readonly").objectStore("outbox");
  const all = await reqDone(store.getAll());
  return all.filter((e) => !e.blocked).length;
}

/** Entries the server refused outright, still held on the device. */
export async function countBlocked() {
  const db = await openDB();
  const store = db.transaction("outbox", "readonly").objectStore("outbox");
  const all = await reqDone(store.getAll());
  return all.filter((e) => e.blocked).length;
}

/** Everything in the outbox, blocked included — for the dev panel. */
export async function allOutbox() {
  const db = await openDB();
  return reqDone(db.transaction("outbox", "readonly").objectStore("outbox").getAll());
}

/** Remove entries the backend has confirmed. */
export async function clearOutbox(seqs) {
  if (!seqs.length) return;
  const db = await openDB();
  const tx = db.transaction("outbox", "readwrite");
  const done = txDone(tx);
  const store = tx.objectStore("outbox");
  for (const seq of seqs) store.delete(seq);
  await done;
}

/**
 * Record a failed push attempt against entries so the dev panel can show why.
 * Purely diagnostic, so it reads and writes in one cursor walk rather than
 * awaiting mid-transaction (awaiting inside a transaction risks it committing
 * out from under us).
 */
export async function markOutboxAttempt(seqs, error) {
  if (!seqs.length) return;
  const wanted = new Set(seqs);
  const message = String(error && error.message ? error.message : error);
  const db = await openDB();
  const tx = db.transaction("outbox", "readwrite");
  const done = txDone(tx);
  const req = tx.objectStore("outbox").openCursor();
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return;
    if (wanted.has(cursor.key)) {
      const entry = cursor.value;
      entry.attempts = (entry.attempts || 0) + 1;
      entry.last_error = message;
      cursor.update(entry);
    }
    cursor.continue();
  };
  await done;
}

/**
 * Set aside entries the server will never accept, so the queue behind them can
 * drain. The row stays on the device and stays in the outbox; it is simply no
 * longer retried until someone looks at it.
 */
export async function markOutboxBlocked(seqs, error) {
  if (!seqs.length) return;
  const wanted = new Set(seqs);
  const message = String(error && error.message ? error.message : error);
  const db = await openDB();
  const tx = db.transaction("outbox", "readwrite");
  const done = txDone(tx);
  const req = tx.objectStore("outbox").openCursor();
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return;
    if (wanted.has(cursor.key)) {
      const entry = cursor.value;
      entry.blocked = true;
      entry.last_error = message;
      entry.blocked_at = Date.now();
      cursor.update(entry);
    }
    cursor.continue();
  };
  await done;
}

/** Put blocked entries back in the queue, after a fix has shipped. */
export async function unblockOutbox() {
  const db = await openDB();
  const tx = db.transaction("outbox", "readwrite");
  const done = txDone(tx);
  const req = tx.objectStore("outbox").openCursor();
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) return;
    if (cursor.value.blocked) {
      const entry = cursor.value;
      entry.blocked = false;
      entry.attempts = 0;
      cursor.update(entry);
    }
    cursor.continue();
  };
  await done;
}

/** Wipe everything. Dev panel only — this destroys race records. */
export async function clearAll() {
  const db = await openDB();
  const stores = [...TABLES, "outbox", "meta"];
  const tx = db.transaction(stores, "readwrite");
  const done = txDone(tx);
  for (const name of stores) tx.objectStore(name).clear();
  await done;
  notifyWrite();
}
