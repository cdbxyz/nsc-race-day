/* backend.js — the real push(batch) that sync.js drains the outbox into.
 *
 * sync.js knows nothing about Supabase; it just calls push(batch) and retries
 * whatever throws. This module is the whole of that contract.
 */

import * as api from "./supabase.js";
import * as db from "./db.js";

/* Parents before children. A batch can hold a race day, its races and their
   events all at once, and Postgres will reject a race whose race_day has not
   landed yet — so rows go up in dependency order regardless of tap order. */
const TABLE_ORDER = [
  "classes",
  "helms",
  "boats",
  "series",
  "race_days",
  "races",
  "entries",
  "checklist_templates",
  "checklist_runs",
  "race_events",
];

// A table not in the list sorts last rather than first: indexOf gives -1 for
// anything unlisted, which would otherwise send a future table ahead of the
// parents it depends on.
function rank(table) {
  const i = TABLE_ORDER.indexOf(table);
  return i === -1 ? Number.MAX_SAFE_INTEGER : i;
}

/** Dependencies are injected so the ordering rules can be tested directly. */
export function createSupabaseBackend({ upsert, remove, isSignedIn }) {
  return {
    name: "supabase",

    async push(batch) {
      if (!isSignedIn()) {
        // Not signed in yet. Throwing keeps the batch queued rather than
        // dropping it — the PIN prompt is a UI problem, not a data problem.
        throw new Error("not signed in");
      }

      // Deletes are rare (a boat signed on by mistake) and reorder badly
      // against upserts — delete-then-recreate and create-then-delete mean
      // opposite things. When one is present, give up the batching and replay
      // the batch exactly as it was tapped.
      if (batch.some((entry) => entry.op === "delete")) {
        for (const entry of batch) {
          if (entry.op === "delete") await remove(entry.table, entry.id);
          else await upsert(entry.table, [entry.row]);
        }
        return;
      }

      const byTable = new Map();
      for (const entry of batch) {
        if (!byTable.has(entry.table)) byTable.set(entry.table, new Map());
        // A batch can carry the same row twice (written, then written again).
        // Last one wins, and one row per id keeps the upsert unambiguous.
        byTable.get(entry.table).set(entry.id, entry.row);
      }

      const tables = [...byTable.keys()].sort((a, b) => rank(a) - rank(b));

      for (const table of tables) {
        await upsert(table, [...byTable.get(table).values()]);
      }
    },
  };
}

export const supabaseBackend = createSupabaseBackend({
  upsert: api.upsert,
  remove: api.remove,
  isSignedIn: api.isSignedIn,
});

/* ---------------------------------------------------------------------------
 * Reference data
 *
 * Pulled down whenever there is signal so the boat register, helms and season
 * wins are on the phone before it goes out of range. Written with bulkPut, so
 * none of it bounces straight back up the outbox.
 * ------------------------------------------------------------------------ */

const REFERENCE_TABLES = ["classes", "boats", "helms", "checklist_templates"];

export const LAST_REFRESHED_KEY = "reference_last_refreshed";

/**
 * Refresh the cached reference data.
 * @returns {Promise<{at:number, counts:object}>}
 */
export async function pullReferenceData() {
  if (!api.isSignedIn()) throw new Error("not signed in");

  const counts = {};
  for (const table of REFERENCE_TABLES) {
    const rows = await api.select(table);
    await db.bulkPut(table, rows);
    counts[table] = rows.length;
  }

  // Season wins drive the handicap factor at sign-on, so they are cached with
  // the rest and read from cache when offline (ARCHITECTURE.md section 5).
  const wins = await api.select("helm_season_wins");
  await db.setMeta("helm_season_wins", wins);
  counts.helm_season_wins = wins.length;

  const at = Date.now();
  await db.setMeta(LAST_REFRESHED_KEY, at);
  // A successful pull is proof the server answered, which is what the sync
  // pill reports — otherwise a fresh sign-in with an empty outbox has nothing
  // to show for itself.
  await db.recordServerContact(at);
  return { at, counts };
}

/** When the reference data was last successfully pulled, or null. */
export async function lastRefreshedAt() {
  return (await db.getMeta(LAST_REFRESHED_KEY)) ?? null;
}

/**
 * Cached season wins, as the rows the helm_season_wins view returns:
 * `[{ helm_id, season, wins }]`. Kept in that shape because that is what
 * handicap.js's winsForHelm() takes.
 */
export async function cachedSeasonWins() {
  return (await db.getMeta("helm_season_wins")) ?? [];
}
