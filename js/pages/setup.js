/* Step 0 — race day setup.
 *
 * The first thing an OOD does. Everything here is optional except the date and
 * their own name, because the point is to get to sign-on quickly, not to fill
 * in a form. Creating the day also creates the planned races, so sign-on has
 * somewhere to put entries.
 */

import { el, clear, field, selectField, panel, notice, datalist } from "./../ui.js";
import * as rd from "./../raceday.js";
import { navigate } from "./../router.js";

let host = null;

export default {
  title: "Race day setup",

  mount(section) {
    host = section.querySelector("#setup-body");
    render();
  },

  unmount() {
    host = null;
  },
};

function today() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

async function render() {
  if (!host) return;

  const open = await rd.openRaceDay();
  if (open) {
    clear(host).append(await alreadyOpenPanel(open));
    return;
  }

  const [names, series] = await Promise.all([rd.recentOfficerNames(), rd.listSeries()]);
  const body = el("div.panel-body");

  const suggestionsId = "officer-names";
  const date = field("Date", { type: "date", value: today() });
  const ood = field("Officer of the Day", { class: "text", list: suggestionsId, autocomplete: "off" });
  const ro1 = field("Race Officer 1", { class: "text", list: suggestionsId, autocomplete: "off" });
  const ro2 = field("Race Officer 2", { class: "text", list: suggestionsId, autocomplete: "off" });
  const races = field("Races planned", { type: "number", min: 1, max: 10, value: 2, inputMode: "numeric" });

  const seriesOptions = [
    { value: "", label: "— no series —" },
    ...series.map((s) => ({ value: s.id, label: `${s.name} ${s.season}` })),
    { value: "__new__", label: "+ New series…" },
  ];
  const seriesPick = selectField("Series", seriesOptions);

  const newSeriesName = field("Series name", { class: "text", autocomplete: "off" });
  const newSeriesSeason = field("Season", {
    type: "number",
    value: new Date().getFullYear(),
    inputMode: "numeric",
  });
  const newSeriesBlock = el("div.subform", { hidden: true }, [
    newSeriesName.node,
    newSeriesSeason.node,
  ]);
  seriesPick.select.addEventListener("change", () => {
    newSeriesBlock.hidden = seriesPick.select.value !== "__new__";
  });

  const start = el("button.btn", {
    type: "button",
    text: "Start race day",
    onclick: async () => {
      body.querySelectorAll(".notice").forEach((n) => n.remove());
      start.disabled = true;
      try {
        let seriesId = seriesPick.select.value || null;
        if (seriesId === "__new__") {
          const created = await rd.createSeries({
            name: newSeriesName.input.value,
            season: newSeriesSeason.input.value,
          });
          seriesId = created.id;
        }
        await rd.createRaceDay({
          date: date.input.value,
          oodName: ood.input.value,
          ro1Name: ro1.input.value,
          ro2Name: ro2.input.value,
          seriesId,
          raceCount: races.input.value,
        });
        navigate("signon");
      } catch (err) {
        body.prepend(notice(err.message, "error"));
        start.disabled = false;
      }
    },
  });

  body.append(
    datalist(suggestionsId, names),
    date.node,
    ood.node,
    ro1.node,
    ro2.node,
    seriesPick.node,
    newSeriesBlock,
    races.node
  );

  clear(host).append(
    panel("Step 0 · Race day", [body, el("div.actions", {}, [start])]),
    registersLink()
  );
}

async function alreadyOpenPanel(day) {
  const races = await rd.racesForDay(day.id);
  const sailed = races.filter((r) => r.status !== "setup").length;

  return el("div", {}, [
    panel("Race day in progress", [
      el("div.panel-body", {}, [
        el("div.regname", { text: `${day.date} · OOD ${day.ood_name}` }),
        el("div.regmeta", {
          text: `${races.length} race${races.length === 1 ? "" : "s"} planned, ${sailed} under way or done`,
        }),
        el("p.stub", {
          text: "A day stays open until stand-down. Carry on where you left off.",
        }),
      ]),
      el("div.actions", {}, [
        el("button.btn", { type: "button", text: "Go to sign-on", onclick: () => navigate("signon") }),
      ]),
    ]),
    registersLink(),
  ]);
}

function registersLink() {
  return panel("Registers", [
    el("div.panel-body", {}, [
      el("p.stub", { text: "Boats, helms and classes. Also creatable from sign-on." }),
    ]),
    el("div.actions", {}, [
      el("button.btn.ghost", {
        type: "button",
        text: "Open registers",
        onclick: () => navigate("registers"),
      }),
    ]),
  ]);
}
