/* Step 4 — the live race.
 *
 * Everything on this page is a pure render of the event log via state.js.
 * Nothing is held in a variable between taps, which is what makes killing the
 * page mid-race harmless: reload, replay, identical screen.
 *
 * One big explicit button per boat, walking it Lap 1 → Lap 2 → Finish. No long
 * presses, no swipes, no gesture anyone has to remember with wet hands.
 */

import { el, clear, panel, notice, field, armedButton, onArmChange } from "./../ui.js";
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
  liveEvents,
  lastUndoable,
} from "./../state.js";
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

  const [events, entries, boats, helms] = await Promise.all([
    log.eventsForRace(race.id),
    rd.entriesForRace(race.id),
    db.getAll("boats"),
    db.getAll("helms"),
  ]);

  context = {
    raceDay,
    race,
    events,
    entries,
    boatById: new Map(boats.map((b) => [b.id, b])),
    helmById: new Map(helms.map((h) => [h.id, h])),
    state: raceState({ race, entries, events }),
  };
  return context;
}

async function reload() {
  await load();
  render();
}

function updateClock() {
  if (!context || !host) return;
  const { state } = context;
  if (state.ended) return; // frozen at the ending
  const node = host.querySelector("#race-clock");
  if (node) node.textContent = raceClock(state.startAt, Date.now(), state.endedAt) ?? "—";
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
  node.append(clockBar(state));
  if (state.ended) node.append(endedPanel(state));
  if (state.done.length) node.append(finishedRail(state));
  if (!state.ended) node.append(racingGrid(state));
  node.append(endBar(state));
  node.append(raceControls(state));
  if (sheetFor) node.append(boatSheet(state));
  if (showHistory) node.append(historyDrawer());
  if (raceSheet?.kind === "shorten") node.append(shortenSheet(state));
  if (raceSheet?.kind === "abandon") node.append(abandonSheet(state));
  if (raceSheet?.kind === "unaccounted") node.append(unaccountedSheet(state));

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
      el("div.eyebrow", { text: `Race ${context.race.number}${shortened}` }),
      el("div.raceclock", {
        id: "race-clock",
        class: state.ended ? "frozen" : "",
        text: raceClock(state.startAt, Date.now(), state.endedAt) ?? "—",
      }),
    ]),
    el("button.kill.undoall", {
      type: "button",
      text: "Undo",
      disabled: !lastUndoable(context.events),
      onclick: () => undoLast(),
    }),
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
    const name = context.boatById.get(boat.entry.boat_id)?.name ?? "?";
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
    const name = context.boatById.get(boat.entry.boat_id)?.name ?? "boat";
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
  const boatRow = context.boatById.get(boat.entry.boat_id);
  const helm = context.helmById.get(boat.entry.helm_id);

  const splits = formatSplits(boat.splits);
  const meta = [helm?.name ?? "", `Lap ${boat.onLap} of ${boat.lapsPlanned}`]
    .filter(Boolean)
    .join(" · ");

  const isFinish = boat.action === "finish";
  const card = el("div.boatcard", { dataset: { entry: boat.entryId } }, [
    el("div.boatinfo", {}, [
      el("div.boatname", { text: boatRow?.name ?? "unknown" }),
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
      "aria-label": `More for ${boatRow?.name ?? "boat"}`,
      onclick: () => openSheet(boat.entryId),
    }),
  ]);

  return card;
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
  const name = context.boatById.get(boat.entry.boat_id)?.name ?? "boat";
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
  return event.type.replace(/_/g, " ");
}

function historyDrawer() {
  const live = liveEvents(context.events);
  const rows = el("div.reglist");

  for (const event of [...live].reverse()) {
    if (event.type === "sequence_started") continue;
    const entry = context.entries.find((e) => e.id === event.entry_id);
    const boatName = entry ? context.boatById.get(entry.boat_id)?.name : "Race";
    rows.append(
      el("div.regrow", {}, [
        el("div.regmain", {}, [
          el("div.regname", { text: `${boatName ?? "Race"} · ${describe(event)}` }),
          el("div.regmeta", { text: formatClockTime(Date.parse(event.occurred_at)) }),
        ]),
        el("button.kill", {
          type: "button",
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
    el("p.confirmline", { text: `Race ${context.race.number} · ${state.boats.length} boats` }),
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
