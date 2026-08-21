/* Step 2 — the pre-race checklist.
 *
 * Template-driven, so the committee can change the wording in Supabase
 * without anyone touching the app. Each toggle is stamped with the time it was
 * tapped, and the run is saved on every tap rather than at the end — a phone
 * that dies halfway still shows what had been checked.
 *
 * Proceeding with an incomplete list is allowed. The OOD is in charge; the
 * record simply says it was incomplete, and stays honest about it.
 */

import { el, clear, panel, notice } from "./../ui.js";
import * as db from "./../db.js";
import * as rd from "./../raceday.js";
import { navigate } from "./../router.js";

let host = null;

export default {
  title: "Pre-race checklist",

  mount(section) {
    host = section.querySelector("#checklist-body");
    render();
  },

  unmount() {
    host = null;
  },
};

async function loadRun(raceDay, template) {
  const runs = await db.getAllByIndex("checklist_runs", "by_race_day", raceDay.id);
  const existing = runs.find((r) => r.kind === template.kind);
  if (existing) return existing;
  return {
    id: db.newId(),
    race_day_id: raceDay.id,
    template_id: template.id,
    kind: template.kind,
    responses: {},
    completed_at: null,
  };
}

async function render() {
  if (!host) return;

  const raceDay = await rd.openRaceDay();
  if (!raceDay) {
    clear(host).append(needSetup());
    return;
  }

  const race = await rd.currentRace(raceDay.id);
  const templates = await db.getAll("checklist_templates");
  const template = templates.find((t) => t.kind === "pre_race");

  if (!template) {
    clear(host).append(
      panel("No checklist yet", [
        el("div.panel-body", {}, [
          el("p.stub", {
            text:
              "The pre-race checklist has not reached this phone. It arrives with the reference data once there is signal — you can carry on without it.",
          }),
        ]),
        el("div.actions", {}, [
          el("button.btn.go", { type: "button", text: "Start sequence →", onclick: () => navigate("sequence") }),
        ]),
      ])
    );
    return;
  }

  const run = await loadRun(raceDay, template);
  const items = Array.isArray(template.items) ? template.items : [];
  const done = items.filter((item) => run.responses[item.id]?.done).length;
  const complete = done === items.length;

  const list = el("div.checklist");
  for (const item of items) {
    list.append(checklistItem(item, run));
  }

  const proceed = el("button.btn", {
    type: "button",
    text: complete ? "Start sequence →" : "Proceed anyway →",
    class: complete ? "" : "warn",
    onclick: async () => {
      await save(run, { completed_at: db.nowIso() });
      if (race) await rd.setRaceStatusIfEarlier(race, "prestart");
      navigate("sequence");
    },
  });

  const children = [
    el("div.panel-body", {}, [
      el("div.checkcount", { text: `${done} of ${items.length} checked` }),
      complete
        ? null
        : el("p.stub", {
            text: "You can go ahead with items unchecked — the record will show which.",
          }),
    ]),
    list,
    el("div.actions", {}, [proceed]),
  ];

  clear(host).append(panel("Step 2 · Before racing", children, { count: `${done}/${items.length}` }));
}

function checklistItem(item, run) {
  const response = run.responses[item.id];
  const checked = Boolean(response?.done);

  const box = el("input", {
    type: "checkbox",
    checked,
    id: `chk-${item.id}`,
    onchange: async (event) => {
      const on = event.target.checked;
      run.responses = {
        ...run.responses,
        [item.id]: on ? { done: true, at: db.nowIso() } : { done: false, at: db.nowIso() },
      };
      await save(run);
      await render();
    },
  });

  return el("label.checkrow", { for: `chk-${item.id}`, class: checked ? "on" : "" }, [
    box,
    el("span.checklabel", { text: item.label }),
    el("span.checkat", {
      text: checked && response?.at ? new Date(response.at).toTimeString().slice(0, 5) : "",
    }),
  ]);
}

async function save(run, extra = {}) {
  const row = { ...run, ...extra };
  Object.assign(run, row);
  await db.localWrite("checklist_runs", row);
}

function needSetup() {
  return panel("No race day open", [
    el("div.panel-body", {}, [el("p.stub", { text: "Set the day up first." })]),
    el("div.actions", {}, [
      el("button.btn", { type: "button", text: "Race day setup", onclick: () => navigate("setup") }),
    ]),
  ]);
}
