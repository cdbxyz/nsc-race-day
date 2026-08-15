/* state.js — race state as a pure function of the event log.
 *
 * Nothing about a race is stored as mutable state. Laps, finishes, codes, the
 * lap plan after a shortened course, even whether the sequence is running —
 * all of it is computed from race_events every time it is needed
 * (ARCHITECTURE.md D2). That is what makes killing the page mid-race safe:
 * reload, replay, identical screen.
 *
 * Pure by rule: no DOM, no IO, no clock of its own. The wall clock is passed
 * in, so a countdown can be tested at any instant without waiting for it.
 */

/** A start sequence is ten minutes from the tap to the gun. */
import { lapsFor } from "./handicap.js";

export const SEQUENCE_MS = 10 * 60 * 1000;

/* The flag states the OOD is working to. Seconds remaining, descending. */
export const MARKS = [
  { at: 600, label: "Class flag up", short: "10:00", tone: "calm" },
  { at: 300, label: "P flag up", short: "5:00", tone: "calm" },
  { at: 60, label: "P flag down", short: "1:00", tone: "urgent" },
  { at: 0, label: "START", short: "0:00", tone: "go" },
];

function ms(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function byTime(a, b) {
  return (ms(a.occurred_at) ?? 0) - (ms(b.occurred_at) ?? 0);
}

/* ---------------------------------------------------------------------------
 * Undo
 *
 * An event is tombstoned by an `event_undone` naming it. Undoing an undo is a
 * redo, so an event_undone that has itself been undone stops tombstoning.
 * ------------------------------------------------------------------------ */

export function liveEvents(events = []) {
  const undoneBy = new Map();
  for (const event of events) {
    if (event.type !== "event_undone") continue;
    const target = event.payload?.undoes;
    if (target) undoneBy.set(target, event);
  }

  const isLive = (event) => {
    const undo = undoneBy.get(event.id);
    if (!undo) return true;
    return !isLive(undo) ? true : false;
  };

  return events.filter((event) => event.type !== "event_undone" && isLive(event)).sort(byTime);
}

/** The most recent event that could still be undone, or null. */
export function lastUndoable(events = [], { entryId = null } = {}) {
  const live = liveEvents(events).filter((event) => {
    if (entryId && event.entry_id !== entryId) return false;
    return event.type !== "sequence_started";
  });
  return live.length ? live[live.length - 1] : null;
}

/* ---------------------------------------------------------------------------
 * The start sequence
 * ------------------------------------------------------------------------ */

/**
 * Where the sequence has got to.
 *
 * A postponement voids everything before it, so only events after the last
 * `postponed` count. A general recall re-arms from its own timestamp: the
 * fleet goes back and the ten minutes start again.
 */
export function sequenceState(events = []) {
  const live = liveEvents(events);

  const lastPostpone = [...live].reverse().find((e) => e.type === "postponed");
  const since = lastPostpone ? ms(lastPostpone.occurred_at) : -Infinity;
  const after = live.filter((e) => (ms(e.occurred_at) ?? 0) > since);

  const started = after.filter((e) => e.type === "sequence_started");
  const recalls = after.filter((e) => e.type === "general_recall");

  // Whichever came last sets the clock: the original gun, or the recall.
  const anchor = [...started, ...recalls].sort(byTime).pop() ?? null;

  return {
    running: Boolean(anchor),
    startedAt: anchor ? ms(anchor.occurred_at) : null,
    startAt: anchor ? ms(anchor.occurred_at) + SEQUENCE_MS : null,
    postponed: Boolean(lastPostpone) && !anchor,
    generalRecalls: recalls.length,
  };
}

/**
 * The countdown, computed from the stored timestamp against the wall clock.
 * Never accumulated — a phone asleep for four minutes wakes up correct.
 */
export function countdown(startAt, now) {
  if (startAt == null) return null;
  const remainingMs = startAt - now;
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  return {
    remainingMs,
    remainingSeconds,
    started: remainingMs <= 0,
    display: formatCountdown(remainingSeconds),
    phase: phaseFor(remainingSeconds),
  };
}

export function formatCountdown(totalSeconds) {
  const seconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Which flag state is showing at this many seconds to go. */
export function phaseFor(remainingSeconds) {
  if (remainingSeconds <= 0) return MARKS[3];
  if (remainingSeconds <= 60) return MARKS[2];
  if (remainingSeconds <= 300) return MARKS[1];
  return MARKS[0];
}

/**
 * Whether a mark has just been crossed, for the vibration pulse.
 * Compares two readings rather than watching a timer, so a sleeping phone
 * cannot miss one and a slow frame cannot fire one twice.
 */
export function marksCrossed(previousSeconds, currentSeconds) {
  if (previousSeconds == null) return [];
  return MARKS.filter((mark) => previousSeconds > mark.at && currentSeconds <= mark.at);
}

/* ---------------------------------------------------------------------------
 * The lap plan
 * ------------------------------------------------------------------------ */

/**
 * Laps per fleet, after any shortening. By convention a course is shortened
 * before anyone reaches the new finish, so this simply replaces the plan —
 * there is deliberately no retroactive logic.
 */
export function lapPlan(race, events = []) {
  let plan = {
    fast: Number(race?.fast_laps ?? 3),
    slow: Number(race?.slow_laps ?? 2),
  };
  for (const event of liveEvents(events)) {
    if (event.type !== "course_shortened") continue;
    plan = {
      fast: Number(event.payload?.fast_laps ?? plan.fast),
      slow: Number(event.payload?.slow_laps ?? plan.slow),
    };
  }
  return plan;
}

/**
 * How many laps this entry is due: its own override if it has one, otherwise
 * its fleet's count from the current plan.
 *
 * Delegates to handicap.js rather than repeating the rule. It was written out
 * longhand in three places — here, raceday.entryLaps and the shorten sheet —
 * which is three chances for them to disagree about what a slow boat sails.
 */
export function plannedLaps(entry, plan) {
  return lapsFor({
    fleet: entry?.fleet,
    lapsOverride: entry?.laps_override,
    fastLaps: plan?.fast,
    slowLaps: plan?.slow,
  });
}

/* ---------------------------------------------------------------------------
 * Boats
 * ------------------------------------------------------------------------ */

/** What the OOD's next tap on this boat's button would mean. */
export function nextAction(boat) {
  if (boat.code || boat.finished) return null;
  return boat.lapsDone >= boat.lapsPlanned - 1 ? "finish" : "lap";
}

/**
 * Everything about one boat's race, from the log.
 *
 * @returns {{entryId, lapsDone, lapsPlanned, onLap, lastLapAt, finished,
 *            finishedAt, elapsedMs, code, action}}
 */
export function boatState(entry, events, { plan, startAt = null }) {
  const live = liveEvents(events).filter((e) => e.entry_id === entry.id);

  const laps = live.filter((e) => e.type === "lap_recorded");
  const finish = live.filter((e) => e.type === "boat_finished").pop() ?? null;
  const coded = live.filter((e) => e.type === "code_applied").pop() ?? null;

  const lapsPlanned = plannedLaps(entry, plan);
  const lapsDone = laps.length + (finish ? 1 : 0);
  const finishedAt = finish ? ms(finish.occurred_at) : null;
  const lastEvent = [...laps, ...(finish ? [finish] : [])].sort(byTime).pop() ?? null;

  /* Each crossing as elapsed race time, in order. Display only — the events
     themselves keep their absolute occurred_at, which is what the results
     maths and the audit log depend on. */
  const splits = [
    ...laps.map((event, index) => ({
      label: `L${index + 1}`,
      ms: startAt == null ? null : ms(event.occurred_at) - startAt,
    })),
    ...(finish
      ? [{ label: "F", ms: startAt == null ? null : ms(finish.occurred_at) - startAt }]
      : []),
  ];

  const boat = {
    entryId: entry.id,
    lapsDone,
    lapsPlanned,
    splits,
    // "lap 2 of 3" — the lap being sailed now, never beyond the plan.
    onLap: Math.min(lapsDone + (finish ? 0 : 1), Math.max(lapsPlanned, lapsDone)),
    lastLapAt: lastEvent ? ms(lastEvent.occurred_at) : null,
    finished: Boolean(finish),
    finishedAt,
    elapsedMs: finishedAt != null && startAt != null ? finishedAt - startAt : null,
    code: coded?.payload?.code ?? null,
  };
  boat.action = nextAction(boat);
  return boat;
}

/* ---------------------------------------------------------------------------
 * The whole race
 * ------------------------------------------------------------------------ */

/**
 * The complete live-race picture. This is the only thing the live page reads,
 * so what it renders is by construction a pure function of the log.
 */
export function raceState({ race, entries = [], events = [] }) {
  const live = liveEvents(events);
  const abandoned = live.some((e) => e.type === "race_abandoned");
  const sequence = sequenceState(events);
  const plan = lapPlan(race, events);

  // start_at is the recorded gun time; fall back to the computed one so the
  // page is right the instant the countdown hits zero, before the write lands.
  const startAt = ms(race?.start_at) ?? sequence.startAt ?? null;

  const boats = entries.map((entry) => ({
    entry,
    ...boatState(entry, events, { plan, startAt }),
  }));

  const racing = boats.filter((b) => !b.finished && !b.code);
  const done = boats.filter((b) => b.finished || b.code);

  return {
    race,
    plan,
    sequence,
    startAt,
    abandoned,
    boats,
    racing,
    done,
    shortened: live.some((e) => e.type === "course_shortened"),
    allAccountedFor: racing.length === 0 && boats.length > 0,
  };
}

/* ---------------------------------------------------------------------------
 * Results
 *
 * The event log gives laps, elapsed time and codes; scoring.js turns those
 * plain numbers into positions. A `correction` event may override any of them
 * before publishing, and the payload shape below is the contract that
 * 003_views.sql relies on to compute the same answers in Postgres:
 *
 *   {"laps": <int>, "elapsed_seconds": <numeric>, "code": "<RRS code>"}
 *
 * Any subset may be present; absent keys leave the computed value alone.
 * ------------------------------------------------------------------------ */

/** The latest live correction for an entry, or null. */
export function correctionFor(entryId, events = []) {
  const corrections = liveEvents(events).filter(
    (e) => e.type === "correction" && e.entry_id === entryId
  );
  return corrections.length ? (corrections[corrections.length - 1].payload ?? {}) : null;
}

/**
 * Turn the log into the plain numbers scoring.js takes.
 *
 * @returns {Array<{id, entry, personalPy, basePy, factor, elapsedSeconds,
 *                  laps, code, corrected: boolean}>}
 */
export function resultInputs({ race, entries = [], events = [] }) {
  const plan = lapPlan(race, events);
  const startAt = ms(race?.start_at) ?? sequenceState(events).startAt ?? null;

  return entries.map((entry) => {
    const boat = boatState(entry, events, { plan, startAt });
    const fix = correctionFor(entry.id, events);

    const laps = fix?.laps != null ? Number(fix.laps) : boat.lapsDone;
    const elapsedSeconds =
      fix?.elapsed_seconds != null
        ? Number(fix.elapsed_seconds)
        : boat.elapsedMs != null
          ? boat.elapsedMs / 1000
          : 0;
    const code = fix?.code !== undefined ? fix.code : boat.code;

    return {
      id: entry.id,
      entry,
      personalPy: Number(entry.personal_py),
      basePy: entry.base_py == null ? null : Number(entry.base_py),
      factor: entry.handicap_factor == null ? null : Number(entry.handicap_factor),
      elapsedSeconds,
      laps,
      code: code || "",
      corrected: Boolean(fix),
    };
  });
}

/** Elapsed race time, for the pinned clock. */
export function raceClock(startAt, now) {
  if (startAt == null) return null;
  const elapsed = Math.max(0, now - startAt);
  return formatElapsed(elapsed);
}

/**
 * M:SS under an hour, H:MM:SS over — the units the race clock uses, so a lap
 * split sitting next to it reads without explanation.
 */
export function formatElapsed(elapsedMs) {
  if (elapsedMs == null) return "—";
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

/**
 * "L1 4:12 · L2 8:23 · F 12:41".
 *
 * Must stay on one row: the live page fits about eight cards on a 390px
 * screen and a wrapped line costs one of them. Three laps and a finish fit
 * comfortably; anything longer drops the earliest splits, because the recent
 * ones are what the OOD is watching.
 */
export function formatSplits(splits = [], { maxItems = 4 } = {}) {
  if (!splits.length) return "";
  const shown = splits.slice(-maxItems);
  const text = shown.map((s) => `${s.label} ${formatElapsed(s.ms)}`).join(" · ");
  return shown.length < splits.length ? `… ${text}` : text;
}

/** Wall-clock time of day, for "last lap 14:32". */
export function formatClockTime(at) {
  if (at == null) return "—";
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
