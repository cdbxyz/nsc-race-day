/* The seam between the cached reference data and the handicap engine.
 *
 * handicap.test.js checks winsForHelm() against hand-built arrays, which is
 * exactly why it did not catch the bug that mattered: cachedSeasonWins()
 * returned a Map, winsForHelm() expects the view's rows, and sign-on broke the
 * moment a helm had a cached win. Both sides passed their own tests.
 *
 * So these tests go through the real path — the refresh code writes the cache,
 * and the handicap engine reads it — with nothing hand-built in between.
 */

import "fake-indexeddb/auto";
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import * as db from "../js/db.js";
import { cachedSeasonWins, lastRefreshedAt, createReferenceSync } from "../js/backend.js";
import { winsForHelm, factorFor } from "../js/handicap.js";

beforeEach(() => db.clearAll());
after(() => db.closeDB());

const HAMISH = "22222222-0000-0000-0000-00000000000a";
const SEASON = 2026;

/**
 * Stand in for Supabase, returning what the real tables and the
 * helm_season_wins view return. pullReferenceData is driven for real.
 */
function fakeServer({ wins = [] } = {}) {
  const tables = {
    classes: [{ id: "c1", name: "Laser 2000", base_py: 1122 }],
    boats: [{ id: "b1", name: "Vaila", class_id: "c1", active: true }],
    helms: [{ id: HAMISH, name: "Hamish" }],
    checklist_templates: [],
    helm_season_wins: wins,
  };
  return {
    select: async (table) => tables[table] ?? [],
    tables,
  };
}

/* The real refresh code, pointed at the stand-in server. Nothing about the
   cache is hand-written: pullReferenceData writes it, cachedSeasonWins reads
   it, and winsForHelm consumes it. */
function refreshWith(server) {
  return createReferenceSync({ select: server.select, isSignedIn: () => true })();
}

test("a cached win flows through to the factor without hand-building anything", async () => {
  const server = fakeServer({
    wins: [{ helm_id: HAMISH, season: SEASON, wins: 1 }],
  });
  await refreshWith(server);

  // Exactly what raceday.handicapContext() does.
  const cached = await cachedSeasonWins();
  const wins = winsForHelm(HAMISH, SEASON, cached, [], { cachedAt: await lastRefreshedAt() });

  assert.equal(wins, 1);
  assert.equal(factorFor(wins), 0.97);
});

test("cachedSeasonWins returns something winsForHelm can actually read", () => {
  // The shape assertion the earlier bug needed. A Map has no .find, and
  // winsForHelm would throw the moment a helm had a win.
  return (async () => {
    await refreshWith(fakeServer({ wins: [{ helm_id: HAMISH, season: SEASON, wins: 2 }] }));
    const cached = await cachedSeasonWins();

    assert.ok(Array.isArray(cached), "must be the view's rows, not a Map or an index");
    assert.equal(typeof cached.find, "function");
    assert.deepEqual(Object.keys(cached[0]).sort(), ["helm_id", "season", "wins"]);
  })();
});

test("an empty cache reads as no wins rather than throwing", async () => {
  await refreshWith(fakeServer({ wins: [] }));
  const cached = await cachedSeasonWins();
  assert.deepEqual(cached, []);
  assert.equal(winsForHelm(HAMISH, SEASON, cached), 0);
});

test("a phone that has never refreshed reads as no wins", async () => {
  const cached = await cachedSeasonWins();
  assert.deepEqual(cached, [], "never pulled, so nothing cached");
  assert.equal(winsForHelm(HAMISH, SEASON, cached, [], { cachedAt: await lastRefreshedAt() }), 0);
});

test("a same-day local win stacks on the refreshed cache, through the real seam", async () => {
  const server = fakeServer({ wins: [{ helm_id: HAMISH, season: SEASON, wins: 1 }] });
  await refreshWith(server);

  const cachedAt = await lastRefreshedAt();
  const localWins = [
    { helm_id: HAMISH, season: SEASON, published_at: new Date(cachedAt + 60_000).toISOString() },
  ];

  const wins = winsForHelm(HAMISH, SEASON, await cachedSeasonWins(), localWins, { cachedAt });
  assert.equal(wins, 2, "Race 1's win counts on top of what the server knew");
  assert.equal(factorFor(wins), 0.96);
});

test("a refresh after the local win does not double-count it", async () => {
  // The server has now caught up: its total already includes this morning.
  const publishedAt = Date.now() - 60_000;
  const server = fakeServer({ wins: [{ helm_id: HAMISH, season: SEASON, wins: 2 }] });
  await refreshWith(server);

  const localWins = [
    { helm_id: HAMISH, season: SEASON, published_at: new Date(publishedAt).toISOString() },
  ];

  const wins = winsForHelm(HAMISH, SEASON, await cachedSeasonWins(), localWins, {
    cachedAt: await lastRefreshedAt(),
  });
  assert.equal(wins, 2, "not 3");
});

test("the real refresh writes every register plus the wins cache", async () => {
  const server = fakeServer({ wins: [{ helm_id: HAMISH, season: SEASON, wins: 3 }] });

  const { counts } = await refreshWith(server);

  assert.deepEqual(counts, {
    classes: 1, boats: 1, helms: 1, checklist_templates: 0, helm_season_wins: 1,
  });
  assert.equal((await db.getAll("boats")).length, 1, "registers land in IndexedDB");

  // And the wins are readable by the engine that needs them.
  const wins = winsForHelm(HAMISH, SEASON, await cachedSeasonWins());
  assert.equal(wins, 3);
  assert.equal(factorFor(wins), 0.95, "capped");
});

test("the refresh does not queue the pulled rows back up the outbox", async () => {
  await refreshWith(fakeServer({ wins: [] }));
  assert.equal(await db.countOutbox(), 0, "reference data comes down, it does not go back up");
});

test("a refresh without a session refuses rather than clearing the cache", async () => {
  await refreshWith(fakeServer({ wins: [{ helm_id: HAMISH, season: SEASON, wins: 1 }] }));

  const offline = createReferenceSync({ select: async () => [], isSignedIn: () => false });
  await assert.rejects(() => offline(), /not signed in/);

  assert.equal(winsForHelm(HAMISH, SEASON, await cachedSeasonWins()), 1, "cache survives");
});
