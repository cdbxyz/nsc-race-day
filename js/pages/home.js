/* The homepage — where the app opens and where the mast always returns to.
 *
 * One question answered immediately: is there a race day in progress, and if
 * not, is there one scheduled today? Everything else is a way in, not a step.
 */

import { el, clear, panel, notice } from "./../ui.js";
import * as rd from "./../raceday.js";
import * as cal from "./../calendar.js";
import { raceLabel } from "./../state.js";
import { findResumePoint } from "./../resume.js";
import { navigate } from "./../router.js";

let host = null;

export default {
  title: "Race Day",

  async mount(section) {
    host = section.querySelector("#home-body");
    await render();
  },

  unmount() {
    host = null;
  },
};

function todayIso() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

async function render() {
  if (!host) return;

  const [resume, scheduled] = await Promise.all([
    findResumePoint(),
    cal.racesOn(todayIso()),
  ]);

  const node = el("div");
  node.append(resume ? inProgressHero(resume) : todayHero(scheduled));
  node.append(tiles(), guideLink());
  clear(host).append(node);
}

function inProgressHero(point) {
  return el("div.homehero", {}, [
    el("div.eyebrow", { text: "Race day in progress" }),
    el("div.homehero-title", { text: point.headline }),
    el("div.regmeta", { text: point.detail }),
    el("div.actions", { style: "padding:6px 0 0" }, [
      el("button.btn", { type: "button", text: "Carry on", onclick: () => navigate(point.route) }),
    ]),
  ]);
}

function todayHero(scheduled) {
  const children = [
    el("div.eyebrow", { text: "Nefyn Sailing Club" }),
    el("div.homehero-title", { text: "No race day open" }),
  ];

  if (scheduled.length) {
    children.push(
      el("div.regmeta", {
        text: `Today: ${scheduled
          .map((r) => `${r.name} ${cal.shortTime(r.start_time)}`)
          .join(" · ")}`,
      })
    );
  } else {
    children.push(el("div.regmeta", { text: "Nothing on the programme today." }));
  }

  children.push(
    el("div.actions", { style: "padding:6px 0 0" }, [
      el("button.btn", { type: "button", text: "Start a race day", onclick: () => navigate("setup") }),
    ])
  );

  return el("div.homehero", {}, children);
}

const TILES = [
  ["registers", "Registers", "Boats, members, classes and the season programme"],
  ["results", "Results", "The latest race sheet, and sharing it"],
  ["standdown", "Stand-down", "Tally check and closing the day"],
  ["dev", "Dev tools", "Sync, fast clock, wiping this phone"],
];

/* The OOD guide lives in the repo as Markdown so it stays one document
   rather than drifting into a second copy inside the app. That means it
   needs signal, which is fine for something read at home the night before —
   and the link says so, rather than dying silently on the beach. */
export const GUIDE_URL = "https://github.com/cdbxyz/nsc-race-day/blob/main/GUIDE.md";

function guideLink() {
  return el("p.guideline", {}, [
    el("a.linkish", {
      href: GUIDE_URL,
      target: "_blank",
      rel: "noopener",
      text: "First time as OOD? Read the guide",
    }),
    el("span.guidenote", { text: " — needs signal, so read it before you set off." }),
  ]);
}

function tiles() {
  const grid = el("div.hometiles");
  for (const [route, name, note] of TILES) {
    grid.append(
      el("button.hometile", { type: "button", onclick: () => navigate(route) }, [
        el("span.hometile-name", { text: name }),
        el("span.hometile-note", { text: note }),
      ])
    );
  }
  return grid;
}
