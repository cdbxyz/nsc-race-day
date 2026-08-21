/* Step 0 — race day setup.
 *
 * The first thing an OOD does. Everything here is optional except the date and
 * their own name, because the point is to get to sign-on quickly, not to fill
 * in a form. Creating the day also creates the planned races, so sign-on has
 * somewhere to put entries.
 */

import {
  el, clear, field, selectField, panel, notice, datalist, pickerField,
} from "./../ui.js";
import { raceLabel } from "./../state.js";
import * as cal from "./../calendar.js";
import * as rd from "./../raceday.js";
import * as device from "./../device.js";
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
  /* The duty trio: the OOD runs the race; RO1 and RO2 crew the rescue boat.
     They are "Rescue" officers, never "Race" officers. */
  const ro1 = field("Rescue Officer 1 (RO1)", {
    class: "text", list: suggestionsId, autocomplete: "off", placeholder: "Rescue boat crew",
  });
  const ro2 = field("Rescue Officer 2 (RO2)", {
    class: "text", list: suggestionsId, autocomplete: "off", placeholder: "Rescue boat crew",
  });
  /* Which phone this is, as the OTHER phone will see it if it ever has to
     take the day over. Auto-suggested from the OOD's name — they have just
     typed it, so the useful half of the label is already on screen — but
     always editable, because a club phone is not anybody's phone. */
  const phone = field("This phone", {
    class: "text",
    autocomplete: "off",
    placeholder: device.defaultDeviceName(),
  });
  device.deviceName().then(async (existing) => {
    if (await device.isNamed()) phone.input.value = existing;
  });
  let phoneEdited = false;
  phone.input.addEventListener("input", () => { phoneEdited = true; });
  ood.input.addEventListener("input", async () => {
    if (phoneEdited || (await device.isNamed())) return;
    phone.input.value = device.suggestDeviceName(ood.input.value);
  });

  // One race by default: most days are one, and adding another is a tap.
  const races = field("Races planned", { type: "number", min: 1, max: 10, value: 1, inputMode: "numeric" });
  /* The race name comes off the season programme rather than out of someone's
     memory: a trophy spelled three ways across three years is a trophy nobody
     can search for. Free text is still allowed — the programme is a draft —
     but it is the second option, not the first. */
  const programme = await cal.listCalendar();

  let chosenName = "";
  let chosenPursuit = false;

  /* v1 scores handicap starts only. A pursuit race is a different format
     altogether, so we say so plainly and point at the club's calculator. */
  const pursuitNote = el("div", { hidden: true });
  function paintPursuit() {
    clear(pursuitNote);
    pursuitNote.hidden = !chosenPursuit;
    if (!chosenPursuit) return;
    const n = notice("", "error");
    n.append(
      el("span", {
        text: `${chosenName} is a PURSUIT race. This app scores handicap starts only — use the club calculator: `,
      }),
      el("a.linkish.pursuitlink", {
        href: cal.PURSUIT_CALCULATOR_URL,
        target: "_blank",
        rel: "noopener",
        text: "nsc-race-calc",
      })
    );
    pursuitNote.append(n);
  }

  const namePicker = pickerField("Race name (optional)", {
    placeholder: "Choose from the programme…",
    items: programme.map((r) => ({
      label: r.name,
      detail: `${r.date} · ${cal.shortTime(r.start_time)}${r.is_pursuit ? " · PURSUIT" : ""}`,
      row: r,
    })),
    addLabel: "Use a name not on the programme…",
    onPick: (item) => {
      chosenName = item.row.name;
      chosenPursuit = !!item.row.is_pursuit;
      namePicker.set(chosenName);
      paintPursuit();
    },
    onAddNew: (text) => {
      chosenName = text;
      chosenPursuit = false;
      namePicker.set(chosenName || null);
      paintPursuit();
    },
  });

  /* The programme entry for the chosen date is the overwhelmingly likely
     answer, so it is preselected — but shown, not hidden, so a wrong guess is
     obvious. Two races share 8 and 11 August, and on those days we name both
     and preselect neither: guessing which one is being sailed first would be
     worse than asking. */
  const dayNote = el("div", { hidden: true });
  async function paintDay() {
    const races = await cal.racesOn(date.input.value);
    clear(dayNote);
    dayNote.hidden = races.length === 0;
    if (races.length) {
      dayNote.append(
        notice(
          `Programme: ${races
            .map((r) => `${r.name} ${cal.shortTime(r.start_time)}`)
            .join(" · ")}`,
          "info"
        )
      );
    }
    if (races.length === 1) {
      chosenName = races[0].name;
      chosenPursuit = !!races[0].is_pursuit;
      namePicker.set(chosenName);
      paintPursuit();
    }
  }
  date.input.addEventListener("change", () => paintDay());

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

  const start = el("button.btn.go", {
    type: "button",
    text: "Start race day",
    onclick: async () => {
      // Only the errors this button put there — not the programme or
      // pursuit notices, which are part of the form.
      body.querySelectorAll(":scope > .notice").forEach((n) => n.remove());
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
        // Named before the day is created, so the claim carries the name.
        await device.setDeviceName(phone.input.value);
        await rd.createRaceDay({
          date: date.input.value,
          oodName: ood.input.value,
          ro1Name: ro1.input.value,
          ro2Name: ro2.input.value,
          raceName: chosenName,
          isPursuit: chosenPursuit,
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
    dayNote,
    date.node,
    ood.node,
    ro1.node,
    ro2.node,
    seriesPick.node,
    newSeriesBlock,
    races.node,
    namePicker.node,
    phone.node,
    pursuitNote
  );

  clear(host).append(
    panel("Step 0 · Race day", [body, el("div.actions", {}, [start])]),
    registersLink()
  );
  await paintDay();
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
    placeholder: "e.g. Whitaker Cup",
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
          el("div.regname", { text: day.date }),
          el("div.regmeta", { text: dutyLine(day) }),
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
    placeholder: "e.g. Whitaker Cup",
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

/** "OOD Chris · RO1 Sam · RO2 Alex" — compact form, names omitted if unset. */
export function dutyLine(day) {
  return [
    day?.ood_name ? `OOD ${day.ood_name}` : null,
    day?.ro1_name ? `RO1 ${day.ro1_name}` : null,
    day?.ro2_name ? `RO2 ${day.ro2_name}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** v1 scores handicap races only — say so before the day, not on the water. */
export function pursuitWarning() {
  const box = notice(
    "Pursuit start — this app cannot run one. Use the club's pursuit calculator on the day.",
    "error"
  );
  box.append(
    el("div", {}, [
      el("a.pursuitlink", {
        href: cal.PURSUIT_CALCULATOR_URL,
        target: "_blank",
        rel: "noopener",
        text: "cdbxyz.github.io/nsc-race-calc",
      }),
    ])
  );
  return box;
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
