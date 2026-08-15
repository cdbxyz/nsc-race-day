/* app.js — boot and wiring.
 *
 * Order matters: the database opens first, because nothing else is allowed to
 * assume it is there; then sync starts draining whatever the last session left
 * behind; then we look for an unfinished race day before showing any page.
 */

import * as db from "./db.js";
import { sync } from "./sync.js";
import { createRouter } from "./router.js";
import { findResumePoint, renderResumeBanner } from "./resume.js";

import setup from "./pages/setup.js";
import signon from "./pages/signon.js";
import checklist from "./pages/checklist.js";
import sequence from "./pages/sequence.js";
import live from "./pages/live.js";
import results from "./pages/results.js";
import standdown from "./pages/standdown.js";
import dev from "./pages/dev.js";

const PAGES = { setup, signon, checklist, sequence, live, results, standdown, dev };

let router;

async function boot() {
  await db.openDB();

  wireSyncIndicator();
  sync.start();

  const routes = {};
  for (const [name, page] of Object.entries(PAGES)) {
    const section = document.getElementById(`page-${name}`);
    if (!section) throw new Error(`no section for page "${name}"`);
    routes[name] = { section, page };
  }
  router = createRouter(routes, { fallback: "setup" });
  router.start();

  await showResumeBanner();
  registerServiceWorker();
}

function wireSyncIndicator() {
  const pill = document.getElementById("sync-pill");
  const label = document.getElementById("sync-label");

  sync.subscribe(({ state, pending }) => {
    pill.dataset.state = state;
    if (state === "offline") {
      label.textContent = pending ? `Offline · ${pending} waiting` : "Offline";
    } else if (state === "error") {
      label.textContent = `Retrying · ${pending} waiting`;
    } else if (pending) {
      label.textContent = `${pending} waiting`;
    } else {
      label.textContent = "All synced";
    }
  });
}

async function showResumeBanner() {
  const slot = document.getElementById("resume-slot");
  const point = await findResumePoint();
  renderResumeBanner(slot, point, (route) => router.navigate(route));
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // Relative path so the worker's scope is this directory, which is what makes
  // the app work as a GitHub Pages project site.
  navigator.serviceWorker
    .register("sw.js")
    .catch((err) => console.error("service worker registration failed", err));
}

boot().catch((err) => {
  console.error("boot failed", err);
  document.body.insertAdjacentHTML(
    "afterbegin",
    '<div class="resume" style="margin:14px"><div class="eyebrow">Problem</div>' +
      '<div class="what">The app could not start</div>' +
      '<div class="detail">Local storage may be unavailable. Try reopening; ' +
      "your recorded events are not lost.</div></div>"
  );
});
