/* Registers — the club's classes, boats and helms.
 *
 * Reachable from setup, and the same creation paths are reused inline from
 * sign-on so a visiting boat never has to send anyone back here mid-morning.
 */

import { el, clear, field, selectField, panel, notice } from "./../ui.js";
import * as reg from "./../registers.js";

let host = null;
let tab = "boats";

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
      tabButton("boats", "Boats"),
      tabButton("helms", "Helms"),
      tabButton("classes", "Classes"),
    ])
  );

  if (tab === "boats") node.append(await boatsPanel());
  if (tab === "helms") node.append(await helmsPanel());
  if (tab === "classes") node.append(await classesPanel());

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

/* ---- boats -------------------------------------------------------------- */

async function boatsPanel() {
  const [boats, classes] = await Promise.all([reg.listBoats(), reg.listClasses()]);
  const body = el("div.panel-body");

  if (!classes.length) {
    body.append(
      notice("Add a class first — a boat takes its PY from its class.", "info")
    );
  } else {
    const name = field("Boat name or sail number", { class: "text", autocomplete: "off" });
    const sail = field("Sail number (optional)", { class: "text", autocomplete: "off" });
    const klass = selectField(
      "Class",
      classes.map((c) => ({ value: c.id, label: `${c.name} · ${c.base_py}` }))
    );
    const add = el("button.btn", {
      type: "button",
      text: "Add boat",
      onclick: () =>
        attempt(async () => {
          await reg.createBoat({
            name: name.input.value,
            sailNo: sail.input.value,
            classId: klass.select.value,
          });
        }, body),
    });
    body.append(name.node, sail.node, klass.node, el("div.actions", {}, [add]));
  }

  const list = el("div.reglist");
  for (const boat of boats) {
    list.append(
      el("div.regrow", {}, [
        el("div.regmain", {}, [
          el("div.regname", { text: boat.name }),
          el("div.regmeta", {
            text: [boat.sail_no, boat.klass ? `${boat.klass.name} · PY ${boat.klass.base_py}` : "no class"]
              .filter(Boolean)
              .join(" · "),
          }),
        ]),
        el("button.kill", {
          type: "button",
          text: "Retire",
          onclick: () => attempt(() => reg.retireBoat(boat.id), list),
        }),
      ])
    );
  }
  if (!boats.length) list.append(el("div.empty", {}, [el("p", { text: "No boats yet." })]));

  return panel("Boats", [body, list], { count: `${boats.length}` });
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
