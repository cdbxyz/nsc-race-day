/* Step 4 — the live race.
 *
 * Everything on this page is a pure render of the event log via state.js.
 * Nothing is held in a variable between taps, which is what makes killing the
 * page mid-race harmless: reload, replay, identical screen.
 *
 * One big explicit button per boat, walking it Lap 1 → Lap 2 → Finish. No long
 * presses, no swipes, no gesture anyone has to remember with wet hands.
 */

import {
  el, clear, panel, notice, field, armedButton, onArmChange, readOnlyBanner,
} from "./../ui.js";
import * as db from "./../db.js";
import * as rd from "./../raceday.js";
import * as log from "./../raceevents.js";
import {
  raceState,
  raceClock,
  formatElapsed,
  formatSplits,
  formatClockTime,
  plannedLaps,
  raceLabel,
  entryLabel,
  entryDetail,
  liveEvents,
  lastUndoable,
  scaledNow,
} from "./../state.js";
import { sequenceSpeed, isFastClock } from "./../devclock.js";
import * as device from "./../device.js";
import { keepAwake, allowSleep } from "./../wakelock.js";
import { navigate } from "./../router.js";

let host = null;
let context = null;
let ticker = null;
let sheetFor = null;
let showHistory = false;
let raceSheet = null;
let offArm = null;

export default {
  title: "Live race",

  async mount(section) {
    host = section.querySelector("#live-body");
    sheetFor = null;
    showHistory = false;
    raceSheet = null;
    offArm = onArmChange(render);
    await reload();
    keepAwake();
    // Only the race clock needs a tick; everything else redraws on write.
    ticker = setInterval(updateClock, 1000);
  },

  unmount() {
    if (ticker) clearInterval(ticker);
    ticker = null;
    offArm?.();
    offArm = null;
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

  const [events, entries, boats, members, classes] = await Promise.all([
    log.eventsForRace(race.id),
    rd.entriesForRace(race.id),
    db.getAll("boats"),
    db.getAll("helms"),
    db.getAll("classes"),
  ]);

  context = {
    raceDay,
    race,
    events,
    entries,
    boatById: new Map(boats.map((b) => [b.id, b])),
    helmById: new Map(members.map((h) => [h.id, h])),
    classById: new Map(classes.map((c) => [c.id, c])),
    /* The fast clock runs the whole race, not just the sequence: the same
       multiplier that compressed the countdown compresses the race clock,
       the lap splits and the finished rail. Nothing here is a second code
       path — raceState is handed a speed exactly as countdown() was. */
    state: raceState({ race, entries, events, speed: sequenceSpeed() }),
    // A second phone may watch the race in full; it just may not tap on it.
    claim: await device.claimState(raceDay),
  };
  return context;
}

async function reload() {
  await load();
  render();
}

/* Wall-clock instant -> the instant the race clock should show. Both the
   running clock and the frozen ending go through this, so a race that ends
   on the fast clock freezes at the time the OOD actually watched. */
function onRaceClock(state, instant) {
  if (instant == null) return null;
  return scaledNow({ anchor: state.startAt, now: instant, speed: sequenceSpeed() });
}

function raceClockText(state) {
  return (
    raceClock(state.startAt, onRaceClock(state, Date.now()), onRaceClock(state, state.endedAt)) ??
    "—"
  );
}

function updateClock() {
  if (!context || !host) return;
  const { state } = context;
  if (state.ended) return; // frozen at the ending
  const node = host.querySelector("#race-clock");
  if (node) node.textContent = raceClockText(state);
}

/* ---- render ------------------------------------------------------------- */

function render() {
  if (!host) return;

  if (!context) {
    clear(host).append(
      panel("No race running", [
        el("div.panel-body", {}, [el("p.stub", { text: "Nothing is under way." })]),
        el("div.actions", {}, [
          el("button.btn", { type: "button", text: "Race day setup", onclick: () => navigate("setup") }),
        ]),
      ])
    );
    return;
  }

  const { state } = context;

  if (state.abandoned) {
    clear(host).append(abandonedPanel());
    return;
  }

  const node = el("div");
  if (rd.isTestDay(context.raceDay)) {
    node.append(
      notice(
        "TEST DATA — this day was started in a dev mode. Nothing here counts, and no handicap win will be recorded.",
        "error"
      )
    );
  }
  /* Said plainly while it is happening, because the clock on this page and
     the times on the results sheet will not agree: what is stored is real
     wall clock, and only the display is compressed. */
  if (isFastClock()) {
    node.append(
      notice(
        `Fast clock ${sequenceSpeed()}× — this clock and the lap splits are compressed. Stored times are real, so the results sheet will show the true (short) elapsed times.`,
        "error"
      )
    );
  }
  const readOnly = !context.claim.canRecord;
  if (readOnly) {
    node.append(
      readOnlyBanner({
        byName: context.claim.byName,
        claimedAt: context.claim.claimedAt,
        onTakeOver: async () => {
          await device.claimRaceDay(context.raceDay);
          await reload();
        },
      })
    );
  }

  node.append(clockBar(state));
  if (state.ended) node.append(endedPanel(state));
  if (state.done.length) node.append(finishedRail(state));
  /* The whole race stays visible when read-only — an OOD taking over wants
     to see it before claiming it — but nothing that writes an event is
     offered, so there is no way to double-record by mistake. */
  if (!state.ended && !readOnly) node.append(racingGrid(state));
  if (!readOnly) {
    node.append(endBar(state));
    node.append(raceControls(state));
    if (sheetFor) node.append(boatSheet(state));
    if (raceSheet?.kind === "shorten") node.append(shortenSheet(state));
    if (raceSheet?.kind === "abandon") node.append(abandonSheet(state));
    if (raceSheet?.kind === "unaccounted") node.append(unaccountedSheet(state));
  }
  if (showHistory) node.append(historyDrawer());

  clear(host).append(node);
}

function clockBar(state) {
  // Spell the fleets out: "3/2" alone is readable in either direction, and
  // this header is the most likely place to misread the lap plan.
  const shortened = state.shortened
    ? ` · shortened to ${state.plan.fast} fast / ${state.plan.slow} slow`
    : ` · ${state.plan.fast} fast / ${state.plan.slow} slow`;

  return el("div.clockbar", {}, [
    el("div.clockbar-main", {}, [
      el("div.eyebrow", { text: `${raceLabel(context.race)}${shortened}` }),
      el("div.raceclock", {
        id: "race-clock",
        class: state.ended ? "frozen" : "",
        text: raceClockText(state),
      }),
    ]),
    /* Undo is compact chrome in the clock bar with no room for a sentence
       beneath it, so the reason goes in the label and the tooltip instead —
       the rule is that a disabled control explains itself, not that it must
       do so in one particular shape. */
    (() => {
      const can = lastUndoable(context.events) && context.claim.canRecord;
      return el("button.kill.undoall", {
        type: "button",
        text: can ? "Undo" : context.claim.canRecord ? "Nothing to undo" : "Read only",
        disabled: !can,
        title: can
          ? "Undo the last action"
          : context.claim.canRecord
            ? "Nothing has been recorded on this race yet"
            : "This day is being run on another phone",
        onclick: () => undoLast(),
      });
    })(),
  ]);
}

function finishedRail(state) {
  const rail = el("div.rail");

  /* Coded boats have no finishing position and must not take one — a RET
     sorted to the front would otherwise push the actual first boat to 2nd.
     Finishers are numbered in crossing order; coded boats follow, labelled. */
  const finishers = state.done
    .filter((b) => b.finished && !b.code)
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  const coded = state.done.filter((b) => b.code);

  const card = (boat, position) => {
    const name = entryLabel(entryParts(boat.entry));
    return el("button.railcard", {
      type: "button",
      class: boat.code ? "coded" : "",
      onclick: () => openSheet(boat.entryId),
    }, [
      el("span.railpos", { text: position ?? boat.code }),
      el("span.railboat", { text: name }),
      el("span.railtime", { text: boat.code ? "" : formatElapsed(boat.elapsedMs) }),
      boat.splits.length ? el("span.railsplits", { text: formatSplits(boat.splits) }) : null,
    ]);
  };

  finishers.forEach((boat, index) => rail.append(card(boat, String(index + 1))));
  coded.forEach((boat) => rail.append(card(boat, null)));

  return el("div.railwrap", {}, [
    el("div.raillabel", { text: `Finished · ${state.done.length}` }),
    rail,
  ]);
}

function racingGrid(state) {
  const grid = el("div.boatgrid");
  for (const boat of state.racing) grid.append(boatCard(boat));
  if (!state.racing.length) {
    grid.append(el("div.empty", {}, [el("p", { text: "Every boat is home or coded." })]));
  }
  return grid;
}

/**
 * Ending the race. Never automatic — the OOD decides when the last boat is in,
 * and a time limit expiring is a judgement call, not a timer.
 */
function endBar(state) {
  if (state.ended) {
    return el("div.actions", { style: "padding:12px 0 0" }, [
      el("button.btn", { type: "button", text: "Results →", onclick: () => navigate("results") }),
    ]);
  }

  const outstanding = state.unaccounted.length;

  if (outstanding) {
    return el("div.endbar", {}, [
      el("button.btn.ghost", {
        type: "button",
        text: `End race · ${outstanding} still out`,
        onclick: () => {
          raceSheet = { kind: "unaccounted" };
          render();
        },
      }),
    ]);
  }

  return el("div.endbar", {}, [
    armedButton("live.endRace", {
      label: "End race",
      armedLabel: "Tap again to end the race",
      classes: "endrace",
      onConfirm: () => endRaceNow(),
    }),
  ]);
}

function endedPanel(state) {
  return el("div.endednote", {}, [
    el("div.eyebrow", { text: "Race over" }),
    el("div.regmeta", {
      text: "Recorded in the log. Undo it from History if the race is still running.",
    }),
  ]);
}

async function endRaceNow() {
  await log.endRace(context.race.id);
  await rd.setRaceStatusIfEarlier(context.race, "finished");
  navigator.vibrate?.([60, 40, 60]);
  navigate("results");
}

/** Who is still out, and how to account for them. */
function unaccountedSheet(state) {
  const close = () => {
    raceSheet = null;
    render();
  };

  const rows = el("div.reglist");
  for (const boat of state.unaccounted) {
    const name = entryLabel(entryParts(boat.entry));
    const codes = el("div.codesrow");
    for (const [code] of CODES) {
      codes.append(
        el("button.kill.codechip", {
          type: "button",
          text: code,
          onclick: async () => {
            await log.applyCode(context.race.id, boat.entryId, code);
            await reload();
          },
        })
      );
    }
    rows.append(
      el("div.regrow", {}, [
        el("div.regmain", {}, [
          el("div.regname", { text: name }),
          el("div.regmeta", { text: `Lap ${boat.onLap} of ${boat.lapsPlanned}` }),
          codes,
        ]),
      ])
    );
  }

  return el("div.sheetscrim", {
    onclick: (e) => e.target.classList.contains("sheetscrim") && close(),
  }, [
    el("div.boatsheet", {}, [
      el("div.eyebrow", { text: "Still on the water" }),
      el("h2", { text: `${state.unaccounted.length} boat${state.unaccounted.length === 1 ? "" : "s"} unaccounted` }),
      el("p.stub", {
        text: "The race cannot end while a boat is unaccounted for — that list is what stand-down checks. Give each one a code, or code them all DNF if the time limit has expired.",
      }),
      rows,
      el("div.actions", {}, [
        armedButton("live.bulkDnf", {
          label: "Code all remaining as DNF",
          armedLabel: "Tap again to code them all DNF",
          classes: "danger",
          onConfirm: async () => {
            for (const boat of state.unaccounted) {
              await log.applyCode(context.race.id, boat.entryId, "DNF");
            }
            raceSheet = null;
            await reload();
          },
        }),
        el("button.btn.ghost", { type: "button", text: "Back to the race", onclick: close }),
      ]),
    ]),
  ]);
}

function boatCard(boat) {
  const parts = entryParts(boat.entry);

  const splits = formatSplits(boat.splits);
  const meta = [entryDetail(parts), `Lap ${boat.onLap} of ${boat.lapsPlanned}`]
    .filter(Boolean)
    .join(" · ");

  const isFinish = boat.action === "finish";
  const card = el("div.boatcard", { dataset: { entry: boat.entryId } }, [
    el("div.boatinfo", {}, [
      el("div.boatname", { text: entryLabel(parts) }),
      el("div.boatmeta", { text: meta }),
      splits ? el("div.boatsplits", { text: splits }) : null,
    ]),
    el(`button.lapbtn${isFinish ? ".finish" : ""}`, {
      type: "button",
      text: isFinish ? "Finish" : `Lap ${boat.onLap}`,
      onclick: () => recordCrossing(boat, isFinish, card),
    }),
    el("button.morebtn", {
      type: "button",
      text: "⋯",
      "aria-label": `More for ${entryLabel(parts)}`,
      onclick: () => openSheet(boat.entryId),
    }),
  ]);

  return card;
}

/** The people, hull and class behind an entry, for display. */
function entryParts(entry) {
  return {
    boat: entry.boat_id ? context.boatById.get(entry.boat_id) ?? null : null,
    helm: context.helmById.get(entry.helm_id) ?? null,
    crew: entry.crew_id ? context.helmById.get(entry.crew_id) ?? null : null,
    klass: context.classById.get(entry.class_id) ?? null,
  };
}

function raceControls(state) {
  return el("div.racecontrols", {}, [
    el("button.btn.ghost", {
      type: "button",
      text: "History",
      onclick: () => {
        showHistory = !showHistory;
        render();
      },
    }),
    el("button.btn.ghost", {
      type: "button",
      text: "Shorten course",
      onclick: () => shortenCourse(state),
    }),
    el("button.btn.ghost.danger-text", {
      type: "button",
      text: "Abandon",
      onclick: () => abandonRace(),
    }),
  ]);
}

/* ---- actions ------------------------------------------------------------ */

/** A crossing. Committed to IndexedDB before the card acknowledges it. */
async function recordCrossing(boat, isFinish, card) {
  const raceId = context.race.id;
  card.classList.add("busy");
  try {
    if (isFinish) await log.recordFinish(raceId, boat.entryId);
    else await log.recordLap(raceId, boat.entryId);
    // Only now — the record exists, so the confirmation is truthful.
    navigator.vibrate?.(isFinish ? [60, 40, 60] : 40);
    card.classList.add("flash");
    await reload();
  } catch (err) {
    card.classList.remove("busy");
    host.prepend(notice(`Could not record that: ${err.message}`, "error"));
  }
}

async function undoLast() {
  const target = lastUndoable(context.events);
  if (!target) return;
  await log.undoEvent(context.race.id, target.id);
  navigator.vibrate?.(30);
  await reload();
}

function openSheet(entryId) {
  sheetFor = entryId;
  render();
}

const CODES = [
  ["OCS", "On course side at the start"],
  ["RET", "Retired"],
  ["DNF", "Did not finish"],
  ["DSQ", "Disqualified"],
];

function boatSheet(state) {
  const boat = state.boats.find((b) => b.entryId === sheetFor);
  if (!boat) {
    sheetFor = null;
    return el("div");
  }
  const name = entryLabel(entryParts(boat.entry));
  const ownLast = lastUndoable(context.events, { entryId: boat.entryId });

  const close = () => {
    sheetFor = null;
    render();
  };

  const codeButtons = CODES.map(([code, description]) =>
    el("button.codebtn", {
      type: "button",
      onclick: async () => {
        await log.applyCode(context.race.id, boat.entryId, code);
        sheetFor = null;
        await reload();
      },
    }, [el("span.codename", { text: code }), el("span.codedesc", { text: description })])
  );

  return el("div.sheetscrim", { onclick: (e) => e.target.classList.contains("sheetscrim") && close() }, [
    el("div.boatsheet", {}, [
      el("div.eyebrow", { text: name }),
      el("h2", { text: boat.code ? `Coded ${boat.code}` : `Lap ${boat.onLap} of ${boat.lapsPlanned}` }),
      ...codeButtons,
      el("button.btn.ghost", {
        type: "button",
        text: ownLast ? `Undo this boat's last (${describe(ownLast)})` : "Nothing to undo",
        disabled: !ownLast,
        title: ownLast ? "" : "Nothing has been recorded against this boat yet",
        onclick: async () => {
          await log.undoEvent(context.race.id, ownLast.id);
          sheetFor = null;
          await reload();
        },
      }),
      el("button.btn", { type: "button", text: "Close", onclick: close }),
    ]),
  ]);
}

function describe(event) {
  if (event.type === "lap_recorded") return "lap";
  if (event.type === "boat_finished") return "finish";
  if (event.type === "code_applied") return event.payload?.code ?? "code";
  if (event.type === "status_overridden") {
    // Spelled out, because this is the one event a human forced by hand and
    // the history drawer is where anyone will come looking for it.
    return `status forced: ${event.payload?.from ?? "?"} → ${event.payload?.to ?? "?"}`;
  }
  return event.type.replace(/_/g, " ");
}

function historyDrawer() {
  const live = liveEvents(context.events);
  const rows = el("div.reglist");

  for (const event of [...live].reverse()) {
    if (event.type === "sequence_started") continue;
    const entry = context.entries.find((e) => e.id === event.entry_id);
    const boatName = entry ? entryLabel(entryParts(entry)) : "Race";
    rows.append(
      el("div.regrow", {}, [
        el("div.regmain", {}, [
          el("div.regname", { text: `${boatName ?? "Race"} · ${describe(event)}` }),
          el("div.regmeta", { text: formatClockTime(Date.parse(event.occurred_at)) }),
        ]),
        el("button.kill", {
          type: "button",
          disabled: !context.claim.canRecord,
          title: context.claim.canRecord ? "" : "This day is being run on another phone",
          text: "Undo",
          onclick: async () => {
            await log.undoEvent(context.race.id, event.id);
            await reload();
          },
        }),
      ])
    );
  }

  if (!rows.childElementCount) {
    rows.append(el("div.empty", {}, [el("p", { text: "Nothing recorded yet." })]));
  }

  return el("div.sheetscrim", {
    onclick: (e) => {
      if (!e.target.classList.contains("sheetscrim")) return;
      showHistory = false;
      render();
    },
  }, [
    el("div.boatsheet.historysheet", {}, [
      el("div.eyebrow", { text: "Everything recorded" }),
      el("h2", { text: "History" }),
      rows,
      el("button.btn", {
        type: "button",
        text: "Close",
        onclick: () => {
          showHistory = false;
          render();
        },
      }),
    ]),
  ]);
}

/* ---- race-level, behind two steps ---------------------------------------
 *
 * Both are inline sheets rather than native dialogs. A browser prompt blocks
 * the page, is miserable on a phone, and cannot show the OOD what the change
 * would actually do — which is the whole point of a second step.
 * --------------------------------------------------------------------- */

function shortenCourse(state) {
  raceSheet = { kind: "shorten", stage: 1, fast: state.plan.fast, slow: state.plan.slow };
  render();
}

function abandonRace() {
  raceSheet = { kind: "abandon", stage: 1 };
  render();
}

function closeRaceSheet() {
  raceSheet = null;
  render();
}

function shortenSheet(state) {
  const fastBox = field("Laps · fast fleet", {
    type: "number", min: 1, max: 20, inputMode: "numeric", value: raceSheet.fast,
  });
  const slowBox = field("Laps · slow fleet", {
    type: "number", min: 1, max: 20, inputMode: "numeric", value: raceSheet.slow,
  });

  if (raceSheet.stage === 1) {
    return sheet("Shorten course", [
      el("p.stub", {
        text: `Currently ${state.plan.fast} laps fast, ${state.plan.slow} slow. Boats that have already finished are not affected.`,
      }),
      fastBox.node,
      slowBox.node,
      el("div.actions", {}, [
        el("button.btn", {
          type: "button",
          text: "Review",
          onclick: () => {
            raceSheet = {
              kind: "shorten",
              stage: 2,
              fast: Number(fastBox.input.value),
              slow: Number(slowBox.input.value),
            };
            render();
          },
        }),
        el("button.btn.ghost", { type: "button", text: "Cancel", onclick: closeRaceSheet }),
      ]),
    ]);
  }

  // Second step: say plainly what it will do to the boats still out there.
  const affected = state.racing.filter((boat) => {
    const planned = plannedLaps(boat.entry, { fast: raceSheet.fast, slow: raceSheet.slow });
    return boat.lapsDone >= planned - 1;
  });

  return sheet("Shorten course", [
    el("p.confirmline", {
      text: `${state.plan.fast} fast / ${state.plan.slow} slow → ${raceSheet.fast} fast / ${raceSheet.slow} slow`,
    }),
    el("p.stub", {
      text: affected.length
        ? `${affected.length} of the ${state.racing.length} boats still racing will be on their finishing lap.`
        : "No boat still racing reaches its finish yet.",
    }),
    el("div.actions", {}, [
      el("button.btn.danger", {
        type: "button",
        text: "Shorten now",
        onclick: async () => {
          await log.shortenCourse(context.race.id, {
            fastLaps: raceSheet.fast,
            slowLaps: raceSheet.slow,
          });
          navigator.vibrate?.([60, 40, 60]);
          raceSheet = null;
          await reload();
        },
      }),
      el("button.btn.ghost", { type: "button", text: "Back", onclick: () => {
        raceSheet = { ...raceSheet, stage: 1 };
        render();
      } }),
    ]),
  ]);
}

function abandonSheet(state) {
  if (raceSheet.stage === 1) {
    return sheet("Abandon race", [
      el("p.stub", {
        text: "There will be no results for this race. The sign-on list is kept, so a resail can carry the same boats forward.",
      }),
      el("div.actions", {}, [
        el("button.btn.danger", {
          type: "button",
          text: "Continue",
          onclick: () => {
            raceSheet = { kind: "abandon", stage: 2 };
            render();
          },
        }),
        el("button.btn.ghost", { type: "button", text: "Cancel", onclick: closeRaceSheet }),
      ]),
    ]);
  }

  return sheet("Abandon race", [
    el("p.confirmline", { text: `${raceLabel(context.race)} · ${state.boats.length} boats` }),
    el("p.stub", { text: "This is recorded in the log and cannot be taken back from here." }),
    el("div.actions", {}, [
      el("button.btn.danger", {
        type: "button",
        text: "Abandon the race",
        onclick: async () => {
          await log.abandonRace(context.race.id);
          await rd.setRaceStatusIfEarlier(context.race, "abandoned");
          raceSheet = null;
          await reload();
        },
      }),
      el("button.btn.ghost", { type: "button", text: "Back", onclick: () => {
        raceSheet = { kind: "abandon", stage: 1 };
        render();
      } }),
    ]),
  ]);
}

function sheet(title, children) {
  return el("div.sheetscrim", {
    onclick: (e) => e.target.classList.contains("sheetscrim") && closeRaceSheet(),
  }, [
    el("div.boatsheet", {}, [el("div.eyebrow", { text: "Race" }), el("h2", { text: title }), ...children]),
  ]);
}

function abandonedPanel() {
  return panel("Race abandoned", [
    el("div.panel-body", {}, [
      el("p.stub", {
        text: "No results for this race. The sign-on list is kept, so a resail can carry the same boats forward.",
      }),
    ]),
    el("div.actions", {}, [
      el("button.btn", { type: "button", text: "Sign-on for the next race", onclick: () => navigate("signon") }),
    ]),
  ]);
}
