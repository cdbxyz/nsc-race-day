/* Step 6 — stand-down.
 *
 * Opens with the tally check, because that is the safety net: every boat that
 * signed on today, across every race, listed as finished, coded, or
 * UNACCOUNTED. Unaccounted boats are red and block completion — the whole
 * point is that this is generated from the record rather than from memory at
 * the end of a long afternoon.
 *
 * Completing closes the race day and pushes whatever is still queued, with a
 * plain warning if anything has not reached the club database.
 */

import { el, clear, panel, notice, actionWithReason } from "./../ui.js";
import * as db from "./../db.js";
import * as rd from "./../raceday.js";
import * as log from "./../raceevents.js";
import { boatState, lapPlan, raceLabel, entryLabel, entryDetail, entryPeople } from "./../state.js";
import { sync } from "./../sync.js";
import { navigate } from "./../router.js";

let host = null;
let context = null;

export default {
  title: "Stand-down",

  async mount(section) {
    host = section.querySelector("#standdown-body");
    await reload();
  },

  unmount() {
    host = null;
    context = null;
  },
};

/**
 * Every boat that went out today and what became of it.
 *
 * A boat counts as accounted for if, in the LAST race it was entered in, it
 * finished or carries a code. An abandoned race accounts for everyone in it:
 * nobody was left on the water by a race that did not happen.
 */
async function tally(raceDay) {
  const races = await rd.racesForDay(raceDay.id);
  const [boats, members, classes] = await Promise.all([
    db.getAll("boats"), db.getAll("helms"), db.getAll("classes"),
  ]);
  const boatById = new Map(boats.map((b) => [b.id, b]));
  const helmById = new Map(members.map((h) => [h.id, h]));
  const classById = new Map(classes.map((c) => [c.id, c]));

  const byBoat = new Map();

  for (const race of races) {
    const [entries, events] = await Promise.all([
      rd.entriesForRace(race.id),
      log.eventsForRace(race.id),
    ]);
    if (!entries.length) continue;

    const abandoned = events.some((e) => e.type === "race_abandoned");
    const plan = lapPlan(race, events);
    const startAt = race.start_at ? Date.parse(race.start_at) : null;

    for (const entry of entries) {
      const boat = boatState(entry, events, { plan, startAt });
      const state = abandoned
        ? { status: "abandoned", statusLabel: "race abandoned" }
        : boat.finished
          ? { status: "finished", statusLabel: "finished" }
          : boat.code
            ? { status: "coded", statusLabel: boat.code }
            : { status: "unaccounted", statusLabel: "not accounted for" };

      const parts = {
        boat: entry.boat_id ? boatById.get(entry.boat_id) ?? null : null,
        helm: helmById.get(entry.helm_id) ?? null,
        crew: entry.crew_id ? helmById.get(entry.crew_id) ?? null : null,
        klass: classById.get(entry.class_id) ?? null,
      };
      /* Keyed on the helm, not the hull: most boats here have no hull, and
         the helm is the identity that persists across a day. */
      byBoat.set(entry.helm_id, {
        parts,
        label: entryLabel(parts),
        detail: entryDetail(parts),
        people: entryPeople(parts),
        raceNumber: race.number,
        raceLabel: raceLabel(race),
        entryId: entry.id,
        raceId: race.id,
        ...state,
      });
    }
  }

  const rows = [...byBoat.values()].sort((a, b) => a.label.localeCompare(b.label));
  const unaccounted = rows.filter((r) => r.status === "unaccounted");
  return {
    rows,
    unaccounted,
    /* The tally is a headcount, not a boat count: an unaccounted
       double-hander is TWO people still unaccounted for. */
    peopleTotal: rows.reduce((n, r) => n + r.people.length, 0),
    peopleUnaccounted: unaccounted.reduce((n, r) => n + r.people.length, 0),
  };
}

async function load() {
  const raceDay = await rd.openRaceDay();
  if (!raceDay) return (context = null);

  const templates = await db.getAll("checklist_templates");
  const template = templates.find((t) => t.kind === "stand_down") ?? null;
  const runs = await db.getAllByIndex("checklist_runs", "by_race_day", raceDay.id);
  const run =
    runs.find((r) => r.kind === "stand_down") ??
    (template
      ? {
          id: db.newId(),
          race_day_id: raceDay.id,
          template_id: template.id,
          kind: "stand_down",
          responses: {},
          completed_at: null,
        }
      : null);

  context = { raceDay, template, run, tally: await tally(raceDay) };
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
      panel("No race day open", [
        el("div.panel-body", {}, [el("p.stub", { text: "Nothing to stand down from." })]),
        el("div.actions", {}, [
          el("button.btn", { type: "button", text: "Race day setup", onclick: () => navigate("setup") }),
        ]),
      ])
    );
    return;
  }

  const node = el("div");
  if (rd.isTestDay(context.raceDay)) {
    node.append(notice("TEST DATA — this day was run in a dev mode. Nothing recorded on it counts.", "error"));
  }
  node.append(tallyPanel());
  if (context.template) node.append(checklistPanel());
  node.append(incidentPanel());
  node.append(completePanel());
  clear(host).append(node);
}

/* ---- the tally check ---------------------------------------------------- */

function tallyPanel() {
  const { rows, unaccounted, peopleTotal, peopleUnaccounted } = context.tally;
  const list = el("div.reglist");

  for (const row of rows) {
    list.append(
      el(`div.regrow.tally-${row.status}`, {}, [
        el("div.regmain", {}, [
          el("div.regname", { text: row.label }),
          el("div.regmeta", {
            /* entryDetail already names everyone aboard whenever a hull took
               the first line; only add them when it did not, so an unaccounted
               crew is always named without the line saying it twice. */
            text: [row.detail || row.people.map((p) => p.name).join(" + "), row.raceLabel]
              .filter(Boolean)
              .join(" · "),
          }),
        ]),
        el("span.tallymark", { text: row.status === "unaccounted" ? "UNACCOUNTED" : row.statusLabel }),
      ])
    );
  }

  if (!rows.length) {
    list.append(el("div.empty", {}, [el("p", { text: "No boats signed on today." })]));
  }

  const children = [list];
  if (unaccounted.length) {
    children.unshift(
      el("div.panel-body", {}, [
        notice(
          `${peopleUnaccounted} ${peopleUnaccounted === 1 ? "person is" : "people are"} not accounted for, in ${unaccounted.length} boat${unaccounted.length === 1 ? "" : "s"}. Find them, then record what happened — a code (RET, DNF) is how a boat stops racing.`,
          "error"
        ),
        el("div.actions", { style: "padding:0" }, [
          el("button.btn.ghost", {
            type: "button",
            text: "Back to the race",
            onclick: () => navigate("live"),
          }),
        ]),
      ])
    );
  }

  return panel("Tally check", children, {
    count: `${peopleTotal - peopleUnaccounted}/${peopleTotal} people`,
  });
}

/* ---- stand-down checklist ---------------------------------------------- */

function checklistPanel() {
  const { template, run } = context;
  const items = Array.isArray(template.items) ? template.items : [];
  const done = items.filter((item) => run.responses[item.id]?.done).length;
  const list = el("div.checklist");

  for (const item of items) {
    const checked = Boolean(run.responses[item.id]?.done);
    list.append(
      el("label.checkrow", { for: `sd-${item.id}`, class: checked ? "on" : "" }, [
        el("input", {
          type: "checkbox",
          id: `sd-${item.id}`,
          checked,
          onchange: async (event) => {
            run.responses = {
              ...run.responses,
              [item.id]: { done: event.target.checked, at: db.nowIso() },
            };
            await db.localWrite("checklist_runs", { ...run });
            await reload();
          },
        }),
        el("span.checklabel", { text: item.label }),
        el("span.checkat", {
          text: checked ? new Date(run.responses[item.id].at).toTimeString().slice(0, 5) : "",
        }),
      ])
    );
  }

  return panel("Stand-down", [list], { count: `${done}/${items.length}` });
}

function incidentPanel() {
  const { run } = context;
  const box = el("textarea.csvbox", {
    rows: 4,
    placeholder: "Anything that went wrong, nearly went wrong, or needs reporting.",
    "aria-label": "Incident note",
    value: run?.responses?.__incident?.note ?? "",
    onchange: async (event) => {
      if (!run) return;
      run.responses = {
        ...run.responses,
        __incident: { done: true, at: db.nowIso(), note: event.target.value },
      };
      await db.localWrite("checklist_runs", { ...run });
    },
  });

  return panel("Incidents", [
    el("div.panel-body", {}, [
      el("p.stub", { text: "Feeds the club's safety review. Leave blank if there is nothing to say." }),
      box,
    ]),
  ]);
}

/* ---- closing the day ---------------------------------------------------- */

function completePanel() {
  const { unaccounted } = context.tally;
  const blocked = unaccounted.length > 0;
  const pending = sync.status.pending + (sync.status.blocked || 0);

  const body = el("div.panel-body");
  if (blocked) {
    body.append(
      el("p.stub", {
        text: "The day cannot be closed while a boat is unaccounted for. That is the point of the check.",
      })
    );
  } else if (pending) {
    body.append(
      notice(
        `${pending} record${pending === 1 ? "" : "s"} ${pending === 1 ? "has" : "have"} not reached the club database yet. Closing is fine — they will go up as soon as there is signal — but do not clear this phone's data until the sync indicator says everything is synced.`,
        "error"
      )
    );
  } else {
    body.append(el("p.stub", { text: "Everything is recorded and synced. Safe to close." }));
  }

  const complete = el("button.btn", {
    type: "button",
    text: "Close the race day",
    onclick: async () => {
      complete.disabled = true;
      complete.textContent = "Closing…";
      await closeDay();
    },
  });

  const why = blocked
    ? `${unaccounted.length} boat${unaccounted.length === 1 ? "" : "s"} still unaccounted for — every boat must be ashore or coded before the day can be closed.`
    : null;

  return panel("Finish", [body, actionWithReason(complete, why)]);
}

async function closeDay() {
  const { raceDay, run } = context;

  if (run) {
    await db.localWrite("checklist_runs", { ...run, completed_at: db.nowIso() });
  }
  await db.localWrite("race_days", { ...raceDay, status: "complete" });

  // One last push before the phone goes in a pocket for a week.
  await sync.flush();
  await sync.refreshStatus();

  /* Deliberately NOT reload(): the day is closed, so openRaceDay() finds
     nothing and the page would render "no race day open" — which is both
     confusing and silent about anything still waiting to sync. That warning
     is the most important thing on the screen at this moment. */
  const outstanding = sync.status.pending + (sync.status.blocked || 0);

  clear(host).append(
    panel("Race day closed", [
      el("div.panel-body", {}, [
        outstanding
          ? notice(
              `${outstanding} record${outstanding === 1 ? "" : "s"} ${outstanding === 1 ? "is" : "are"} still only on this phone. Do not clear the app's data, and open it again somewhere with signal — the sync indicator will say "Synced" once they are safe.`,
              "error"
            )
          : el("p.stub", { text: "Closed, and everything is in the club database." }),
      ]),
      el("div.actions", {}, [
        el("button.btn", {
          type: "button",
          text: "Start a new race day",
          onclick: () => navigate("setup"),
        }),
      ]),
    ])
  );

  context = null;
}
