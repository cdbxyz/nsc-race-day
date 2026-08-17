/* Step 1 — sign-on.
 *
 * This list is the day's tally record: the stand-down check at the end is
 * generated from it, so a boat missing here is a boat nobody will look for.
 * It has to be fast to use with wet hands and possible without signal.
 *
 * Every entry snapshots the PY, factor and fleet at the moment it is created.
 * Nothing here is recomputed later, so a published result never shifts.
 */

import {
  el, clear, field, selectField, panel, notice, armedButton, onArmChange, pickerField,
  actionWithReason, readOnlyBanner,
} from "./../ui.js";
import * as db from "./../db.js";
import * as rd from "./../raceday.js";
import * as reg from "./../registers.js";
import { factorFor } from "./../handicap.js";
import { raceLabel, entryLabel, entryDetail } from "./../state.js";
import { dutyLine } from "./setup.js";
import * as device from "./../device.js";
import { navigate } from "./../router.js";

let host = null;
let offArm = null;
let search = "";
let showAddBoat = false;

export default {
  title: "Sign-on",

  mount(section) {
    host = section.querySelector("#signon-body");
    offArm = onArmChange(render);
    render();
  },

  unmount() {
    offArm?.();
    offArm = null;
    host = null;
    search = "";
    showAddBoat = false;
  },
};

/** Everything the page needs, read once per render. */
async function load() {
  const raceDay = await rd.openRaceDay();
  if (!raceDay) return null;

  const race = await rd.currentRace(raceDay.id);
  if (!race) return null;

  const series = race.series_id ? await db.get("series", race.series_id) : null;
  const season = rd.seasonForRace({ ...race, race_date: raceDay.date }, series);
  const context = await rd.handicapContext(season);

  const [entries, boats, members, classes, combinations] = await Promise.all([
    rd.entriesForRace(race.id),
    reg.listBoats(),
    reg.listMembers(),
    reg.listClasses(),
    rd.recentCombinations(),
  ]);

  return {
    raceDay,
    race,
    series,
    season,
    context,
    entries,
    boats,
    members,
    helms: members,
    classes,
    combinations,
    boatById: new Map(boats.map((b) => [b.id, b])),
    helmById: new Map(members.map((h) => [h.id, h])),
    classById: new Map(classes.map((c) => [c.id, c])),
    claim: await device.claimState(raceDay),
  };
}

async function render() {
  if (!host) return;
  const data = await load();

  if (!data) {
    clear(host).append(
      panel("No race day open", [
        el("div.panel-body", {}, [
          el("p.stub", { text: "Set the day up first — that is what creates the races." }),
        ]),
        el("div.actions", {}, [
          el("button.btn", { type: "button", text: "Race day setup", onclick: () => navigate("setup") }),
        ]),
      ])
    );
    return;
  }

  const node = el("div");
  node.append(headerPanel(data));

  /* Sign-on writes entries, so a second phone must not be able to add a boat
     the running phone will also add. The list itself stays fully visible. */
  if (!data.claim.canRecord) {
    node.append(
      readOnlyBanner({
        byName: data.claim.byName,
        claimedAt: data.claim.claimedAt,
        myName: data.claim.myName,
        onTakeOver: async (name) => {
          await device.setDeviceName(name);
          await device.claimRaceDay(data.raceDay);
          await render();
        },
      })
    );
    node.append(entriesPanel(data));
    clear(host).append(node);
    return;
  }

  const carry = await carryForwardPanel(data);
  if (carry) node.append(carry);
  node.append(searchPanel(data));
  node.append(entriesPanel(data));
  clear(host).append(node);

}

function headerPanel(data) {
  const { raceDay, race, series } = data;
  return el("div.raceline", {}, [
    el("div.raceline-main", {}, [
      el("div.eyebrow", { text: `${raceDay.date} · ${dutyLine(raceDay)}` }),
      el("div.raceline-title", { text: raceLabel(race) }),
      el("div.regmeta", {
        text: [
          series ? `${series.name} ${series.season}` : `Season ${data.season}`,
          `${race.fast_laps} laps fast · ${race.slow_laps} slow`,
        ].join(" · "),
      }),
    ]),
  ]);
}

/* ---- carry forward ------------------------------------------------------ */

async function carryForwardPanel(data) {
  const candidates = await rd.carryForwardCandidates(data.race, data.context);
  if (!candidates.length) return null;

  const chosen = new Set(candidates.map((c) => c.helmId));
  const list = el("div.reglist");

  for (const candidate of candidates) {
    const helm = data.helmById.get(candidate.helmId);
    const crew = candidate.crewId ? data.helmById.get(candidate.crewId) : null;
    const parts = { boat: candidate.boat, helm, crew, klass: candidate.klass };
    const toggle = el("input", {
      type: "checkbox",
      checked: true,
      onchange: (event) => {
        if (event.target.checked) chosen.add(candidate.helmId);
        else chosen.delete(candidate.helmId);
      },
    });
    list.append(
      el("label.regrow.pickable", {}, [
        toggle,
        el("div.regmain", {}, [
          el("div.regname", { text: entryLabel(parts) }),
          el("div.regmeta", {
            text: [entryDetail(parts), describeFactor(candidate.snapshot, candidate.wins)]
              .filter(Boolean)
              .join(" · "),
          }),
        ]),
      ])
    );
  }

  const bring = el("button.btn", {
    type: "button",
    text: "Bring these forward",
    onclick: async () => {
      bring.disabled = true;
      for (const candidate of candidates) {
        if (!chosen.has(candidate.helmId)) continue;
        try {
          await rd.addEntry({
            race: data.race,
            klass: candidate.klass,
            helmId: candidate.helmId,
            crewId: candidate.crewId,
            boat: candidate.boat,
            context: data.context,
          });
        } catch (err) {
          console.warn("carry forward skipped", err.message);
        }
      }
      await render();
    },
  });

  return panel(
    `Carried forward from Race ${data.race.number - 1}`,
    [
      el("div.panel-body", {}, [
        el("p.stub", {
          text: "Untick anyone who has gone home. Handicaps are recalculated, so a winner from the last race comes forward on a lower PY.",
        }),
      ]),
      list,
      el("div.actions", {}, [bring]),
    ],
    { count: `${candidates.length}` }
  );
}

/* ---- search and add ----------------------------------------------------- */

/* ---- combinations ------------------------------------------------------ */

/**
 * Sign-on is combination-first: the club races pairings, not hulls. Recent
 * combinations are one tap; anything new goes through the manual path below.
 */
function searchPanel(data) {
  const body = el("div.panel-body");

  const box = el("input.searchbox", {
    type: "search",
    value: search,
    placeholder: "Search helm, crew or class…",
    "aria-label": "Search combinations",
    autocomplete: "off",
    oninput: (event) => {
      search = event.target.value;
      renderMatches();
    },
  });
  const matches = el("div.reglist");
  body.append(box, matches);

  const signedOnHelms = new Set(data.entries.map((e) => e.helm_id));

  function renderMatches() {
    clear(matches);
    const needle = search.trim().toLowerCase();

    const rows = data.combinations
      .map((combo) => {
        const helm = data.helmById.get(combo.helmId) ?? null;
        const crew = combo.crewId ? data.helmById.get(combo.crewId) ?? null : null;
        const klass = data.classById.get(combo.classId) ?? null;
        const boat = combo.boatId ? data.boatById.get(combo.boatId) ?? null : null;
        return { combo, helm, crew, klass, boat };
      })
      .filter((row) => row.helm && row.klass)
      .filter((row) => !signedOnHelms.has(row.combo.helmId))
      .filter((row) => {
        if (!needle) return true;
        // Helm OR crew OR class, because any of the three is how someone
        // would think to look for a combination.
        return [row.helm?.name, row.crew?.name, row.klass?.name, row.boat?.name]
          .filter(Boolean)
          .some((text) => text.toLowerCase().includes(needle));
      })
      .slice(0, 12);

    if (!rows.length) {
      matches.append(
        el("div.empty", {}, [
          el("p", {
            text: needle
              ? `Nothing matching “${search}”. Use “New combination” below.`
              : data.combinations.length
                ? "Everyone who has raced before is signed on."
                : "No combinations yet — use “New combination” below.",
          }),
        ])
      );
      return;
    }

    for (const row of rows) {
      matches.append(
        el("button.regrow.tappable", {
          type: "button",
          onclick: () => signOnCombination(data, row, body),
        }, [
          el("div.regmain", {}, [
            el("div.regname", { text: entryLabel(row) }),
            el("div.regmeta", { text: entryDetail(row) || row.klass.name }),
          ]),
          el("span.addmark", { text: "+", "aria-hidden": "true" }),
        ])
      );
    }
  }

  renderMatches();

  const addNew = el("button.btn.ghost", {
    type: "button",
    text: showAddBoat ? "Cancel" : "New combination",
    onclick: () => {
      showAddBoat = !showAddBoat;
      render();
    },
  });

  const children = [body, el("div.actions", {}, [addNew])];
  if (showAddBoat) children.splice(1, 0, newCombinationForm(data));

  return panel("Add a boat", children, { count: `${data.entries.length} signed on` });
}

async function signOnCombination(data, row, container) {
  container.querySelectorAll(".notice").forEach((n) => n.remove());
  try {
    await rd.addEntry({
      race: data.race,
      klass: row.klass,
      helmId: row.combo.helmId,
      crewId: row.combo.crewId,
      boat: row.boat,
      context: data.context,
    });
    search = "";
    await render();
  } catch (err) {
    container.prepend(notice(err.message, "error"));
  }
}

/**
 * A combination nobody has sailed here before: pick the class, name the helm,
 * and name the crew if the class carries one. Everyone comes from the same
 * members register — a person helms one week and crews the next.
 */
/* Every register entity here is CHOSEN, not typed.
 *
 * A free-text box with a datalist looks the same and behaves nothing like it:
 * the phone keyboard offers its own autofill above the browser's suggestions,
 * a thumb takes the wrong one, and "Hamish Fowler" enters the register a
 * second time as "hamish" or as somebody's email address. Every duplicate is a
 * split handicap history, which is the one thing this app must not get wrong.
 *
 * So each of class, helm, crew and hull is a picker: filter-as-you-type over
 * what already exists, with adding something new as a deliberate, separate tap.
 */
function newCombinationForm(data) {
  const body = el("div.panel-body.subform");

  const classLabel = (c) =>
    `${c.name} · ${c.base_py}${(c.crew_size ?? 1) === 2 ? " · 2 up" : ""}`;

  let classId = null;
  let helmId = null;
  let crewId = null;
  let boatId = null;
  let newHelmName = "";
  let newCrewName = "";

  const newClassName = field("Class name", { class: "text", autocomplete: "off" });
  const newClassPy = field("Base PY", { inputMode: "numeric", autocomplete: "off" });
  const newClassCrew = selectField("Crew", [
    { value: "1", label: "Single-handed" },
    { value: "2", label: "Double-handed" },
  ]);
  const newClassBlock = el("div.subform", { hidden: true }, [
    newClassName.node, newClassPy.node, newClassCrew.node,
  ]);

  const classPick = pickerField("Class", {
    placeholder: "Choose a class…",
    items: data.classes.map((c) => ({ label: c.name, detail: classLabel(c), row: c })),
    addLabel: "New class…",
    onPick: (item) => {
      classId = item.row.id;
      newClassBlock.hidden = true;
      classPick.set(classLabel(item.row));
      syncForClass();
    },
    onAddNew: (text) => {
      classId = null;
      newClassBlock.hidden = false;
      newClassName.input.value = text;
      classPick.set("New class…");
      syncForClass();
    },
  });

  const helmPick = pickerField("Helm", {
    placeholder: "Choose a helm…",
    items: data.members.map((m) => ({ label: m.name, row: m })),
    addLabel: "Add a new member…",
    onPick: (item) => {
      helmId = item.row.id;
      newHelmName = "";
      helmPick.set(item.row.name);
    },
    onAddNew: (text) => {
      helmId = null;
      newHelmName = text;
      helmPick.set(text ? `${text} — new member` : null);
    },
  });

  const crewPick = pickerField("Crew (optional)", {
    placeholder: "Sailing solo",
    items: [
      { label: "— sailing solo —", row: null },
      ...data.members.map((m) => ({ label: m.name, row: m })),
    ],
    addLabel: "Add a new member…",
    onPick: (item) => {
      crewId = item.row?.id ?? null;
      newCrewName = "";
      crewPick.set(item.row?.name ?? null);
    },
    onAddNew: (text) => {
      crewId = null;
      newCrewName = text;
      crewPick.set(text ? `${text} — new member` : null);
    },
  });
  const crewBlock = el("div", { hidden: true }, [crewPick.node]);

  /* Hulls are optional and belong to a class, so the list narrows once a
     class is chosen — an OOD should not scroll past every Laser to find a
     Wayfarer's sail number. */
  const boatPick = pickerField("Sail number (optional)", {
    placeholder: "No hull recorded",
    items: [],
    addLabel: "New sail number…",
    onPick: (item) => {
      boatId = item.row?.id ?? null;
      newSail.input.value = "";
      newSailBlock.hidden = true;
      boatPick.set(item.row ? boatLabel(item.row) : null);
    },
    onAddNew: (text) => {
      boatId = null;
      newSailBlock.hidden = false;
      newSail.input.value = text;
      boatPick.set(text || "New sail number…");
    },
  });
  const newSail = field("Sail number", { class: "text", autocomplete: "off" });
  const newSailBlock = el("div.subform", { hidden: true }, [newSail.node]);

  const boatLabel = (b) => [b.sail_no, b.name].filter(Boolean).join(" · ") || "(unnamed hull)";

  /* The crew field appears only for a double-hander — but stays optional,
     because sailing a two-man boat single-handed is perfectly normal. */
  function syncForClass() {
    const chosen = classId ? data.classById.get(classId) : null;
    const crewSize = chosen ? Number(chosen.crew_size ?? 1) : Number(newClassCrew.select.value);
    crewBlock.hidden = crewSize !== 2;

    boatPick.setItems([
      { label: "— no hull —", row: null },
      ...data.boats
        .filter((b) => !classId || b.class_id === classId)
        .map((b) => ({ label: boatLabel(b), row: b })),
    ]);
  }
  newClassCrew.select.addEventListener("change", syncForClass);
  if (!data.classes.length) {
    newClassBlock.hidden = false;
    classPick.set("New class…");
  }
  syncForClass();

  const create = el("button.btn", {
    type: "button",
    text: "Sign on",
    onclick: async () => {
      body.querySelectorAll(":scope > .notice").forEach((n) => n.remove());
      create.disabled = true;
      try {
        let chosenClassId = classId;
        if (!chosenClassId) {
          const created = await reg.createClass({
            name: newClassName.input.value,
            basePy: newClassPy.input.value,
            crewSize: newClassCrew.select.value,
          });
          chosenClassId = created.id;
        }
        const klassRow = await db.get("classes", chosenClassId);

        // A new member is created only when one was explicitly asked for.
        const helm = helmId
          ? await db.get("helms", helmId)
          : await reg.createMember({ name: newHelmName });

        let crew = null;
        if (!crewBlock.hidden) {
          if (crewId) crew = await db.get("helms", crewId);
          else if (newCrewName.trim()) crew = await reg.createMember({ name: newCrewName });
        }

        // A hull is only recorded when there is one worth recording.
        let boat = null;
        if (boatId) boat = await db.get("boats", boatId);
        else if (newSail.input.value.trim()) {
          boat = await reg.createBoat({
            name: "",
            sailNo: newSail.input.value.trim(),
            classId: chosenClassId,
          });
        }

        await rd.addEntry({
          race: data.race,
          klass: klassRow,
          helmId: helm.id,
          crewId: crew?.id ?? null,
          boat,
          context: data.context,
        });
        showAddBoat = false;
        await render();
      } catch (err) {
        body.prepend(notice(err.message, "error"));
        create.disabled = false;
      }
    },
  });

  body.append(
    classPick.node, newClassBlock,
    helmPick.node, crewBlock,
    boatPick.node, newSailBlock,
    el("div.actions", {}, [create])
  );
  return body;
}

/* ---- the sign-on list --------------------------------------------------- */

function describeFactor(snapshot, wins) {
  const { base_py: base, handicap_factor: factor, personal_py: py } = snapshot;
  if (factor === 1) return `PY ${base}`;
  const winText = wins === 1 ? "1 win" : `${wins} wins`;
  return `${base} × ${factor} = ${Math.round(py)} (${winText})`;
}

function entriesPanel(data) {
  const list = el("div.entrylist");

  const partsFor = (entry) => ({
    boat: entry.boat_id ? data.boatById.get(entry.boat_id) ?? null : null,
    helm: data.helmById.get(entry.helm_id) ?? null,
    crew: entry.crew_id ? data.helmById.get(entry.crew_id) ?? null : null,
    klass: data.classById.get(entry.class_id) ?? null,
  });

  const sorted = [...data.entries].sort((a, b) =>
    entryLabel(partsFor(a)).localeCompare(entryLabel(partsFor(b)))
  );

  for (const entry of sorted) {
    list.append(entryCard(data, entry));
  }

  if (!sorted.length) {
    list.append(
      el("div.empty", {}, [el("p", { text: "Nobody signed on yet. Search above." })])
    );
  }

  const next = el("button.btn", {
    type: "button",
    text: "Pre-race checklist →",
    onclick: () => navigate("checklist"),
  });

  return panel(
    "Signed on",
    [
      list,
      actionWithReason(
        next,
        sorted.length ? null : "Sign at least one boat on before starting the checklist."
      ),
    ],
    { count: `${sorted.length}` }
  );
}

function entryCard(data, entry) {
  const parts = {
    boat: entry.boat_id ? data.boatById.get(entry.boat_id) ?? null : null,
    helm: data.helmById.get(entry.helm_id) ?? null,
    crew: entry.crew_id ? data.helmById.get(entry.crew_id) ?? null : null,
    klass: data.classById.get(entry.class_id) ?? null,
  };
  const laps = rd.entryLaps(entry, data.race);
  const wins = rd.winsFor(entry.helm_id, data.context);

  /* "Laser 2000 · 1122 × 0.97 = 1088 (1 win) · Fast, 3 laps" — the people are
     already on the first line, so the summary does not repeat them. */
  const summary = [
    entryDetail(parts) || parts.klass?.name || "no class",
    describeFactor(entry, wins),
    `${entry.fleet === "fast" ? "Fast" : "Slow"}, ${laps} lap${laps === 1 ? "" : "s"}`,
  ].join(" · ");

  const detail = el("div.entrydetail", { hidden: true });

  const card = el("div.entrycard", {}, [
    el("div.entrymain", {}, [
      el("div.entryboat", { text: entryLabel(parts) }),
      el("div.entrysummary", { text: summary }),
    ]),
    el("button.kill.entrymore", {
      type: "button",
      text: "Edit",
      "aria-expanded": "false",
      onclick: (event) => {
        detail.hidden = !detail.hidden;
        event.currentTarget.setAttribute("aria-expanded", String(!detail.hidden));
        if (!detail.hidden && !detail.childElementCount) {
          detail.append(entryEditor(data, entry, wins, parts));
        }
      },
    }),
    detail,
  ]);

  return card;
}

function entryEditor(data, entry, wins, parts) {
  const wrap = el("div.editorgrid");

  const helmPick = selectField(
    "Helm",
    data.members.map((h) => ({ value: h.id, label: h.name })),
    { value: entry.helm_id }
  );
  helmPick.select.value = entry.helm_id;
  helmPick.select.addEventListener("change", async () => {
    await rd.setEntryHelm(entry.id, helmPick.select.value, data.context);
    await render();
  });

  /* Committee discretion. The chosen factor is stored on the entry, so a
     result sheet always explains the PY it was scored on. */
  const computed = factorFor(wins);
  const factorPick = selectField(
    "Handicap factor",
    [
      { value: "", label: `Automatic (${computed} · ${wins} win${wins === 1 ? "" : "s"})` },
      { value: "1", label: "1.00 — no adjustment" },
      { value: "0.97", label: "0.97" },
      { value: "0.96", label: "0.96" },
      { value: "0.95", label: "0.95" },
    ],
    { value: entry.handicap_factor === computed ? "" : String(entry.handicap_factor) }
  );
  factorPick.select.addEventListener("change", async () => {
    const chosen = factorPick.select.value;
    await rd.setEntryFactor(entry.id, chosen === "" ? computed : Number(chosen));
    await render();
  });

  const lapsBox = field("Laps for this boat", {
    type: "number",
    min: 0,
    max: 20,
    inputMode: "numeric",
    value: entry.laps_override ?? "",
    placeholder: String(rd.entryLaps({ ...entry, laps_override: null }, data.race)),
  });
  lapsBox.input.addEventListener("change", async () => {
    await rd.setEntryLaps(entry.id, lapsBox.input.value);
    await render();
  });

  /* Crew only for a double-hander, and always optional: a two-man boat
     sailed solo is normal, and the handicap does not care either way. */
  if ((parts.klass?.crew_size ?? 1) === 2) {
    const crewPick = selectField(
      "Crew",
      [
        { value: "", label: "— sailing solo —" },
        ...data.members
          .filter((m) => m.id !== entry.helm_id)
          .map((m) => ({ value: m.id, label: m.name })),
      ],
      { value: entry.crew_id ?? "" }
    );
    crewPick.select.value = entry.crew_id ?? "";
    crewPick.select.addEventListener("change", async () => {
      await rd.setEntryCrew(entry.id, crewPick.select.value || null);
      await render();
    });
    wrap.append(crewPick.node);
  }

  wrap.append(helmPick.node, factorPick.node, lapsBox.node);

  /* Removal disappears once the race exists on the water: from then on the
     sign-on list is the tally record, and a boat that was there must stay
     visible. Codes are how a boat stops racing after that. */
  if (rd.canRemoveEntries(data.race)) {
    const remove = armedButton(`signon.remove.${entry.id}`, {
      label: "Remove from sign-on",
      armedLabel: `Tap again to remove ${entryLabel(parts)}`,
      classes: "danger",
      onConfirm: async () => {
        await rd.removeEntry(entry.id, data.race);
        await render();
      },
    });
    wrap.append(el("div.actions", {}, [remove]));
  } else {
    wrap.append(
      el("p.stub", {
        text: "Racing has started, so boats stay on the list. Use a code (DNS, DNC or RET) instead.",
      })
    );
  }

  return wrap;
}
