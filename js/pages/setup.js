/* Step 0 — race day setup.
 *
 * The first thing an OOD does. Everything here is optional except the date and
 * their own name, because the point is to get to sign-on quickly, not to fill
 * in a form. Creating the day also creates the planned races, so sign-on has
 * somewhere to put entries.
 */

import { el, clear, field, selectField, panel, notice, datalist } from "./../ui.js";
import { raceLabel } from "./../state.js";
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
  // One race by default: most days are one, and adding another is a tap.
  const races = field("Races planned", { type: "number", min: 1, max: 10, value: 1, inputMode: "numeric" });
  const raceName = field("Race name (optional)", {
    class: "text",
    autocomplete: "off",
    placeholder: "e.g. Whittaker Cup",
  });

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
          raceName: raceName.input.value,
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
    races.node,
    raceName.node
  );

  clear(host).append(
    panel("Step 0 · Race day", [body, el("div.actions", {}, [start])]),
    registersLink()
  );
}

async function alreadyOpenPanel(day) {
  const races = await rd.racesForDay(day.id);

  const list = el("div.reglist");
  for (const race of races) {
    list.append(
      el("div.regrow", {}, [
        el("div.regmain", {}, [
          el("div.regname", { text: raceLabel(race) }),
          el("div.regmeta", { text: race.status }),
        ]),
        race.status === "published"
          ? null
          : el("button.kill", {
              type: "button",
              text: race.name ? "Rename" : "Name",
              onclick: () => renameRace(race),
            }),
      ])
    );
  }

  const addName = field("Name (optional)", {
    class: "text",
    autocomplete: "off",
    placeholder: "e.g. Whittaker Cup",
  });

  const add = el("button.btn.ghost", {
    type: "button",
    text: "+ Add race",
    onclick: async () => {
      add.disabled = true;
      await rd.addRace(day, { name: addName.input.value });
      await render();
    },
  });

  return el("div", {}, [
    panel(
      "Race day in progress",
      [
        el("div.panel-body", {}, [
          el("div.regname", { text: `${day.date} · OOD ${day.ood_name}` }),
          el("p.stub", { text: "A day stays open until stand-down. Carry on where you left off." }),
        ]),
        list,
        el("div.panel-body", {}, [addName.node]),
        el("div.actions", {}, [
          el("button.btn", { type: "button", text: "Go to sign-on", onclick: () => navigate("signon") }),
          add,
        ]),
      ],
      { count: `${races.length}` }
    ),
    registersLink(),
  ]);
}

/** Inline rename, so a trophy race can be labelled whenever someone says so. */
function renameRace(race) {
  const body = el("div.panel-body.subform");
  const name = field("Race name", {
    class: "text",
    autocomplete: "off",
    value: race.name ?? "",
    placeholder: "e.g. Whittaker Cup",
  });
  body.append(
    name.node,
    el("div.actions", {}, [
      el("button.btn", {
        type: "button",
        text: "Save name",
        onclick: async () => {
          await rd.setRaceName(race, name.input.value);
          await render();
        },
      }),
      el("button.btn.ghost", { type: "button", text: "Cancel", onclick: () => render() }),
    ])
  );
  clear(host).append(panel(raceLabel(race), [body]));
  name.input.focus();
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
