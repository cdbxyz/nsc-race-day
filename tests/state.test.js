/* Race state as a pure function of the event log.
 *
 * This is the module that makes killing the page mid-race safe, so it is
 * tested the way the beach will test it: undo, redo, postponement, general
 * recall, a shortened course, and a phone that was asleep when a mark passed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  SEQUENCE_MS,
  MARKS,
  liveEvents,
  lastUndoable,
  sequenceState,
  countdown,
  formatCountdown,
  phaseFor,
  marksCrossed,
  lapPlan,
  plannedLaps,
  boatState,
  nextAction,
  raceState,
  formatElapsed,
  formatSplits,
  raceClock,
  raceLabel,
  raceName,
} from "../js/state.js";

const RACE = { id: "r1", fast_laps: 3, slow_laps: 2, start_at: null };
const T0 = Date.parse("2026-08-15T13:00:00Z");
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();

let seq = 0;
function ev(type, props = {}) {
  seq += 1;
  return {
    id: props.id ?? `e${seq}`,
    race_id: "r1",
    entry_id: props.entry_id ?? null,
    type,
    payload: props.payload ?? null,
    occurred_at: props.occurred_at ?? at(seq),
  };
}
const undo = (target, occurred_at) =>
  ev("event_undone", { payload: { undoes: target }, occurred_at });

const entry = (id, fleet = "fast", laps_override = null) => ({ id, fleet, laps_override });

/* ---- undo and redo ------------------------------------------------------ */

test("an undone event stops counting", () => {
  const lap = ev("lap_recorded", { id: "lap1", entry_id: "en1" });
  const live = liveEvents([lap, undo("lap1")]);
  assert.deepEqual(live.map((e) => e.id), []);
});

test("undoing the undo brings the event back", () => {
  const lap = ev("lap_recorded", { id: "lap1", entry_id: "en1" });
  const first = undo("lap1", at(10));
  first.id = "u1";
  const live = liveEvents([lap, first, undo("u1", at(20))]);
  assert.deepEqual(live.map((e) => e.id), ["lap1"], "a redo");
});

test("undo events never appear as state themselves", () => {
  const live = liveEvents([ev("lap_recorded", { id: "l1", entry_id: "en1" }), undo("nothing")]);
  assert.deepEqual(live.map((e) => e.type), ["lap_recorded"]);
});

test("events come back in the order they happened, not the order they synced", () => {
  const late = ev("lap_recorded", { id: "a", entry_id: "en1", occurred_at: at(50) });
  const early = ev("lap_recorded", { id: "b", entry_id: "en1", occurred_at: at(10) });
  assert.deepEqual(liveEvents([late, early]).map((e) => e.id), ["b", "a"]);
});

test("the last undoable event is the most recent live one", () => {
  const a = ev("lap_recorded", { id: "a", entry_id: "en1", occurred_at: at(10) });
  const b = ev("lap_recorded", { id: "b", entry_id: "en2", occurred_at: at(20) });
  assert.equal(lastUndoable([a, b]).id, "b");
  assert.equal(lastUndoable([a, b], { entryId: "en1" }).id, "a", "scoped to one boat");
});

test("the start of the sequence is not undoable by the global undo", () => {
  // Undoing it would silently void the race clock. Postpone is the way out.
  const start = ev("sequence_started", { id: "s1" });
  assert.equal(lastUndoable([start]), null);
});

/* ---- the sequence ------------------------------------------------------- */

test("the gun is ten minutes after the tap", () => {
  const started = ev("sequence_started", { occurred_at: at(0) });
  const state = sequenceState([started]);
  assert.equal(state.running, true);
  assert.equal(state.startAt, T0 + SEQUENCE_MS);
});

test("postponing voids the sequence, ready to restart", () => {
  const events = [ev("sequence_started", { occurred_at: at(0) }), ev("postponed", { occurred_at: at(120) })];
  const state = sequenceState(events);
  assert.equal(state.running, false);
  assert.equal(state.postponed, true);
  assert.equal(state.startAt, null);
});

test("a sequence restarted after a postponement runs from the new tap", () => {
  const events = [
    ev("sequence_started", { occurred_at: at(0) }),
    ev("postponed", { occurred_at: at(120) }),
    ev("sequence_started", { occurred_at: at(300) }),
  ];
  const state = sequenceState(events);
  assert.equal(state.running, true);
  assert.equal(state.startAt, T0 + 300_000 + SEQUENCE_MS);
});

test("a general recall re-arms the ten minutes from the recall", () => {
  const events = [
    ev("sequence_started", { occurred_at: at(0) }),
    ev("general_recall", { occurred_at: at(605) }),
  ];
  const state = sequenceState(events);
  assert.equal(state.running, true);
  assert.equal(state.generalRecalls, 1);
  assert.equal(state.startAt, T0 + 605_000 + SEQUENCE_MS, "the fleet goes back and starts again");
});

/* ---- the countdown ------------------------------------------------------ */

test("the countdown is computed from the timestamp, not accumulated", () => {
  const startAt = T0 + SEQUENCE_MS;
  assert.equal(countdown(startAt, T0).display, "10:00");
  assert.equal(countdown(startAt, T0 + 300_000).display, "5:00");
  assert.equal(countdown(startAt, T0 + 540_000).display, "1:00");
  assert.equal(countdown(startAt, T0 + SEQUENCE_MS).display, "0:00");
});

test("a phone asleep for four minutes wakes up showing the right time", () => {
  const startAt = T0 + SEQUENCE_MS;
  const asleep = countdown(startAt, T0 + 30_000);
  const awake = countdown(startAt, T0 + 270_000);
  assert.equal(asleep.display, "9:30");
  assert.equal(awake.display, "5:30", "no drift, because nothing was counting");
});

test("past zero the race has started", () => {
  const started = countdown(T0, T0 + 5_000);
  assert.equal(started.started, true);
  assert.equal(started.display, "0:00");
});

test("the flag state matches the time remaining", () => {
  assert.equal(phaseFor(600).label, "Class flag up");
  assert.equal(phaseFor(301).label, "Class flag up");
  assert.equal(phaseFor(300).label, "P flag up", "the 5:00 mark itself");
  assert.equal(phaseFor(61).label, "P flag up");
  assert.equal(phaseFor(60).label, "P flag down", "the 1:00 mark itself");
  assert.equal(phaseFor(1).label, "P flag down");
  assert.equal(phaseFor(0).label, "START");
  assert.equal(phaseFor(-5).label, "START");
});

test("countdown formatting pads the seconds", () => {
  assert.equal(formatCountdown(605), "10:05");
  assert.equal(formatCountdown(9), "0:09");
  assert.equal(formatCountdown(-3), "0:00", "never negative on screen");
});

test("crossing a mark is detected by comparing two readings", () => {
  assert.deepEqual(marksCrossed(301, 300).map((m) => m.short), ["5:00"]);
  assert.deepEqual(marksCrossed(302, 301), []);
  assert.deepEqual(marksCrossed(1, 0).map((m) => m.short), ["0:00"]);
});

test("a phone asleep across several marks reports all of them, once", () => {
  // Waking at 30 seconds after being asleep at 6 minutes: 5:00 and 1:00 both
  // passed. A setInterval would simply have missed them.
  const crossed = marksCrossed(360, 30).map((m) => m.short);
  assert.deepEqual(crossed, ["5:00", "1:00"]);
});

test("no previous reading fires nothing, so opening the page mid-sequence is quiet", () => {
  assert.deepEqual(marksCrossed(null, 30), []);
});

/* ---- the lap plan ------------------------------------------------------- */

test("the plan starts as the race's", () => {
  assert.deepEqual(lapPlan(RACE, []), { fast: 3, slow: 2 });
});

test("shortening the course replaces the plan", () => {
  const events = [ev("course_shortened", { payload: { fast_laps: 2, slow_laps: 1 } })];
  assert.deepEqual(lapPlan(RACE, events), { fast: 2, slow: 1 });
});

test("shortening twice takes the latest", () => {
  const events = [
    ev("course_shortened", { payload: { fast_laps: 2, slow_laps: 1 }, occurred_at: at(10) }),
    ev("course_shortened", { payload: { fast_laps: 1, slow_laps: 1 }, occurred_at: at(20) }),
  ];
  assert.deepEqual(lapPlan(RACE, events), { fast: 1, slow: 1 });
});

test("an undone shortening is not applied", () => {
  const shorten = ev("course_shortened", { id: "cs1", payload: { fast_laps: 2, slow_laps: 1 } });
  assert.deepEqual(lapPlan(RACE, [shorten, undo("cs1")]), { fast: 3, slow: 2 });
});

test("a boat's own lap override beats the fleet plan", () => {
  assert.equal(plannedLaps(entry("en1", "fast"), { fast: 3, slow: 2 }), 3);
  assert.equal(plannedLaps(entry("en1", "slow"), { fast: 3, slow: 2 }), 2);
  assert.equal(plannedLaps(entry("en1", "fast", 1), { fast: 3, slow: 2 }), 1);
});

/* ---- boats -------------------------------------------------------------- */

const PLAN = { fast: 3, slow: 2 };

test("a boat that has not started shows lap 1 of 3 and a lap button", () => {
  const boat = boatState(entry("en1"), [], { plan: PLAN });
  assert.equal(boat.lapsDone, 0);
  assert.equal(boat.onLap, 1);
  assert.equal(boat.action, "lap");
});

test("the button becomes Finish on the planned final lap", () => {
  const events = [
    ev("lap_recorded", { entry_id: "en1", occurred_at: at(10) }),
    ev("lap_recorded", { entry_id: "en1", occurred_at: at(20) }),
  ];
  const boat = boatState(entry("en1"), events, { plan: PLAN });
  assert.equal(boat.lapsDone, 2);
  assert.equal(boat.onLap, 3, "on the last lap");
  assert.equal(boat.action, "finish", "the next crossing is the finish");
});

test("finishing records elapsed time from the gun", () => {
  const events = [
    ev("lap_recorded", { entry_id: "en1", occurred_at: at(10) }),
    ev("lap_recorded", { entry_id: "en1", occurred_at: at(20) }),
    ev("boat_finished", { entry_id: "en1", occurred_at: at(1830) }),
  ];
  const boat = boatState(entry("en1"), events, { plan: PLAN, startAt: T0 });
  assert.equal(boat.finished, true);
  assert.equal(boat.lapsDone, 3, "the finish is the third crossing");
  assert.equal(boat.elapsedMs, 1_830_000);
  assert.equal(formatElapsed(boat.elapsedMs), "30:30");
  assert.equal(boat.action, null, "nothing left to tap");
});

test("undoing a mis-tapped lap puts the boat back", () => {
  const good = ev("lap_recorded", { id: "l1", entry_id: "en1", occurred_at: at(10) });
  const mistake = ev("lap_recorded", { id: "l2", entry_id: "en1", occurred_at: at(11) });

  const before = boatState(entry("en1"), [good, mistake], { plan: PLAN });
  assert.equal(before.lapsDone, 2);
  assert.equal(before.action, "finish", "wrongly on its last lap");

  const after = boatState(entry("en1"), [good, mistake, undo("l2")], { plan: PLAN });
  assert.equal(after.lapsDone, 1);
  assert.equal(after.action, "lap", "and back to a lap button");
});

test("a code stops the boat and clears its button", () => {
  const events = [
    ev("lap_recorded", { entry_id: "en1", occurred_at: at(10) }),
    ev("code_applied", { entry_id: "en1", payload: { code: "RET" }, occurred_at: at(60) }),
  ];
  const boat = boatState(entry("en1"), events, { plan: PLAN });
  assert.equal(boat.code, "RET");
  assert.equal(boat.action, null);
});

test("a later code replaces an earlier one", () => {
  const events = [
    ev("code_applied", { entry_id: "en1", payload: { code: "OCS" }, occurred_at: at(10) }),
    ev("code_applied", { entry_id: "en1", payload: { code: "DSQ" }, occurred_at: at(20) }),
  ];
  assert.equal(boatState(entry("en1"), events, { plan: PLAN }).code, "DSQ");
});

test("one boat's events never affect another's", () => {
  const events = [
    ev("lap_recorded", { entry_id: "en1" }),
    ev("lap_recorded", { entry_id: "en2" }),
    ev("lap_recorded", { entry_id: "en2" }),
  ];
  assert.equal(boatState(entry("en1"), events, { plan: PLAN }).lapsDone, 1);
  assert.equal(boatState(entry("en2"), events, { plan: PLAN }).lapsDone, 2);
});

/* ---- shortening mid-race ------------------------------------------------ */

test("shortening from 3/2 to 2/1 flips racing boats to Finish", () => {
  // The acceptance case: a fast boat on its first lap suddenly has one to go.
  const events = [
    ev("lap_recorded", { entry_id: "fast1", occurred_at: at(10) }),
    ev("lap_recorded", { entry_id: "slow1", occurred_at: at(15) }),
    ev("course_shortened", { payload: { fast_laps: 2, slow_laps: 1 }, occurred_at: at(20) }),
  ];
  const plan = lapPlan(RACE, events);

  const fast = boatState(entry("fast1", "fast"), events, { plan });
  assert.equal(fast.lapsPlanned, 2);
  assert.equal(fast.action, "finish");

  const slow = boatState(entry("slow1", "slow"), events, { plan });
  assert.equal(slow.lapsPlanned, 1);
  assert.equal(slow.action, "finish", "already past its new distance");

  // A boat that has not crossed yet still has two crossings to make under the
  // new plan, so it is on lap 1 of 2 and the button stays a lap.
  const fresh = boatState(entry("fast2", "fast"), events, { plan });
  assert.equal(fresh.lapsPlanned, 2);
  assert.equal(fresh.onLap, 1);
  assert.equal(fresh.action, "lap");
});

test("shortening to a single lap makes the very next crossing the finish", () => {
  const events = [ev("course_shortened", { payload: { fast_laps: 1, slow_laps: 1 } })];
  const plan = lapPlan(RACE, events);
  const boat = boatState(entry("en1", "fast"), events, { plan });
  assert.equal(boat.action, "finish");
});

test("a boat that already finished is untouched by a shortening", () => {
  const events = [
    ev("lap_recorded", { entry_id: "en1", occurred_at: at(10) }),
    ev("lap_recorded", { entry_id: "en1", occurred_at: at(20) }),
    ev("boat_finished", { entry_id: "en1", occurred_at: at(1800) }),
    ev("course_shortened", { payload: { fast_laps: 2, slow_laps: 1 }, occurred_at: at(1900) }),
  ];
  const boat = boatState(entry("en1"), events, { plan: lapPlan(RACE, events), startAt: T0 });
  assert.equal(boat.finished, true);
  assert.equal(boat.lapsDone, 3, "it sailed three, and that stands");
  assert.equal(boat.elapsedMs, 1_800_000);
  assert.equal(boat.action, null);
});

/* ---- the whole race ----------------------------------------------------- */

test("the race splits into still racing and accounted for", () => {
  const entries = [entry("en1"), entry("en2"), entry("en3")];
  const events = [
    ev("boat_finished", { entry_id: "en1", occurred_at: at(1800) }),
    ev("code_applied", { entry_id: "en2", payload: { code: "DNF" }, occurred_at: at(1900) }),
  ];
  const state = raceState({ race: { ...RACE, start_at: new Date(T0).toISOString() }, entries, events });

  assert.equal(state.done.length, 2);
  assert.equal(state.racing.length, 1);
  assert.equal(state.racing[0].entryId, "en3");
  assert.equal(state.allAccountedFor, false);
});

test("every boat accounted for is what stand-down will look for", () => {
  const entries = [entry("en1"), entry("en2")];
  const events = [
    ev("boat_finished", { entry_id: "en1", occurred_at: at(1800) }),
    ev("code_applied", { entry_id: "en2", payload: { code: "RET" }, occurred_at: at(1900) }),
  ];
  const state = raceState({ race: RACE, entries, events });
  assert.equal(state.allAccountedFor, true);
});

test("abandoning is visible in the state and produces no results", () => {
  const state = raceState({
    race: RACE,
    entries: [entry("en1")],
    events: [ev("race_abandoned", { occurred_at: at(900) })],
  });
  assert.equal(state.abandoned, true);
});

test("the race clock runs from the recorded gun, falling back to the computed one", () => {
  const events = [ev("sequence_started", { occurred_at: at(0) })];
  const state = raceState({ race: RACE, entries: [], events });
  assert.equal(state.startAt, T0 + SEQUENCE_MS, "right the instant the countdown hits zero");

  const recorded = raceState({
    race: { ...RACE, start_at: new Date(T0 + 999).toISOString() },
    entries: [],
    events,
  });
  assert.equal(recorded.startAt, T0 + 999, "the recorded gun wins once written");
});

test("reloading mid-race produces the identical state", () => {
  // The property the whole page depends on: same log in, same screen out.
  const entries = [entry("en1"), entry("en2", "slow")];
  const events = [
    ev("sequence_started", { occurred_at: at(0) }),
    ev("lap_recorded", { entry_id: "en1", occurred_at: at(700) }),
    ev("lap_recorded", { id: "oops", entry_id: "en2", occurred_at: at(710) }),
    undo("oops", at(715)),
    ev("course_shortened", { payload: { fast_laps: 2, slow_laps: 2 }, occurred_at: at(800) }),
    ev("boat_finished", { entry_id: "en1", occurred_at: at(1200) }),
  ];

  const first = raceState({ race: RACE, entries, events });
  const shuffled = [...events].reverse(); // as sync might return them
  const second = raceState({ race: RACE, entries, events: shuffled });

  assert.deepEqual(second, first, "order of arrival must not matter");
  assert.equal(first.done.length, 1);
  assert.equal(first.racing.length, 1);
  assert.equal(first.racing[0].lapsDone, 0, "the undone lap stayed undone");
});

test("nextAction is null once a boat is done, whatever the plan says", () => {
  assert.equal(nextAction({ finished: true, lapsDone: 1, lapsPlanned: 3, code: null }), null);
  assert.equal(nextAction({ finished: false, lapsDone: 0, lapsPlanned: 3, code: "OCS" }), null);
});

test("MARKS are the four flag states, in order", () => {
  assert.deepEqual(MARKS.map((m) => m.short), ["10:00", "5:00", "1:00", "0:00"]);
});

/* ---------------------------------------------------------------------------
 * Planned laps per entry
 *
 * The rule — override, else the fleet's count from the current plan — decides
 * the "of n" text, which lap the button offers, and when it becomes FINISH.
 * It must be one rule, resolved per entry, not per race.
 * ------------------------------------------------------------------------ */

test("a fast boat gets the fast count and a slow boat the slow one", () => {
  const plan = { fast: 3, slow: 2 };
  assert.equal(plannedLaps(entry("f", "fast"), plan), 3);
  assert.equal(plannedLaps(entry("s", "slow"), plan), 2);
});

test("a per-boat override beats both fleet counts", () => {
  const plan = { fast: 3, slow: 2 };
  assert.equal(plannedLaps(entry("f", "fast", 1), plan), 1);
  assert.equal(plannedLaps(entry("s", "slow", 4), plan), 4);
});

test("a mixed fleet resolves each card independently", () => {
  // The reported bug: every card reading "of 3" regardless of fleet.
  const entries = [entry("fast1", "fast"), entry("slow1", "slow"), entry("over1", "fast", 1)];
  const state = raceState({ race: RACE, entries, events: [] });

  assert.deepEqual(
    state.boats.map((b) => [b.entryId, b.lapsPlanned, b.onLap, b.action]),
    [
      ["fast1", 3, 1, "lap"],
      ["slow1", 2, 1, "lap"],
      ["over1", 1, 1, "finish"],
    ]
  );
});

test("a slow boat's button says Finish on its second lap, and it cannot be given a third", () => {
  const events = [ev("lap_recorded", { entry_id: "s1", occurred_at: at(10) })];
  const boat = boatState(entry("s1", "slow"), events, { plan: { fast: 3, slow: 2 } });

  assert.equal(boat.lapsPlanned, 2);
  assert.equal(boat.onLap, 2, "on its last lap");
  assert.equal(boat.action, "finish", "the next tap finishes it, it cannot take a third lap");
});

test("shortening 3/2 to 2/1 re-resolves per fleet", () => {
  const events = [ev("course_shortened", { payload: { fast_laps: 2, slow_laps: 1 } })];
  const plan = lapPlan(RACE, events);

  const fastFresh = boatState(entry("f", "fast"), events, { plan });
  assert.equal(fastFresh.lapsPlanned, 2);
  assert.equal(fastFresh.action, "lap", "one more lap, then the finish");

  const fastOne = boatState(
    entry("f2", "fast"),
    [...events, ev("lap_recorded", { entry_id: "f2", occurred_at: at(30) })],
    { plan }
  );
  assert.equal(fastOne.action, "finish", "fast boats finish on lap 2");

  const slowFresh = boatState(entry("s", "slow"), events, { plan });
  assert.equal(slowFresh.lapsPlanned, 1);
  assert.equal(slowFresh.action, "finish", "slow boats finish on lap 1");
});

/* ---------------------------------------------------------------------------
 * Lap splits
 *
 * Display only: the events keep their absolute occurred_at, and these are
 * derived by subtracting the gun time at render.
 * ------------------------------------------------------------------------ */

test("each crossing is shown as elapsed race time, cumulative", () => {
  const events = [
    ev("lap_recorded", { entry_id: "en1", occurred_at: at(252) }),
    ev("lap_recorded", { entry_id: "en1", occurred_at: at(503) }),
  ];
  const boat = boatState(entry("en1"), events, { plan: PLAN, startAt: T0 });

  assert.deepEqual(boat.splits.map((s) => s.label), ["L1", "L2"]);
  assert.equal(formatSplits(boat.splits), "L1 4:12 · L2 8:23");
});

test("finishing appends F to the line", () => {
  const events = [
    ev("lap_recorded", { entry_id: "en1", occurred_at: at(252) }),
    ev("lap_recorded", { entry_id: "en1", occurred_at: at(503) }),
    ev("boat_finished", { entry_id: "en1", occurred_at: at(761) }),
  ];
  const boat = boatState(entry("en1"), events, { plan: PLAN, startAt: T0 });
  assert.equal(formatSplits(boat.splits), "L1 4:12 · L2 8:23 · F 12:41");
});

test("an undone lap disappears from the line", () => {
  const good = ev("lap_recorded", { id: "l1", entry_id: "en1", occurred_at: at(252) });
  const oops = ev("lap_recorded", { id: "l2", entry_id: "en1", occurred_at: at(300) });

  const before = boatState(entry("en1"), [good, oops], { plan: PLAN, startAt: T0 });
  assert.equal(formatSplits(before.splits), "L1 4:12 · L2 5:00");

  const after = boatState(entry("en1"), [good, oops, undo("l2")], { plan: PLAN, startAt: T0 });
  assert.equal(formatSplits(after.splits), "L1 4:12", "and the numbering closes up");
});

test("splits cross the hour boundary into H:MM:SS", () => {
  const events = [
    ev("lap_recorded", { entry_id: "en1", occurred_at: at(3599) }),
    ev("lap_recorded", { entry_id: "en1", occurred_at: at(3600) }),
    ev("boat_finished", { entry_id: "en1", occurred_at: at(3852) }),
  ];
  const boat = boatState(entry("en1"), events, { plan: PLAN, startAt: T0 });
  assert.equal(formatSplits(boat.splits), "L1 59:59 · L2 1:00:00 · F 1:04:12");
});

test("the line stays on one row by dropping the earliest splits", () => {
  const splits = [1, 2, 3, 4, 5].map((n) => ({ label: `L${n}`, ms: n * 1000 }));
  const text = formatSplits(splits);
  assert.ok(text.startsWith("… "), "truncated from the left");
  assert.ok(!text.includes("L1 "), "the oldest goes first");
  assert.ok(text.includes("L5"), "the most recent stays");
});

test("a boat with no crossings has an empty line rather than a stray separator", () => {
  const boat = boatState(entry("en1"), [], { plan: PLAN, startAt: T0 });
  assert.deepEqual(boat.splits, []);
  assert.equal(formatSplits(boat.splits), "");
});

test("elapsed formatting matches the race clock's units", () => {
  assert.equal(formatElapsed(252_000), "4:12");
  assert.equal(formatElapsed(3_852_000), "1:04:12");
  assert.equal(formatElapsed(26_000), "0:26");
});

/* ---------------------------------------------------------------------------
 * Ending a race
 *
 * A race used to have no ending — the clock ran on for ever. Ending is now an
 * explicit act, recorded like anything else, and therefore undoable.
 * ------------------------------------------------------------------------ */

test("a race cannot be ended while a boat is still out", () => {
  const entries = [entry("en1"), entry("en2")];
  const events = [ev("boat_finished", { entry_id: "en1", occurred_at: at(1800) })];
  const state = raceState({ race: RACE, entries, events });

  assert.equal(state.canEnd, false);
  assert.equal(state.unaccounted.length, 1);
  assert.equal(state.unaccounted[0].entryId, "en2");
});

test("once every boat is home or coded the race may be ended", () => {
  const entries = [entry("en1"), entry("en2")];
  const events = [
    ev("boat_finished", { entry_id: "en1", occurred_at: at(1800) }),
    ev("code_applied", { entry_id: "en2", payload: { code: "DNF" }, occurred_at: at(1900) }),
  ];
  const state = raceState({ race: RACE, entries, events });

  assert.equal(state.canEnd, true);
  assert.equal(state.unaccounted.length, 0);
});

test("coding everyone still out — the expired time limit — unblocks the ending", () => {
  const entries = [entry("en1"), entry("en2"), entry("en3")];
  const finished = [ev("boat_finished", { entry_id: "en1", occurred_at: at(1800) })];

  assert.equal(raceState({ race: RACE, entries, events: finished }).canEnd, false);

  const bulkDnf = [
    ...finished,
    ev("code_applied", { entry_id: "en2", payload: { code: "DNF" }, occurred_at: at(2000) }),
    ev("code_applied", { entry_id: "en3", payload: { code: "DNF" }, occurred_at: at(2000) }),
  ];
  assert.equal(raceState({ race: RACE, entries, events: bulkDnf }).canEnd, true);
});

test("an empty race cannot be ended", () => {
  assert.equal(raceState({ race: RACE, entries: [], events: [] }).canEnd, false);
});

test("ending records when, and stops every boat's button", () => {
  const entries = [entry("en1")];
  const events = [
    ev("boat_finished", { entry_id: "en1", occurred_at: at(1800) }),
    ev("race_ended", { occurred_at: at(1900) }),
  ];
  const state = raceState({ race: RACE, entries, events });

  assert.equal(state.ended, true);
  assert.equal(state.endedAt, T0 + 1_900_000);
  assert.equal(state.canEnd, false, "it is already over");
  assert.equal(state.boats[0].action, null);
});

test("the clock freezes at the ending", () => {
  const startAt = T0;
  const endedAt = T0 + 1_900_000;

  assert.equal(raceClock(startAt, T0 + 1_000_000), "16:40", "running");
  assert.equal(raceClock(startAt, T0 + 5_000_000, endedAt), "31:40", "frozen at the ending");
  assert.equal(
    raceClock(startAt, T0 + 9_000_000, endedAt),
    raceClock(startAt, T0 + 5_000_000, endedAt),
    "and stays there however long ago it was"
  );
});

test("undoing the ending puts the race back", () => {
  const entries = [entry("en1"), entry("en2")];
  const base = [ev("boat_finished", { entry_id: "en1", occurred_at: at(1800) })];
  const end = ev("race_ended", { id: "end1", occurred_at: at(1900) });

  const ended = raceState({ race: RACE, entries, events: [...base, end] });
  assert.equal(ended.ended, true);
  assert.equal(ended.boats[1].action, null, "nothing tappable while it is over");

  const resumed = raceState({ race: RACE, entries, events: [...base, end, undo("end1")] });
  assert.equal(resumed.ended, false);
  assert.equal(resumed.endedAt, null);
  assert.equal(resumed.boats[1].action, "lap", "the boat still out can be recorded again");
  assert.equal(raceClock(T0, T0 + 5_000_000, resumed.endedAt), "1:23:20", "clock running again");
});

test("ending is an ordinary event, so the history drawer can undo it", () => {
  const events = [
    ev("boat_finished", { id: "f1", entry_id: "en1", occurred_at: at(1800) }),
    ev("race_ended", { id: "end1", occurred_at: at(1900) }),
  ];
  assert.equal(lastUndoable(events).id, "end1");
});

test("an abandoned race is not an ended one", () => {
  const state = raceState({
    race: RACE,
    entries: [entry("en1")],
    events: [ev("race_abandoned", { occurred_at: at(900) })],
  });
  assert.equal(state.abandoned, true);
  assert.equal(state.ended, false);
  assert.equal(state.canEnd, false, "an abandoned race has nothing to end");
});

/* ---------------------------------------------------------------------------
 * Naming a race
 *
 * One label function, so the sequence header, results title, stand-down,
 * resume banner, CSV and PDF cannot drift apart. A named trophy race is
 * exactly the one whose results sheet gets kept.
 * ------------------------------------------------------------------------ */

test("a named race shows its name alongside the number", () => {
  assert.equal(raceLabel({ number: 1, name: "Whitaker Cup" }), "Race 1 — Whitaker Cup");
  assert.equal(raceLabel({ number: 3, name: "Commodore's Trophy" }), "Race 3 — Commodore's Trophy");
});

test("an unnamed race is just its number, with no stray dash", () => {
  assert.equal(raceLabel({ number: 2, name: null }), "Race 2");
  assert.equal(raceLabel({ number: 2 }), "Race 2");
  assert.equal(raceLabel({ number: 2, name: "" }), "Race 2");
});

test("a name of only spaces counts as unnamed", () => {
  assert.equal(raceLabel({ number: 2, name: "   " }), "Race 2");
  assert.equal(raceName({ number: 2, name: "   " }), "");
});

test("a name is trimmed for display", () => {
  assert.equal(raceLabel({ number: 1, name: "  Whitaker Cup  " }), "Race 1 — Whitaker Cup");
  assert.equal(raceName({ number: 1, name: "  Whitaker Cup  " }), "Whitaker Cup");
});

test("a missing race does not produce a broken label", () => {
  assert.equal(raceLabel(null), "Race ?");
  assert.equal(raceName(null), "");
});
