/* Hardening: the soft device lock, the recorded status override, and the
 * device-clock sanity check.
 *
 * The thread running through all three is that a silent failure is worse than
 * a loud one. Two phones recording the same race, a status forced by hand
 * with no trace, and a phone an hour out all produce data that looks entirely
 * normal and is wrong.
 */

import "fake-indexeddb/auto";
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as db from "../js/db.js";
import * as rd from "../js/raceday.js";
import * as reg from "../js/registers.js";
import * as log from "../js/raceevents.js";
import * as device from "../js/device.js";
import { liveEvents } from "../js/state.js";
import {
  noteServerDate,
  clockWarning,
  clockOffset,
  resetClockCheck,
  onClockChange,
  TOLERANCE_MS,
} from "../js/clockcheck.js";

beforeEach(async () => {
  await db.clearAll();
  device.resetDeviceCache();
  resetClockCheck();
});
after(() => db.closeDB());

/* ---- device identity ---------------------------------------------------- */

test("a device id is created once and then kept", async () => {
  const first = await device.deviceId();
  const second = await device.deviceId();
  assert.equal(first, second);

  // Even across a cache reset, which is what a page reload amounts to.
  device.resetDeviceCache();
  assert.equal(await device.deviceId(), first);
});

test("the device id lives with the race data, not beside it", async () => {
  /* In IndexedDB rather than localStorage on purpose: a wiped phone is a new
     device, which is correct, because it has no unsynced events to protect. */
  const source = await readFile(new URL("../js/device.js", import.meta.url), "utf8");
  // Comments may discuss localStorage; code may not use it.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/localStorage|sessionStorage/.test(code));

  await device.deviceId();
  assert.ok(await db.getMeta("device_id"), "stored in meta");
});

test("an unnamed device falls back to a kind, never to an id", async () => {
  /* The banner's whole job is to let an OOD recognise which phone is holding
     the day. "iPhone" is a poor label; "Device 74b9eb" is a useless one. */
  const fallback = await device.deviceName();
  assert.equal(fallback, device.defaultDeviceName());
  assert.ok(!/^Device [0-9a-f]{6}$/.test(fallback), "never a raw id");
  assert.equal(await device.isNamed(), false);

  await device.setDeviceName("Chris's iPhone");
  assert.equal(await device.deviceName(), "Chris's iPhone");
  assert.equal(await device.isNamed(), true);
});

test("the suggested name is built from the OOD's own name", () => {
  // They type it at setup anyway, so the useful half is already on screen.
  const kind = device.defaultDeviceName();
  assert.equal(device.suggestDeviceName("Chris"), `Chris's ${kind}`);
  assert.equal(device.suggestDeviceName("Gareth"), `Gareth's ${kind}`);
  assert.equal(device.suggestDeviceName("Rhys"), `Rhys's ${kind}`, "'s even after an s");
  assert.equal(device.suggestDeviceName("  "), kind, "no owner, no possessive");
});

test("a name can be cleared back to the default", async () => {
  await device.setDeviceName("Chris's iPhone");
  await device.setDeviceName("   ");
  assert.equal(await device.isNamed(), false);
  assert.equal(await device.deviceName(), device.defaultDeviceName());
});

test("the claim carries the name, so the other phone can read it", async () => {
  await device.setDeviceName("Chris's iPhone");
  const claimed = await device.claimRaceDay({ id: "d1", claimed_by: null });
  assert.equal(claimed.claimed_by_name, "Chris's iPhone");
});

test("the takeover prompt is given this phone's name to prefill", async () => {
  await device.setDeviceName("Chris's iPhone");
  const claim = await device.claimState({ id: "d1", claimed_by: "other", claimed_by_name: "Gareth's iPhone" });
  assert.equal(claim.byName, "Gareth's iPhone", "who holds it");
  assert.equal(claim.myName, "Chris's iPhone", "and who is asking");
});

/* ---- the soft lock ------------------------------------------------------ */

test("the phone that sets the day up owns it", async () => {
  const { raceDay } = await rd.createRaceDay({ date: "2026-08-16", oodName: "Chris" });
  assert.equal(raceDay.claimed_by, await device.deviceId());

  const claim = await device.claimState(raceDay);
  assert.equal(claim.state, "owner");
  assert.equal(claim.canRecord, true);
});

test("a second phone can see the day but not record on it", async () => {
  const { raceDay } = await rd.createRaceDay({ date: "2026-08-16", oodName: "Chris" });

  // What the other phone sees: same row, different device id.
  const asOtherPhone = { ...raceDay, claimed_by: "some-other-device", claimed_by_name: "Gareth's phone" };
  const claim = await device.claimState(asOtherPhone);

  assert.equal(claim.state, "observer");
  assert.equal(claim.canRecord, false);
  assert.equal(claim.byName, "Gareth's phone");
});

test("a day nobody has claimed is not read-only for everybody", async () => {
  /* Days created before this feature existed, and days pulled down from the
     club database, carry no claim. Locking those out would be a regression
     that bricks the app for the one person still running it. */
  const claim = await device.claimState({ id: "d1", claimed_by: null });
  assert.equal(claim.state, "unclaimed");
  assert.equal(claim.canRecord, true);
});

test("taking over is one act, and the last claim wins", async () => {
  const { raceDay } = await rd.createRaceDay({ date: "2026-08-16", oodName: "Chris" });
  const stolen = { ...raceDay, claimed_by: "other", claimed_by_name: "Gareth's phone" };
  assert.equal((await device.claimState(stolen)).canRecord, false);

  const reclaimed = await device.claimRaceDay(stolen);
  assert.equal(reclaimed.claimed_by, await device.deviceId());
  assert.equal((await device.claimState(reclaimed)).canRecord, true);
});

test("a takeover destroys nothing the losing device recorded", async () => {
  /* The whole reason the lock is soft. The phone that just lost the claim is
     often holding the only copy of the last few taps, and discarding
     unsynced events is the one unrecoverable act in this system. */
  const klass = await reg.createClass({ name: "Solo", basePy: 1142 });
  const helm = await reg.createMember({ name: "Hamish Fowler" });
  const { raceDay } = await rd.createRaceDay({ date: "2026-08-16", oodName: "Chris" });
  const [race] = await rd.racesForDay(raceDay.id);
  const context = await rd.handicapContext(2026);
  const entry = await rd.addEntry({ race, klass, helmId: helm.id, context });
  await log.recordLap(race.id, entry.id);
  await log.recordLap(race.id, entry.id);

  const eventsBefore = await log.eventsForRace(race.id);
  const outboxBefore = (await db.allOutbox()).length;

  await device.claimRaceDay({ ...raceDay, claimed_by: "other" });

  assert.deepEqual(
    (await log.eventsForRace(race.id)).map((e) => e.id),
    eventsBefore.map((e) => e.id),
    "every event survives"
  );
  assert.ok((await db.allOutbox()).length >= outboxBefore, "and is still queued to sync");
});

test("claimIfUnclaimed never steals", async () => {
  const held = { id: "d1", claimed_by: "other", claimed_by_name: "Gareth's phone" };
  assert.equal((await device.claimIfUnclaimed(held)).claimed_by, "other");

  const free = { id: "d2", claimed_by: null };
  assert.equal((await device.claimIfUnclaimed(free)).claimed_by, await device.deviceId());
});

test("the claim syncs like any other row", async () => {
  // It has to reach the other phone, so it goes through localWrite.
  const { raceDay } = await rd.createRaceDay({ date: "2026-08-16", oodName: "Chris" });
  await db.clearAll();
  await device.claimRaceDay({ ...raceDay, claimed_by: "other" });
  const outbox = await db.allOutbox();
  assert.ok(outbox.some((e) => e.table === "race_days"), "queued for the club database");
});

/* ---- the recorded status override --------------------------------------- */

test("forcing a status writes an event carrying before and after", async () => {
  const { raceDay } = await rd.createRaceDay({ date: "2026-08-16", oodName: "Chris" });
  const [race] = await rd.racesForDay(raceDay.id);

  await log.overrideStatus(race.id, { from: race.status, to: "finished" });

  const events = await log.eventsForRace(race.id);
  const override = events.find((e) => e.type === "status_overridden");
  assert.ok(override, "recorded at all");
  assert.equal(override.payload.from, "setup");
  assert.equal(override.payload.to, "finished");
});

test("the override is an ordinary event — undoable, and in the history", async () => {
  const { raceDay } = await rd.createRaceDay({ date: "2026-08-16", oodName: "Chris" });
  const [race] = await rd.racesForDay(raceDay.id);
  const written = await log.overrideStatus(race.id, { from: "racing", to: "setup" });

  let events = await log.eventsForRace(race.id);
  assert.equal(liveEvents(events).filter((e) => e.type === "status_overridden").length, 1);

  await log.undoEvent(race.id, written.id);
  events = await log.eventsForRace(race.id);
  assert.equal(
    liveEvents(events).filter((e) => e.type === "status_overridden").length,
    0,
    "undone like anything else"
  );
});

test("the new event type ships with its CHECK constraint", async () => {
  /* CLAUDE.md's rule: an unknown type is refused by the server and the row
     quarantines in the outbox, taking the rest of the day's sync with it. */
  const migration = await readFile(
    new URL("../supabase/migrations/016_status_override_and_device_claim.sql", import.meta.url),
    "utf8"
  );
  assert.match(migration, /'status_overridden'/);
  assert.match(migration, /race_events_type_check/);
});

test("the dev override is armed, not a bare select", async () => {
  const source = await readFile(new URL("../js/pages/dev.js", import.meta.url), "utf8");
  assert.match(source, /armedButton\("dev\.status"/);
  assert.match(source, /overrideStatus/);
  // And the event is written before the status it explains.
  const apply = source.slice(source.indexOf('armedButton("dev.status"'));
  assert.ok(
    apply.indexOf("overrideStatus") < apply.indexOf('localWrite("races"'),
    "the record must exist before the thing it describes"
  );
});

/* ---- the device clock --------------------------------------------------- */

const dateHeaders = (at) => new Headers({ date: new Date(at).toUTCString() });

test("a phone agreeing with the server says nothing", () => {
  const now = Date.now();
  noteServerDate(dateHeaders(now), now);
  assert.equal(clockWarning(), null);
});

test("network latency is not mistaken for a wrong clock", () => {
  const now = Date.now();
  // A slow reply on one bar of 4G: seconds, not minutes.
  noteServerDate(dateHeaders(now - 8_000), now);
  assert.equal(clockWarning(), null);
  assert.ok(Math.abs(clockOffset()) < TOLERANCE_MS);
});

test("a phone an hour ahead is told so, and told what it means", () => {
  const now = Date.now();
  noteServerDate(dateHeaders(now - 3_600_000), now);

  const warning = clockWarning();
  assert.match(warning, /1 hours|60 minutes/);
  assert.match(warning, /ahead of/);
  assert.match(warning, /gun, every lap, every finish/);
});

test("a phone behind the server is described as behind", () => {
  const now = Date.now();
  noteServerDate(dateHeaders(now + 7_200_000), now);
  assert.match(clockWarning(), /behind/);
});

test("no reply from the server means no claim about the clock", () => {
  assert.equal(clockOffset(), null);
  assert.equal(clockWarning(), null, "silence, not a false all-clear");

  noteServerDate(null);
  assert.equal(clockOffset(), null);
  noteServerDate(new Headers({}));
  assert.equal(clockOffset(), null, "a reply with no Date header proves nothing");
});

test("an unparseable Date header is ignored rather than believed", () => {
  noteServerDate(new Headers({ date: "not a date" }));
  assert.equal(clockOffset(), null);
});

test("subscribers hear about a bad clock as soon as it is measured", () => {
  const seen = [];
  const off = onClockChange((warning) => seen.push(Boolean(warning)));
  const now = Date.now();

  noteServerDate(dateHeaders(now), now);
  noteServerDate(dateHeaders(now - 3_600_000), now);

  assert.deepEqual(seen, [false, true]);
  off();
});

test("the check is advisory: it never rewrites a timestamp", async () => {
  const source = await readFile(new URL("../js/clockcheck.js", import.meta.url), "utf8");
  assert.ok(
    !/localWrite|occurred_at\s*=|setMeta/.test(source),
    "it observes the clock and does nothing else"
  );
});

test("every Supabase reply is used, including error replies", async () => {
  /* A 403 still proves what time the server thinks it is, and a phone that
     cannot sign in is exactly the one whose clock might be the problem. */
  const source = await readFile(new URL("../js/supabase.js", import.meta.url), "utf8");
  // Scoped to request(), because other functions have their own !res.ok checks.
  const fn = source.slice(source.indexOf("async function request("));
  const call = fn.indexOf("noteServerDate(res.headers)");
  assert.ok(call > 0, "called at all");
  assert.ok(call < fn.indexOf("if (!res.ok)"), "before the error path returns");
});
