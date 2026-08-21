/* Step 3 — the start sequence.
 *
 * One tap writes `sequence_started`; everything after that is derived. The
 * countdown is recomputed from that stored timestamp against the wall clock on
 * every frame, so a phone that slept for four minutes wakes up showing the
 * truth rather than four minutes of accumulated error.
 *
 * Visual only. The horn is the real signal; this is the thing beside it.
 */

import {
  el, clear, panel, notice, field, armedButton, onArmChange, readOnlyBanner, windControls,
} from "./../ui.js";
import * as db from "./../db.js";
import * as rd from "./../raceday.js";
import * as log from "./../raceevents.js";
import {
  sequenceState, countdown, marksCrossed, raceLabel, scaledNow, wallClockAt, SEQUENCE_MS,
} from "./../state.js";
import { sequenceSpeed, isFastClock, onSpeedChange } from "./../devclock.js";
import { wouldBeTestData } from "./../devmode.js";
import * as device from "./../device.js";
import { COMPASS, FORCE_CHOICES, windText } from "./../wind.js";
import { PURSUIT_CALCULATOR_URL } from "./../calendar.js";
import { keepAwake, allowSleep, sleepWarning } from "./../wakelock.js";
import { navigate } from "./../router.js";

let host = null;
let ticker = null;
let context = null;
/* The previous countdown reading, so a crossed mark is detected by comparison
   rather than by a timer that a sleeping phone would simply miss. */
let lastSeconds = null;
let handedOver = false;
let offArm = null;
let offSpeed = null;
/* The live nodes the tick updates, so the panel — and its buttons — are built
   once rather than four times a second. Replacing a button mid-gesture is a
   good way to make it untappable. */
let live = null;

export default {
  title: "Start sequence",

  async mount(section) {
    host = section.querySelector("#sequence-body");
    lastSeconds = null;
    handedOver = false;
    await load();
    render();
    offArm = onArmChange(render);
    offSpeed = onSpeedChange(render);
    // Only the digits move; see tick().
    ticker = setInterval(tick, 250);
  },

  unmount() {
    if (ticker) clearInterval(ticker);
    ticker = null;
    offArm?.();
    offArm = null;
    offSpeed?.();
    offSpeed = null;
    live = null;
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
  context = { raceDay, race, events, entries, claim: await device.claimState(raceDay) };
  return context;
}

async function reload() {
  await load();
  render();
}

/** Move the clock without rebuilding anything that can be tapped. */
function tick() {
  if (!host || !context || !live) return;
  const sequence = sequenceState(context.events);
  if (!sequence.running) return render();

  const clock = countdown(
    sequence.startAt,
    scaledNow({ anchor: sequence.startedAt, now: Date.now(), speed: sequenceSpeed() })
  );

  for (const mark of marksCrossed(lastSeconds, clock.remainingSeconds)) {
    navigator.vibrate?.(mark.at === 0 ? [200, 80, 200] : 120);
  }
  lastSeconds = clock.remainingSeconds;

  if (clock.started && !handedOver) {
    handedOver = true;
    startRacing(context.race, sequence, sequenceSpeed());
    return;
  }

  live.clock.textContent = clock.display;
  live.flag.textContent = clock.phase.label;
  live.panel.className = `countdown tone-${clock.phase.tone}`;
  // Only the highlight moves; the images are not rebuilt four times a second.
  const active = FLAG_STAGES.reduce(
    (best, stage, index) => (clock.remainingSeconds <= stage.at ? index : best),
    0
  );
  [...live.flags.children].forEach((card, index) => card.classList.toggle("on", index === active));
}

function render() {
  if (!host) return;
  live = null;

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

  /* Arming the gun is the single most damaging thing two phones could do at
     once — two sequences, two guns, a fleet that does not know which is
     real. So the read-only banner replaces the whole page here rather than
     just hiding a button. */
  if (!context.claim.canRecord) {
    clear(host).append(
      panel("Start sequence", [
        el("div.panel-body", {}, [
          readOnlyBanner({
            byName: context.claim.byName,
            claimedAt: context.claim.claimedAt,
            myName: context.claim.myName,
            onTakeOver: async (name) => {
              await device.setDeviceName(name);
              await device.claimRaceDay(context.raceDay);
              await reload();
            },
          }),
        ]),
      ])
    );
    return;
  }

  if (!sequence.running) {
    clear(host).append(armPanel(race, entries, sequence));
    return;
  }

  keepAwake();

  const clock = countdown(
    sequence.startAt,
    scaledNow({ anchor: sequence.startedAt, now: Date.now(), speed: sequenceSpeed() })
  );

  // Pulse on each mark. Comparing two readings catches marks that passed while
  // the phone was asleep, and cannot fire the same one twice.
  for (const mark of marksCrossed(lastSeconds, clock.remainingSeconds)) {
    navigator.vibrate?.(mark.at === 0 ? [200, 80, 200] : 120);
  }
  lastSeconds = clock.remainingSeconds;

  if (clock.started && !handedOver) {
    handedOver = true;
    startRacing(race, sequence, sequenceSpeed());
    return;
  }

  clear(host).append(countdownPanel(race, clock, sequence));
}

/**
 * What is flying while racing is postponed.
 *
 * AP is the one flag with artwork that rendered nowhere, and a postponement
 * is exactly when an OOD most needs telling what is on the pole — it may be
 * an hour before the wind fills in, and the answer has to survive the phone
 * being pocketed, locked and reopened.
 *
 * It needs no state of its own: `postponed` is derived from the event log
 * like everything else, so a phone reopened mid-postponement shows this for
 * the same reason it showed it before. It clears when the sequence restarts,
 * which is the moment AP comes down.
 */
function apPanel() {
  return el("div.apstate", {}, [
    el("img.flagimg.flagimg-light", { src: "img/flags/ap.svg", alt: "AP — answering pennant" }),
    el("div.apwords", {}, [
      el("div.aptitle", { text: "AP flying — racing postponed" }),
      el("p.apnote", {
        text: "Lower AP and restart the sequence when the fleet is ready. Nothing is lost by waiting.",
      }),
    ]),
  ]);
}

function armPanel(race, entries, sequence) {
  const body = el("div.panel-body");

  if (sequence.postponed) body.append(apPanel());
  if (isFastClock()) body.append(testClockNotice());
  const sleepNote = sleepWarning();
  if (sleepNote) body.append(notice(sleepNote, "info"));
  if (race.is_pursuit) body.append(pursuitNotice());
  /* Arriving here must not feel like anything has happened. Getting to this
     page is navigation; the gun is armed by the button at the bottom and by
     nothing else, and the OOD needs to know which flag to have in hand
     BEFORE they tap it rather than five seconds after. */
  body.append(
    el("div.regname", { text: `${raceLabel(race)} · ${entries.length} boats signed on` }),
    /* Only one explanation at a time: while AP is up it has already said why
       nothing is running, and "nothing has started yet" would be wrong —
       something started and was postponed. */
    sequence.postponed ? null : el("div.prestart", {}, [
      el("img.flagimg.flagimg-light", {
        src: "img/flags/class.svg",
        alt: "Class flag",
      }),
      el("div.prestart-words", {}, [
        el("div.prestart-title", { text: "Nothing has started yet" }),
        el("p.prestart-note", {
          text: "Have the class flag ready. Tapping Start below begins the ten minutes and records the time — it does not sound anything, so make the signal yourself.",
        }),
      ]),
    ]),
    el("p.stub", {
      text: "From the tap: class flag at 10, P flag at 5, P down at 1, start at 0. The phone is a visual aid — the horn is the signal.",
    })
  );

  body.append(windPicker(race));

  const start = el("button.btn.go.bigstart", {
    type: "button",
    text: "Start 10-minute sequence",
    onclick: async () => {
      start.disabled = true;
      // Written before anything else happens, so the tap time is the record.
      await log.startSequence(race.id);
      await rd.setRaceStatusIfEarlier(race, "sequence");
      /* A sequence begun in ANY non-production mode makes the whole day test
         data, permanently — a fast clock, or a sync destination that is not
         the club's database. The events it produces carry real timestamps
         and are otherwise indistinguishable from a real race, so the day
         itself has to carry the flag. Caught here as well as at day creation
         because a mode can be switched on halfway through. */
      if (wouldBeTestData()) await rd.markRaceDayAsTest(context.raceDay);
      /* Seed just above 10:00 so the first reading CROSSES the class-flag
         mark and pulses. A null previous stays silent, which is what opening
         the page part-way through a running sequence should do — but tapping
         Start is itself the 10:00 moment and deserves the confirmation. */
      lastSeconds = SEQUENCE_MS / 1000 + 1;
      await reload();
    },
  });

  return panel("Step 3 · Start sequence", [body, el("div.actions", {}, [start])]);
}

function countdownPanel(race, clock, sequence) {
  const phase = clock.phase;

  const clockNode = el("div.cd-clock", { text: clock.display });
  const flagNode = el("div.cd-flag", { text: phase.label });

  const flagsNode = flagStrip(clock.remainingSeconds);

  const wrap = el(`div.countdown.tone-${phase.tone}`, {}, [
    el("div.eyebrow", { text: raceLabel(race) }),
    clockNode,
    flagNode,
    flagsNode,
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
    armedButton("sequence.postpone", {
      label: "Postpone (AP)",
      armedLabel: "Tap again to postpone",
      classes: "ghost",
      onConfirm: async () => {
        await log.postpone(race.id);
        lastSeconds = null;
        await reload();
      },
    }),
    armedButton("sequence.recall", {
      label: "General recall",
      armedLabel: "Tap again to recall",
      classes: "danger",
      onConfirm: async () => {
        await log.generalRecall(race.id);
        lastSeconds = null;
        await reload();
      },
    }),
  ]);

  live = { clock: clockNode, flag: flagNode, panel: wrap, flags: flagsNode };
  const parts = [wrap, controls];
  if (isFastClock()) parts.unshift(testClockNotice());
  return el("div", {}, parts);
}

/** Conditions are captured before the gun, while someone is looking at them. */
function windPicker(race) {
  const summary = el("div.windline", { text: windText(race) ?? "Wind not recorded" });

  const controls = windControls({
    direction: race.wind_direction ?? null,
    force: race.wind_force ?? null,
    compass: COMPASS,
    forces: FORCE_CHOICES,
    onChange: async ({ direction, force }) => {
      context.race = await rd.setRaceWind(context.race, { direction, force });
      summary.textContent = windText(context.race) ?? "Wind not recorded";
    },
  });

  controls.node.append(summary);
  return controls.node;
}

function pursuitNotice() {
  const box = notice(
    "Pursuit start — this app cannot run one. Use the club's pursuit calculator instead.",
    "error"
  );
  box.append(el("a.pursuitlink", {
    href: PURSUIT_CALCULATOR_URL, target: "_blank", rel: "noopener",
    text: "cdbxyz.github.io/nsc-race-calc",
  }));
  return box;
}

/* The flags the OOD should have up. Placeholder artwork lives in img/flags/
   and is sized so real assets drop straight in. */
const FLAG_STAGES = [
  { at: 600, src: "img/flags/class.svg", cap: "Class · 10:00" },
  { at: 300, src: "img/flags/p.svg", cap: "P up · 5:00" },
  { at: 60, src: "img/flags/p.svg", cap: "P down · 1:00", down: true },
  { at: 0, src: "img/flags/start.svg", cap: "Start · 0:00" },
];

function flagStrip(remainingSeconds) {
  const strip = el("div.flagstrip");
  // The stage in force is the last mark already reached.
  const activeIndex = FLAG_STAGES.reduce(
    (best, stage, index) => (remainingSeconds <= stage.at ? index : best),
    0
  );
  FLAG_STAGES.forEach((stage, index) => {
    strip.append(
      el(`div.flagcard${index === activeIndex ? ".on" : ""}${stage.down ? ".down" : ""}`, {}, [
        el("img.flagimg", { src: stage.src, alt: "" }),
        el("span.flagcap", { text: stage.cap }),
      ])
    );
  });
  return strip;
}

/** Impossible to miss: a race started now is not a real one. */
function testClockNotice() {
  return notice(
    `Fast clock ${sequenceSpeed()}× — a race started now is marked TEST DATA and its results are not real.`,
    "error"
  );
}

/**
 * At zero: record the gun and hand over to the live race page.
 *
 * `sequence` carries both instants this needs and they are NOT the same
 * thing. `startAt` is the gun on the countdown's own clock, which may be
 * compressed; `startedAt` is the real moment the sequence was armed. The gun
 * that goes into the database has to be a wall-clock instant, because every
 * occurred_at it will later be subtracted from is one.
 *
 * sequence_start_at is the arming moment itself rather than "the gun minus
 * ten minutes". Those coincide only at 1x with no general recall, and relying
 * on a coincidence is how the original bug survived.
 */
async function startRacing(race, sequence, speed) {
  const gunAt = wallClockAt({
    anchor: sequence.startedAt,
    scaled: sequence.startAt,
    speed,
  });

  try {
    await rd.setRaceStatusIfEarlier(race, "racing", {
      status: "racing",
      start_at: new Date(gunAt).toISOString(),
      sequence_start_at: new Date(sequence.startedAt).toISOString(),
    });
  } catch (err) {
    console.error("could not record the start", err);
  }
  navigate("live");
}
