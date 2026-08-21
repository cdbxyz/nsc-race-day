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

  /* Everything after the last postponement, by tap time.
     Two race signals cannot share a millisecond in practice — they are
     separate deliberate taps seconds apart — and there is deliberately no
     tiebreak here, because the honest one does not exist: race_events are
     keyed on a random UUID, so same-millisecond rows have no defined order
     to fall back on. Ordering by the recorded time is the truth we have. */
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
 * The clock as the countdown should read it, optionally compressed.
 *
 * This is the whole of the dev fast clock: nothing downstream knows it
 * exists. countdown(), phaseFor() and marksCrossed() are handed a scaled
 * `now` and behave exactly as they do in a real race — which is the point,
 * because otherwise the sped-up sequence would be testing different code
 * from the one that ships.
 *
 * The anchor is when the sequence actually started, in real time. Elapsed
 * time since then is multiplied; the anchor itself never moves, so stored
 * timestamps stay honest.
 *
 * @param {{anchor: number|null, now: number, speed?: number}} args
 */
export function scaledNow({ anchor, now, speed = 1 }) {
  if (anchor == null || !Number.isFinite(speed) || speed === 1) return now;
  return anchor + (now - anchor) * speed;
}

/**
 * The exact inverse of scaledNow: given an instant on the compressed clock,
 * the wall-clock instant it actually happens at.
 *
 * This is what makes a recorded gun time honest. The countdown works on the
 * scaled clock, so the moment it calls zero is a SCALED instant — at 60x, ten
 * scaled minutes after the tap is ten real SECONDS after it. Writing the
 * scaled instant into races.start_at, as the old code did, put the gun ten
 * real minutes in the future and made every elapsed time negative until the
 * wall clock caught up.
 *
 * Computed rather than read off Date.now() at the moment of detection, so a
 * phone asleep through the gun still records the gun to the millisecond.
 *
 * @param {{anchor: number|null, scaled: number|null, speed?: number}} args
 */
export function wallClockAt({ anchor, scaled, speed = 1 }) {
  if (anchor == null || scaled == null) return scaled ?? null;
  if (!Number.isFinite(speed) || speed <= 0 || speed === 1) return scaled;
  return anchor + (scaled - anchor) / speed;
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
 * Identifying a race
 * ------------------------------------------------------------------------ */

/**
 * How a race is named on screen and in outputs.
 *
 *   named   "Race 2 — Whitaker Cup"
 *   unnamed "Race 2"
 *
 * One function so the two forms can never drift apart between the sequence
 * header, the results title, stand-down and the PDF — a named trophy race is
 * exactly the one whose results sheet gets kept.
 */
export function raceLabel(race) {
  const number = race?.number ?? "?";
  const name = String(race?.name ?? "").trim();
  return name ? `Race ${number} — ${name}` : `Race ${number}`;
}

/** Just the name, for places that already say which race it is. */
export function raceName(race) {
  return String(race?.name ?? "").trim();
}

/* ---------------------------------------------------------------------------
 * Identifying an entry
 *
 * There are no named hulls here — 017 removed them. What persists at this club
 * is the combination: a helm, sometimes a crew, in a class. So an entry is
 * always labelled by whoever is sailing it, and the sail number is supporting
 * detail: it identifies the boat on the water, not the people in it.
 * ------------------------------------------------------------------------ */

/** "Hamish Fowler + Lisa Fowler", or "Hamish Fowler". */
export function entryLabel({ helm = null, crew = null } = {}) {
  const people = [helm?.name, crew?.name].map((n) => String(n ?? "").trim()).filter(Boolean);
  return people.join(" + ") || "unknown";
}

/**
 * The second line: the class, and the sail number when there is one.
 * "Laser 2000 · 2298". Never repeats what entryLabel already said.
 *
 * The sail number comes off the ENTRY, because it is a fact about this race —
 * a helm may borrow a different boat next week.
 */
export function entryDetail({ entry = null, klass = null, sailNo = null } = {}) {
  const number = String(sailNo ?? entry?.sail_no ?? "").trim();
  return [klass?.name ?? null, number || null].filter(Boolean).join(" · ");
}

/** Everyone aboard, for the stand-down tally. */
export function entryPeople({ helm = null, crew = null } = {}) {
  return [helm, crew].filter(Boolean);
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
/**
 * @param {{plan: object, startAt?: number|null, speed?: number}} options
 *   `speed` compresses the DURATIONS this returns for display — the live
 *   race clock and lap splits — exactly as scaledNow compresses the
 *   countdown. It defaults to 1 and resultInputs never passes it, so the
 *   results sheet is always computed from real elapsed time.
 */
export function boatState(entry, events, { plan, startAt = null, speed = 1 }) {
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
     maths and the audit log depend on.

     `speed` rides on the same arithmetic rather than a branch of its own: an
     elapsed duration scaled by the fast clock is just the scaled instant
     measured from the same start. One code path, as with the countdown. */
  const elapsedAt = (isoOrNull) => {
    if (startAt == null || isoOrNull == null) return null;
    return scaledNow({ anchor: startAt, now: ms(isoOrNull), speed }) - startAt;
  };

  const splits = [
    ...laps.map((event, index) => ({
      label: `L${index + 1}`,
      ms: elapsedAt(event.occurred_at),
    })),
    ...(finish ? [{ label: "F", ms: elapsedAt(finish.occurred_at) }] : []),
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
    // The absolute instant stays real; only the duration is ever compressed.
    finishedAt,
    elapsedMs: finish ? elapsedAt(finish.occurred_at) : null,
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
export function raceState({ race, entries = [], events = [], speed = 1 }) {
  const live = liveEvents(events);
  const abandoned = live.some((e) => e.type === "race_abandoned");

  /* Ending is an explicit act, recorded like anything else, so undoing it is
     just an event_undone and the race is live again. */
  const endEvent = live.filter((e) => e.type === "race_ended").pop() ?? null;
  const ended = Boolean(endEvent);
  const endedAt = endEvent ? ms(endEvent.occurred_at) : null;
  const sequence = sequenceState(events);
  const plan = lapPlan(race, events);

  /* start_at is the recorded gun time; fall back to the computed one so the
     page is right the instant the countdown hits zero, before the write
     lands. The fallback must be converted back to wall clock for the same
     reason the write is: sequence.startAt sits on the countdown's clock. */
  const startAt =
    ms(race?.start_at) ??
    wallClockAt({ anchor: sequence.startedAt, scaled: sequence.startAt, speed }) ??
    null;

  const boats = entries.map((entry) => {
    const boat = { entry, ...boatState(entry, events, { plan, startAt, speed }) };
    // Once the race is over, nothing more can be tapped onto a boat.
    if (ended) boat.action = null;
    return boat;
  });

  const racing = boats.filter((b) => !b.finished && !b.code);
  const done = boats.filter((b) => b.finished || b.code);

  return {
    race,
    plan,
    sequence,
    startAt,
    abandoned,
    ended,
    endedAt,
    boats,
    racing,
    done,
    shortened: live.some((e) => e.type === "course_shortened"),
    allAccountedFor: racing.length === 0 && boats.length > 0,
    /* The race may only be ended once every boat is home or coded — the same
       rule stand-down enforces for the whole day, applied per race. */
    canEnd: !ended && !abandoned && racing.length === 0 && boats.length > 0,
    unaccounted: racing,
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

  /* Deliberately no `speed`: the results sheet is computed from real stored
     timestamps, always. A race run on the dev fast clock therefore produces
     genuinely short elapsed times that will not match the compressed clock
     the OOD watched — which is correct, because the log is what happened. */
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
      implausible: implausibleElapsed({
        elapsedSeconds,
        code,
        // A hand-entered correction is a time to be judged too, even on a
        // boat the log never saw finish.
        finished: boat.finished || fix?.elapsed_seconds != null,
      }),
    };
  });
}

/**
 * The longest a race at this club could conceivably take. Beyond this the
 * number is not a slow boat, it is broken arithmetic.
 */
export const MAX_PLAUSIBLE_ELAPSED_SECONDS = 12 * 3600;

/**
 * Why an elapsed time cannot be believed, or null if it can.
 *
 * A boat with a bad time must never just vanish from the order. scoring.js
 * quite reasonably refuses to score `elapsed <= 0`, and the effect of the
 * start_at bug was that EVERY boat hit that branch and the sheet came up
 * empty with nothing saying why. A time that cannot be right has to be
 * visible, and visibly different from an ordinary retirement.
 */
export function implausibleElapsed({ elapsedSeconds, code = "", finished = true }) {
  if (code) return null; // a coded boat has no time to be wrong about
  if (!finished) return null; // still out there, or never started
  if (!Number.isFinite(elapsedSeconds)) return "elapsed time is not a number";
  if (elapsedSeconds < 0) {
    return "finished before the start — the recorded start time must be wrong";
  }
  if (elapsedSeconds === 0) return "no time between the start and the finish";
  if (elapsedSeconds > MAX_PLAUSIBLE_ELAPSED_SECONDS) {
    return `elapsed time of ${Math.round(elapsedSeconds / 3600)} hours cannot be right`;
  }
  return null;
}

/**
 * Do the race's two timestamps agree with each other and with the log?
 *
 * The per-boat plausibility check above cannot see a SYSTEMATIC start-time
 * error. If start_at is wrong by four minutes, every boat is wrong by four
 * minutes, every elapsed time still looks like a perfectly ordinary race, and
 * nothing is flagged — but the sheet is wrong, and not uniformly so: corrected
 * time is elapsed x 1000 / PY, so a constant shift moves boats on different
 * handicaps by different amounts and can reorder the fleet.
 *
 * Two things are checked, because either alone can be fooled:
 *
 *  1. start_at - sequence_start_at should be one sequence length. This catches
 *     one column being edited, replayed or synced without the other.
 *  2. sequence_start_at should equal the anchor in the event log — the last
 *     `sequence_started` or `general_recall`. This catches BOTH columns being
 *     shifted together, which check 1 cannot see, and it is the check that has
 *     teeth now that the two values are derived independently. (Before the
 *     start_at fix they were not: sequence_start_at was computed as start_at
 *     minus ten minutes, so check 1 passed by construction however wrong the
 *     pair was.)
 *
 * `allowedSequenceMs` exists for the dev fast clock, where a real ten-minute
 * sequence honestly takes ten seconds. It is passed in rather than read from
 * devclock.js so this module stays pure and the caller has to be explicit
 * about accepting a compressed race.
 *
 * @returns {{problem: string, detail: string}|null} null when consistent.
 */
export function startTimeCheck({
  race,
  events = [],
  allowedSequenceMs = [SEQUENCE_MS],
  toleranceMs = 2000,
}) {
  const startAt = ms(race?.start_at);
  const sequenceStartAt = ms(race?.sequence_start_at);

  // Nothing recorded yet is not an inconsistency; the race simply has not run.
  if (startAt == null) return null;

  if (sequenceStartAt == null) {
    return {
      problem: "The sequence start time is missing",
      detail:
        "The gun is recorded but the ten-minute sequence that led to it is not, so there is nothing to check it against.",
    };
  }

  const gap = startAt - sequenceStartAt;
  if (gap < 0) {
    return {
      problem: "The gun is recorded before the sequence started",
      detail: `The start time is ${formatElapsed(-gap)} EARLIER than the sequence start. One of the two is wrong.`,
    };
  }

  const matches = allowedSequenceMs.some((expected) => Math.abs(gap - expected) <= toleranceMs);
  if (!matches) {
    const expected = allowedSequenceMs[0];
    const off = gap - expected;
    return {
      problem: "The start and sequence times do not agree",
      detail: `The gun is ${formatElapsed(gap)} after the sequence started, but a sequence is ${formatElapsed(expected)} — ${off > 0 ? "a gap" : "a shortfall"} of ${formatElapsed(Math.abs(off))}. Every boat's elapsed time is out by the same amount.`,
    };
  }

  /* The log is the authority. A postponement or general recall re-anchors the
     sequence, and sequenceState already accounts for that, so this compares
     against the anchor actually in force rather than the first tap. */
  const anchor = sequenceState(events).startedAt;
  if (anchor != null && Math.abs(anchor - sequenceStartAt) > toleranceMs) {
    return {
      problem: "The recorded times do not match the event log",
      detail: `The log says the sequence was armed at ${formatClockTime(anchor)}, but the race says ${formatClockTime(sequenceStartAt)} — ${formatElapsed(Math.abs(anchor - sequenceStartAt))} apart. Both timestamps are shifted together, so every boat's elapsed time is out by the same amount.`,
    };
  }

  return null;
}

/**
 * Elapsed race time for the pinned clock. Freezes at the ending, so a finished
 * race shows how long it took rather than how long ago it was.
 */
export function raceClock(startAt, now, endedAt = null) {
  if (startAt == null) return null;
  const until = endedAt ?? now;
  return formatElapsed(Math.max(0, until - startAt));
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
