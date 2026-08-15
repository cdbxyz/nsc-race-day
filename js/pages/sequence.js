/* Step 3 — the start sequence.
 *
 * One tap writes `sequence_started`; everything after that is derived. The
 * countdown is recomputed from that stored timestamp against the wall clock on
 * every frame, so a phone that slept for four minutes wakes up showing the
 * truth rather than four minutes of accumulated error.
 *
 * Visual only. The horn is the real signal; this is the thing beside it.
 */

import { el, clear, panel, notice, field, armedButton } from "./../ui.js";
import * as db from "./../db.js";
import * as rd from "./../raceday.js";
import * as log from "./../raceevents.js";
import { sequenceState, countdown, marksCrossed } from "./../state.js";
import { keepAwake, allowSleep } from "./../wakelock.js";
import { navigate } from "./../router.js";

let host = null;
let ticker = null;
let context = null;
/* The previous countdown reading, so a crossed mark is detected by comparison
   rather than by a timer that a sleeping phone would simply miss. */
let lastSeconds = null;
let handedOver = false;

export default {
  title: "Start sequence",

  async mount(section) {
    host = section.querySelector("#sequence-body");
    lastSeconds = null;
    handedOver = false;
    await load();
    render();
    // A repaint every 250ms keeps the seconds honest without being a clock.
    ticker = setInterval(render, 250);
  },

  unmount() {
    if (ticker) clearInterval(ticker);
    ticker = null;
    host = null;
    context = null;
    allowSleep();
  },
};

async function load() {
  const raceDay = await rd.openRaceDay();
  if (!raceDay) return (context = null);
  const race = await rd.currentRace(raceDay.id);
  if (!race) return (context = null);
  const events = await log.eventsForRace(race.id);
  const entries = await rd.entriesForRace(race.id);
  context = { raceDay, race, events, entries };
  return context;
}

async function reload() {
  await load();
  render();
}

function render() {
  if (!host) return;

  if (!context) {
    clear(host).append(
      panel("No race to start", [
        el("div.panel-body", {}, [el("p.stub", { text: "Set up the day and sign boats on first." })]),
        el("div.actions", {}, [
          el("button.btn", { type: "button", text: "Race day setup", onclick: () => navigate("setup") }),
        ]),
      ])
    );
    return;
  }

  const { race, events, entries } = context;
  const sequence = sequenceState(events);

  if (!sequence.running) {
    clear(host).append(armPanel(race, entries, sequence));
    return;
  }

  keepAwake();

  const now = Date.now();
  const clock = countdown(sequence.startAt, now);

  // Pulse on each mark. Comparing two readings catches marks that passed while
  // the phone was asleep, and cannot fire the same one twice.
  for (const mark of marksCrossed(lastSeconds, clock.remainingSeconds)) {
    navigator.vibrate?.(mark.at === 0 ? [200, 80, 200] : 120);
  }
  lastSeconds = clock.remainingSeconds;

  if (clock.started && !handedOver) {
    handedOver = true;
    startRacing(race, sequence.startAt);
    return;
  }

  clear(host).append(countdownPanel(race, clock, sequence));
}

function armPanel(race, entries, sequence) {
  const body = el("div.panel-body");

  if (sequence.postponed) {
    body.append(notice("Sequence postponed (AP). Start again when the fleet is ready.", "info"));
  }
  body.append(
    el("div.regname", { text: `Race ${race.number} · ${entries.length} boats signed on` }),
    el("p.stub", {
      text: "Ten minutes from the tap: class flag at 10, P flag at 5, P down at 1, start at 0. The phone is a visual aid — the horn is the signal.",
    })
  );

  const start = el("button.btn.bigstart", {
    type: "button",
    text: "Start 10-minute sequence",
    onclick: async () => {
      start.disabled = true;
      // Written before anything else happens, so the tap time is the record.
      await log.startSequence(race.id);
      await rd.setRaceStatusIfEarlier(race, "sequence");
      lastSeconds = null;
      await reload();
    },
  });

  return panel("Step 3 · Start sequence", [body, el("div.actions", {}, [start])]);
}

function countdownPanel(race, clock, sequence) {
  const phase = clock.phase;

  const wrap = el(`div.countdown.tone-${phase.tone}`, {}, [
    el("div.eyebrow", { text: `Race ${race.number}` }),
    el("div.cd-clock", { text: clock.display }),
    el("div.cd-flag", { text: phase.label }),
    sequence.generalRecalls
      ? el("div.cd-note", {
          text: `${sequence.generalRecalls} general recall${sequence.generalRecalls === 1 ? "" : "s"}`,
        })
      : null,
  ]);

  /* Always visible, never behind a menu: these are the two things an OOD
     needs instantly when a start goes wrong.

     Tap-to-arm rather than a dialog. A blocking confirm during a live start is
     the wrong trade — but so is a pocket-tap voiding the sequence, so the
     second tap has to land within a few seconds or the button disarms. */
  const controls = el("div.cd-controls", {}, [
    armedButton("Postpone (AP)", "Tap again to postpone", "ghost", async () => {
      await log.postpone(race.id);
      lastSeconds = null;
      await reload();
    }),
    armedButton("General recall", "Tap again to recall", "danger", async () => {
      await log.generalRecall(race.id);
      lastSeconds = null;
      await reload();
    }),
  ]);

  return el("div", {}, [wrap, controls]);
}

/** At zero: record the gun and hand over to the live race page. */
async function startRacing(race, startAt) {
  try {
    await rd.setRaceStatusIfEarlier(race, "racing", {
      status: "racing",
      start_at: new Date(startAt).toISOString(),
      sequence_start_at: new Date(startAt - 10 * 60 * 1000).toISOString(),
    });
  } catch (err) {
    console.error("could not record the start", err);
  }
  navigate("live");
}
