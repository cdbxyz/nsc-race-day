/* Registers — the club's classes, boats and helms.
 *
 * Reachable from setup, and the same creation paths are reused inline from
 * sign-on so a visiting boat never has to send anyone back here mid-morning.
 */

import { el, clear, field, selectField, panel, notice, pickerField } from "./../ui.js";
import { entryLabel } from "./../state.js";
import * as reg from "./../registers.js";
import * as cal from "./../calendar.js";

let host = null;
let tab = "combinations";

export default {
  title: "Registers",

  mount(section) {
    host = section.querySelector("#registers-body");
    render();
  },

  unmount() {
    host = null;
  },
};

async function render() {
  if (!host) return;
  const node = el("div");

  node.append(
    el("div.tabrow", {}, [
      tabButton("combinations", "Combinations"),
      tabButton("helms", "Helms"),
      tabButton("classes", "Classes"),
      tabButton("calendar", "Calendar"),
    ])
  );

  if (tab === "combinations") node.append(await combinationsPanel());
  if (tab === "helms") node.append(await helmsPanel());
  if (tab === "classes") node.append(await classesPanel());
  if (tab === "calendar") node.append(await calendarPanel());

  clear(host).append(node);
}

function tabButton(key, label) {
  return el("button.tabbtn", {
    type: "button",
    text: label,
    "aria-pressed": tab === key,
    onclick: () => {
      tab = key;
      render();
    },
  });
}

/** Run an action, showing whatever went wrong instead of swallowing it. */
async function attempt(fn, container) {
  const existing = container.querySelector(".notice");
  if (existing) existing.remove();
  try {
    await fn();
    await render();
  } catch (err) {
    container.prepend(notice(err.message, "error"));
  }
}

/* ---- combinations --------------------------------------------------------
 *
 * Staleness is SHOWN, never used to hide anything.
 *
 * A pairing that has not raced this season is still one tap from signing on —
 * they may be standing on the beach right now, back after a year away, and an
 * OOD who cannot find them will type a duplicate instead. So every active
 * combination stays in the list and in the sign-on list; the ones that have
 * not raced this season simply say so, in words, next to how often they have
 * raced. The committee can retire a pairing deliberately, which is a decision
 * rather than a side effect of not turning up.
 * ----------------------------------------------------------------------- */

let showRetired = false;

function seasonNow() {
  return new Date().getFullYear();
}

/** "raced 12 times · last raced Aug 2026", plus a flag when that is not this season. */
function combinationMeta(row) {
  const times = row.times_raced ?? 0;
  const bits = [
    row.klass ? `${row.klass.name} · PY ${row.klass.base_py}` : "no class",
    row.default_sail_no || null,
    times === 0 ? "never raced" : times === 1 ? "raced once" : `raced ${times} times`,
  ];

  if (row.last_raced) {
    const when = new Date(row.last_raced);
    bits.push(
      `last ${when.toLocaleDateString(undefined, { month: "short", year: "numeric" })}`
    );
    if (when.getFullYear() < seasonNow()) bits.push("not this season");
  }
  if (row.active === false) bits.push("RETIRED");

  return bits.filter(Boolean).join(" · ");
}

async function combinationsPanel() {
  const [rows, members, classes] = await Promise.all([
    reg.listCombinations({ includeRetired: showRetired }),
    reg.listMembers(),
    reg.listClasses(),
  ]);
  const body = el("div.panel-body");

  if (!classes.length || !members.length) {
    body.append(
      notice(
        "Add at least one class and one member first — a combination is a helm, in a class.",
        "info"
      )
    );
  } else {
    let helmId = null;
    let crewId = null;
    let classId = null;

    /* Chosen, never typed — the same rule as sign-on. A duplicate member here
       splits a handicap history exactly as one created on the beach would. */
    const helmPick = pickerField("Helm", {
      placeholder: "Choose a helm…",
      items: members.map((m) => ({ label: m.name, row: m })),
      onPick: (item) => {
        helmId = item.row.id;
        helmPick.set(item.row.name);
      },
    });

    const crewPick = pickerField("Crew (optional)", {
      placeholder: "Sailing solo",
      items: [
        { label: "— sailing solo —", row: null },
        ...members.map((m) => ({ label: m.name, row: m })),
      ],
      onPick: (item) => {
        crewId = item.row?.id ?? null;
        crewPick.set(item.row?.name ?? null);
      },
    });

    const classPick = pickerField("Class", {
      placeholder: "Choose a class…",
      items: classes.map((c) => ({
        label: c.name,
        detail: `PY ${c.base_py}${(c.crew_size ?? 1) === 2 ? " · 2 up" : ""}`,
        row: c,
      })),
      onPick: (item) => {
        classId = item.row.id;
        classPick.set(`${item.row.name} · ${item.row.base_py}`);
      },
    });

    const sail = field("Usual sail number (optional)", {
      class: "text",
      autocomplete: "off",
      inputMode: "numeric",
      placeholder: "e.g. 2298",
    });

    const add = el("button.btn", {
      type: "button",
      text: "Add combination",
      onclick: () =>
        attempt(async () => {
          await reg.createCombination({
            helmId,
            crewId,
            classId,
            defaultSailNo: sail.input.value,
          });
        }, body),
    });

    body.append(
      helmPick.node,
      crewPick.node,
      classPick.node,
      sail.node,
      el("div.actions", {}, [add])
    );
  }

  const toggle = el("button.btn.ghost", {
    type: "button",
    text: showRetired ? "Hide retired" : "Show retired",
    onclick: () => {
      showRetired = !showRetired;
      render();
    },
  });

  const list = el("div.reglist");
  for (const row of rows) {
    const number = field("Sail no.", {
      class: "text",
      autocomplete: "off",
      inputMode: "numeric",
      value: row.default_sail_no ?? "",
      placeholder: "none",
    });
    number.input.addEventListener("change", () =>
      attempt(
        () => reg.updateCombination(row.id, { defaultSailNo: number.input.value }),
        list
      )
    );

    list.append(
      el(`div.regrow${row.active === false ? ".retired" : ""}`, {}, [
        el("div.regmain", {}, [
          el("div.regname", { text: entryLabel(row) }),
          el("div.regmeta", { text: combinationMeta(row) }),
          number.node,
        ]),
        el("button.kill", {
          type: "button",
          text: row.active === false ? "Restore" : "Retire",
          onclick: () =>
            attempt(
              () =>
                row.active === false
                  ? reg.reviveCombination(row.id)
                  : reg.retireCombination(row.id),
              list
            ),
        }),
      ])
    );
  }
  if (!rows.length) {
    list.append(
      el("div.empty", {}, [
        el("p", {
          text: "No combinations yet. Add the club's regular pairings here, or let them appear as people race.",
        }),
      ])
    );
  }

  return panel("Combinations", [body, el("div.actions", {}, [toggle]), list], {
    count: `${rows.length}`,
  });
}

/* ---- helms -------------------------------------------------------------- */

async function helmsPanel() {
  const helms = await reg.listHelms();
  const body = el("div.panel-body");

  const name = field("Helm name", { class: "text", autocomplete: "off" });
  const add = el("button.btn", {
    type: "button",
    text: "Add helm",
    onclick: () => attempt(() => reg.createHelm({ name: name.input.value }), body),
  });
  body.append(name.node, el("div.actions", {}, [add]));

  const list = el("div.reglist");
  for (const helm of helms) {
    list.append(el("div.regrow", {}, [el("div.regmain", {}, [el("div.regname", { text: helm.name })])]));
  }
  if (!helms.length) list.append(el("div.empty", {}, [el("p", { text: "No helms yet." })]));

  return panel("Helms", [body, list], { count: `${helms.length}` });
}

/* ---- season programme ---------------------------------------------------
 * A draft committee proposal, so every row is editable here. Two races can
 * share a date; a pursuit race is flagged because v1 cannot run one.
 * ---------------------------------------------------------------------- */

async function calendarPanel() {
  const season = new Date().getFullYear();
  const entries = await cal.listCalendar();
  const body = el("div.panel-body");

  const date = field("Date", { type: "date" });
  const name = field("Race name", { class: "text", autocomplete: "off" });
  const time = field("Start time", { type: "time", value: "14:00" });
  const pursuit = selectField("Format", [
    { value: "", label: "Handicap" },
    { value: "1", label: "Pursuit (not supported in v1)" },
  ]);
  const add = el("button.btn", {
    type: "button",
    text: "Add to programme",
    onclick: () =>
      attempt(
        () => cal.createCalendarEntry({
          season, date: date.input.value, name: name.input.value,
          startTime: time.input.value, isPursuit: pursuit.select.value === "1",
        }),
        body
      ),
  });
  body.append(date.node, name.node, time.node, pursuit.node, el("div.actions", {}, [add]));

  const list = el("div.reglist");
  let lastDate = null;
  for (const entry of entries) {
    const sameDay = entry.date === lastDate;
    lastDate = entry.date;
    list.append(
      el("div.regrow", {}, [
        el("div.regmain", {}, [
          el("div.regname", { text: entry.name }),
          el("div.regmeta", {
            text: [
              sameDay ? "same day" : formatDay(entry.date),
              cal.shortTime(entry.start_time),
              entry.is_pursuit ? "PURSUIT — not supported" : null,
            ]
              .filter(Boolean)
              .join(" · "),
          }),
        ]),
        el("button.kill", {
          type: "button",
          text: "Remove",
          onclick: () => attempt(() => cal.removeCalendarEntry(entry.id), list),
        }),
      ])
    );
  }
  if (!entries.length) {
    list.append(el("div.empty", {}, [el("p", { text: "No programme yet." })]));
  }

  return panel("Season programme", [body, list], { count: `${entries.length}` });
}

function formatDay(iso) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/* ---- classes ------------------------------------------------------------ */

async function classesPanel() {
  const classes = await reg.listClasses();
  const body = el("div.panel-body");

  const name = field("Class name", { class: "text", autocomplete: "off" });
  const py = field("Base PY", { inputMode: "numeric", autocomplete: "off" });
  const crew = selectField("Crew", [
    { value: "1", label: "Single-handed" },
    { value: "2", label: "Double-handed" },
  ]);
  const add = el("button.btn", {
    type: "button",
    text: "Add class",
    onclick: () =>
      attempt(
        () => reg.createClass({
          name: name.input.value, basePy: py.input.value, crewSize: crew.select.value,
        }),
        body
      ),
  });
  body.append(name.node, py.node, crew.node, el("div.actions", {}, [add]));

  /* One-off seeding: paste the club's PY list rather than typing 40 classes. */
  const csv = el("textarea.csvbox", {
    rows: 6,
    placeholder: "Laser 2000,1122\nWayfarer,1100\nHeron,1345",
    "aria-label": "Paste class,PY rows",
  });
  const seedBody = el("div.panel-body", {}, [
    el("p.stub", {
      text: "Paste one class per line as “name,PY”. A header row is ignored, and classes already in the register are skipped.",
    }),
    csv,
    el("div.actions", {}, [
      el("button.btn.ghost", {
        type: "button",
        text: "Add these classes",
        onclick: async () => {
          const old = seedBody.querySelectorAll(".notice");
          old.forEach((n) => n.remove());
          const { created, skipped, errors } = await reg.seedClassesFromCsv(csv.value);
          const summary = [
            created.length ? `${created.length} added` : null,
            skipped.length ? `${skipped.length} already there` : null,
          ]
            .filter(Boolean)
            .join(", ");
          if (summary) seedBody.prepend(notice(summary, "info"));
          for (const problem of errors.slice(0, 5)) seedBody.prepend(notice(problem, "error"));
          if (created.length) await render();
        },
      }),
    ]),
  ]);

  const list = el("div.reglist");
  for (const klass of classes) {
    const crewSize = klass.crew_size ?? 1;
    // Crew size drives whether sign-on offers a crew field, so it has to be
    // correctable here without a migration.
    const toggle = selectField("", [
      { value: "1", label: "1 up" },
      { value: "2", label: "2 up" },
    ], { "aria-label": `Crew size for ${klass.name}` });
    toggle.select.value = String(crewSize);
    toggle.select.addEventListener("change", () =>
      attempt(() => reg.updateClass(klass.id, { crewSize: toggle.select.value }), list)
    );
    list.append(
      el("div.regrow", {}, [
        el("div.regmain", {}, [
          el("div.regname", { text: klass.name }),
          el("div.regmeta", { text: `base PY ${klass.base_py}` }),
        ]),
        toggle.select,
      ])
    );
  }
  if (!classes.length) list.append(el("div.empty", {}, [el("p", { text: "No classes yet." })]));

  return el("div", {}, [
    panel("Classes", [body, list], { count: `${classes.length}` }),
    panel("Seed from a pasted list", [seedBody]),
  ]);
}
