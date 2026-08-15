/* Step 1 — sign-on.
 *
 * This list is the day's tally record: the stand-down check at the end is
 * generated from it, so a boat missing here is a boat nobody will look for.
 * It has to be fast to use with wet hands and possible without signal.
 *
 * Every entry snapshots the PY, factor and fleet at the moment it is created.
 * Nothing here is recomputed later, so a published result never shifts.
 */

import { el, clear, field, selectField, panel, notice, armedButton } from "./../ui.js";
import * as db from "./../db.js";
import * as rd from "./../raceday.js";
import * as reg from "./../registers.js";
import { factorFor } from "./../handicap.js";
import { navigate } from "./../router.js";

let host = null;
let search = "";
let showAddBoat = false;
/* A boat tapped that has never raced here, so nobody knows who is helming it. */
let awaitingHelmFor = null;

export default {
  title: "Sign-on",

  mount(section) {
    host = section.querySelector("#signon-body");
    render();
  },

  unmount() {
    host = null;
    search = "";
    showAddBoat = false;
    awaitingHelmFor = null;
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

  const [entries, boats, helms, classes, lastHelms, recentUse] = await Promise.all([
    rd.entriesForRace(race.id),
    reg.listBoats(),
    reg.listHelms(),
    reg.listClasses(),
    rd.lastKnownHelms(),
    rd.boatsByRecentUse(),
  ]);

  return {
    raceDay,
    race,
    series,
    season,
    context,
    entries,
    boats,
    helms,
    classes,
    lastHelms,
    recentUse,
    boatById: new Map(boats.map((b) => [b.id, b])),
    helmById: new Map(helms.map((h) => [h.id, h])),
    classById: new Map(classes.map((c) => [c.id, c])),
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

  if (awaitingHelmFor) {
    const chooser = helmChooser(data);
    if (chooser) node.append(chooser);
  }

  const carry = await carryForwardPanel(data);
  if (carry) node.append(carry);
  node.append(searchPanel(data));
  node.append(entriesPanel(data));
  clear(host).append(node);

  // Put the cursor where the next tap would have gone.
  if (awaitingHelmFor) node.querySelector(".subform input")?.focus();
}

function headerPanel(data) {
  const { raceDay, race, series } = data;
  return el("div.raceline", {}, [
    el("div.raceline-main", {}, [
      el("div.eyebrow", { text: `${raceDay.date} · OOD ${raceDay.ood_name}` }),
      el("div.raceline-title", { text: `Race ${race.number}` }),
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

  const chosen = new Set(candidates.map((c) => c.boat.id));
  const list = el("div.reglist");

  for (const candidate of candidates) {
    const helm = data.helmById.get(candidate.helmId);
    const toggle = el("input", {
      type: "checkbox",
      checked: true,
      onchange: (event) => {
        if (event.target.checked) chosen.add(candidate.boat.id);
        else chosen.delete(candidate.boat.id);
      },
    });
    list.append(
      el("label.regrow.pickable", {}, [
        toggle,
        el("div.regmain", {}, [
          el("div.regname", { text: candidate.boat.name }),
          el("div.regmeta", {
            text: `${helm?.name ?? "no helm"} · ${describeFactor(candidate.snapshot, candidate.wins)}`,
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
        if (!chosen.has(candidate.boat.id)) continue;
        try {
          await rd.addEntry({
            race: data.race,
            boat: candidate.boat,
            klass: candidate.klass,
            helmId: candidate.helmId,
            context: data.context,
          });
        } catch (err) {
          console.warn("carry forward skipped", candidate.boat.name, err.message);
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

function searchPanel(data) {
  const body = el("div.panel-body");

  const box = el("input.searchbox", {
    type: "search",
    value: search,
    placeholder: "Search boats…",
    "aria-label": "Search boats",
    autocomplete: "off",
    oninput: (event) => {
      search = event.target.value;
      renderMatches();
    },
  });
  const matches = el("div.reglist");
  body.append(box, matches);

  const signedOn = new Set(data.entries.map((e) => e.boat_id));

  function renderMatches() {
    clear(matches);
    const needle = search.trim().toLowerCase();
    const available = data.boats.filter((b) => !signedOn.has(b.id));

    const scored = available
      .filter((boat) => {
        if (!needle) return true;
        return (
          boat.name.toLowerCase().includes(needle) ||
          String(boat.sail_no ?? "").toLowerCase().includes(needle) ||
          String(boat.klass?.name ?? "").toLowerCase().includes(needle)
        );
      })
      // Most recently raced first: the boats out today are the likely ones.
      .sort((a, b) => {
        const seenA = data.recentUse.get(a.id) ?? "";
        const seenB = data.recentUse.get(b.id) ?? "";
        if (seenA !== seenB) return seenB.localeCompare(seenA);
        return a.name.localeCompare(b.name);
      })
      .slice(0, 12);

    if (!scored.length) {
      matches.append(
        el("div.empty", {}, [
          el("p", { text: needle ? `No boat matching “${search}”.` : "Every boat is signed on." }),
        ])
      );
      return;
    }

    for (const boat of scored) {
      const helmId = data.lastHelms.get(boat.id) ?? null;
      const helm = helmId ? data.helmById.get(helmId) : null;
      const klass = data.classById.get(boat.class_id) ?? null;
      matches.append(
        el("button.regrow.tappable", {
          type: "button",
          onclick: () => addBoat(data, boat, klass, helmId, body),
        }, [
          el("div.regmain", {}, [
            el("div.regname", { text: boat.name }),
            el("div.regmeta", {
              text: [klass ? `${klass.name} · ${klass.base_py}` : "no class", helm?.name]
                .filter(Boolean)
                .join(" · "),
            }),
          ]),
          el("span.addmark", { text: "+", "aria-hidden": "true" }),
        ])
      );
    }
  }

  renderMatches();

  const addNew = el("button.btn.ghost", {
    type: "button",
    text: showAddBoat ? "Cancel" : "New boat",
    onclick: () => {
      showAddBoat = !showAddBoat;
      render();
    },
  });

  const children = [body, el("div.actions", {}, [addNew])];
  if (showAddBoat) children.splice(1, 0, newBoatForm(data));

  return panel("Add a boat", children, { count: `${data.entries.length} signed on` });
}

/**
 * A boat that is not in the register yet. Kept on this page rather than
 * sending the OOD to the registers screen mid sign-on.
 */
function newBoatForm(data) {
  const body = el("div.panel-body.subform");

  const name = field("Boat name or sail number", { class: "text", autocomplete: "off" });
  const klass = selectField("Class", [
    ...data.classes.map((c) => ({ value: c.id, label: `${c.name} · ${c.base_py}` })),
    { value: "__new__", label: "+ New class…" },
  ]);
  const newClassName = field("Class name", { class: "text", autocomplete: "off" });
  const newClassPy = field("Base PY", { inputMode: "numeric", autocomplete: "off" });
  const newClassBlock = el("div.subform", { hidden: true }, [newClassName.node, newClassPy.node]);
  klass.select.addEventListener("change", () => {
    newClassBlock.hidden = klass.select.value !== "__new__";
  });
  if (!data.classes.length) {
    klass.select.value = "__new__";
    newClassBlock.hidden = false;
  }

  const helmName = field("Helm", { class: "text", list: "helm-names", autocomplete: "off" });
  const helmOptions = el("datalist", { id: "helm-names" },
    data.helms.map((h) => el("option", { value: h.name })));

  const create = el("button.btn", {
    type: "button",
    text: "Add and sign on",
    onclick: async () => {
      body.querySelectorAll(".notice").forEach((n) => n.remove());
      create.disabled = true;
      try {
        let classId = klass.select.value;
        if (classId === "__new__") {
          const created = await reg.createClass({
            name: newClassName.input.value,
            basePy: newClassPy.input.value,
          });
          classId = created.id;
        }
        const boat = await reg.createBoat({ name: name.input.value, classId });
        const helm = await reg.createHelm({ name: helmName.input.value });
        const klassRow = await db.get("classes", classId);
        await rd.addEntry({
          race: data.race,
          boat,
          klass: klassRow,
          helmId: helm.id,
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

  body.append(name.node, klass.node, newClassBlock, helmName.node, helmOptions,
    el("div.actions", {}, [create]));
  return body;
}

async function addBoat(data, boat, klass, helmId, container) {
  container.querySelectorAll(".notice").forEach((n) => n.remove());

  if (!helmId) {
    // This boat has no history here, so we do not know who is sailing it.
    // Ask inline rather than with a native prompt: a blocking browser dialog
    // is a poor thing to hand someone with wet hands on a phone.
    awaitingHelmFor = { boatId: boat.id, klassId: klass?.id ?? null };
    await render();
    return;
  }

  try {
    await rd.addEntry({ race: data.race, boat, klass, helmId, context: data.context });
    search = "";
    await render();
  } catch (err) {
    container.prepend(notice(err.message, "error"));
  }
}

/** Who is helming this one? Shown when a boat has no last-known helm. */
function helmChooser(data) {
  const boat = data.boatById.get(awaitingHelmFor.boatId);
  const klass = data.classById.get(awaitingHelmFor.klassId) ?? null;
  if (!boat) {
    awaitingHelmFor = null;
    return null;
  }

  const body = el("div.panel-body.subform");
  const name = field(`Who is helming ${boat.name}?`, {
    class: "text",
    list: "helm-names-inline",
    autocomplete: "off",
    enterkeyhint: "done",
  });
  const options = el("datalist", { id: "helm-names-inline" },
    data.helms.map((h) => el("option", { value: h.name })));

  const confirmSignOn = async () => {
    body.querySelectorAll(".notice").forEach((n) => n.remove());
    try {
      const helm = await reg.createHelm({ name: name.input.value });
      await rd.addEntry({ race: data.race, boat, klass, helmId: helm.id, context: data.context });
      awaitingHelmFor = null;
      search = "";
      await render();
    } catch (err) {
      body.prepend(notice(err.message, "error"));
    }
  };

  name.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmSignOn();
    }
  });

  body.append(
    name.node,
    options,
    el("div.actions", {}, [
      el("button.btn", { type: "button", text: "Sign on", onclick: confirmSignOn }),
      el("button.btn.ghost", {
        type: "button",
        text: "Cancel",
        onclick: () => {
          awaitingHelmFor = null;
          render();
        },
      }),
    ])
  );

  return panel(`New to the sign-on list`, [body]);
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

  const sorted = [...data.entries].sort((a, b) => {
    const nameA = data.boatById.get(a.boat_id)?.name ?? "";
    const nameB = data.boatById.get(b.boat_id)?.name ?? "";
    return nameA.localeCompare(nameB);
  });

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
    disabled: !sorted.length,
    onclick: () => navigate("checklist"),
  });

  return panel("Signed on", [list, el("div.actions", {}, [next])], {
    count: `${sorted.length}`,
  });
}

function entryCard(data, entry) {
  const boat = data.boatById.get(entry.boat_id);
  const helm = data.helmById.get(entry.helm_id);
  const klass = boat ? data.classById.get(boat.class_id) : null;
  const laps = rd.entryLaps(entry, data.race);
  const wins = rd.winsFor(entry.helm_id, data.context);

  /* "Hamish · Laser 2000 · 1122 × 0.97 = 1088 (1 win) · Fast, 3 laps" */
  const summary = [
    helm?.name ?? "no helm",
    klass?.name ?? "no class",
    describeFactor(entry, wins),
    `${entry.fleet === "fast" ? "Fast" : "Slow"}, ${laps} lap${laps === 1 ? "" : "s"}`,
  ].join(" · ");

  const detail = el("div.entrydetail", { hidden: true });

  const card = el("div.entrycard", {}, [
    el("div.entrymain", {}, [
      el("div.entryboat", { text: boat?.name ?? "unknown boat" }),
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
          detail.append(entryEditor(data, entry, wins));
        }
      },
    }),
    detail,
  ]);

  return card;
}

function entryEditor(data, entry, wins) {
  const wrap = el("div.editorgrid");

  const helmPick = selectField(
    "Helm",
    data.helms.map((h) => ({ value: h.id, label: h.name })),
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

  wrap.append(helmPick.node, factorPick.node, lapsBox.node);

  /* Removal disappears once the race exists on the water: from then on the
     sign-on list is the tally record, and a boat that was there must stay
     visible. Codes are how a boat stops racing after that. */
  if (rd.canRemoveEntries(data.race)) {
    const boat = data.boatById.get(entry.boat_id);
    const remove = armedButton(
      "Remove from sign-on",
      `Tap again to remove ${boat?.name ?? "this boat"}`,
      "danger",
      async () => {
        await rd.removeEntry(entry.id, data.race);
        await render();
      }
    );
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
