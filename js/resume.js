/* resume.js — pick up exactly where the phone left off.
 *
 * Browsers crash, phones sleep, sailors drop things. On every load we look for
 * an unfinished race day in IndexedDB and offer it back as the primary action,
 * naming the furthest-progressed race so the OOD can see at a glance that
 * nothing was lost.
 */

import * as db from "./db.js";
import { raceLabel } from "./state.js";

/** Where each race status wants the OOD to be. Phases 3-5 reuse this map. */
export const ROUTE_FOR_STATUS = {
  setup: "signon",
  prestart: "checklist",
  sequence: "sequence",
  racing: "live",
  finished: "results",
  published: "results",
  abandoned: "signon",
};

/* Higher means further through the day. Abandoned races are left out entirely:
   an abandoned race is not progress, it is a race that did not happen. */
const PROGRESS = {
  setup: 0,
  prestart: 1,
  sequence: 2,
  racing: 3,
  finished: 4,
  published: 5,
};

const STATUS_LABEL = {
  setup: "sign-on",
  prestart: "pre-race checklist",
  sequence: "start sequence",
  racing: "racing",
  finished: "awaiting results",
  published: "published",
  abandoned: "abandoned",
};

/**
 * The open race day and the race the OOD should be looking at, or null.
 * @returns {Promise<null|{raceDay:object, race:object|null, route:string, headline:string, detail:string}>}
 */
export async function findResumePoint() {
  const open = await db.getAllByIndex("race_days", "by_status", "open");
  if (!open.length) return null;

  // Most recent day wins — created_at breaks ties between two days' dates.
  // Both are strings (ISO timestamps sort correctly lexicographically), so
  // compare them as such rather than subtracting.
  open.sort(
    (a, b) =>
      String(b.date || "").localeCompare(String(a.date || "")) ||
      String(b.created_at || "").localeCompare(String(a.created_at || ""))
  );
  const raceDay = open[0];

  const races = await db.getAllByIndex("races", "by_race_day", raceDay.id);
  const live = races.filter((r) => r.status in PROGRESS);
  live.sort((a, b) => PROGRESS[b.status] - PROGRESS[a.status] || (b.number || 0) - (a.number || 0));
  const race = live[0] || null;

  return {
    raceDay,
    race,
    route: race ? ROUTE_FOR_STATUS[race.status] : "setup",
    headline: race ? `${raceLabel(race)} · ${STATUS_LABEL[race.status]}` : "Race day setup",
    detail: [formatDate(raceDay.date), raceDay.ood_name && `OOD ${raceDay.ood_name}`]
      .filter(Boolean)
      .join(" · "),
  };
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/**
 * Draw (or clear) the resume banner.
 * @param {HTMLElement} host the banner slot in the app shell
 * @param {object|null} point result of findResumePoint()
 * @param {(route:string)=>void} onResume
 */
export function renderResumeBanner(host, point, onResume) {
  host.textContent = "";
  host.hidden = !point;
  if (!point) return;

  const banner = document.createElement("div");
  banner.className = "resume";
  banner.innerHTML = `
    <div class="eyebrow">Unfinished race day</div>
    <div class="what"></div>
    <div class="detail"></div>
    <div class="actions">
      <button class="btn" type="button">Resume</button>
      <button class="btn ghost" type="button">Dismiss</button>
    </div>`;
  banner.querySelector(".what").textContent = point.headline;
  banner.querySelector(".detail").textContent = point.detail;

  const [resumeBtn, dismissBtn] = banner.querySelectorAll("button");
  resumeBtn.addEventListener("click", () => onResume(point.route));
  // Dismiss only hides it for this load — the day stays open in the database.
  dismissBtn.addEventListener("click", () => {
    host.textContent = "";
    host.hidden = true;
  });

  host.append(banner);
}
