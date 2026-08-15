/* app.js — boot and wiring.
 *
 * Order matters: the database opens first, because nothing else is allowed to
 * assume it is there; then sync starts draining whatever the last session left
 * behind; then we look for an unfinished race day before showing any page.
 */

import * as db from "./db.js";
import { sync } from "./sync.js";
import * as api from "./supabase.js";
import { supabaseBackend, pullReferenceData } from "./backend.js";
import { createPinPrompt } from "./pin.js";
import { createRouter } from "./router.js";
import { findResumePoint, renderResumeBanner } from "./resume.js";
import { startUpdateWatch, createUpdatePrompt, canPromptNow } from "./update.js";

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
let updatePrompt;
let pinPrompt;

async function boot() {
  await db.openDB();

  wireSyncIndicator();
  // Point sync at the real database. Nothing reaches the network until there
  // is a session; until then batches simply wait in the outbox.
  sync.setBackend(supabaseBackend);
  sync.start();

  pinPrompt = createPinPrompt(document.getElementById("pin-dialog"), {
    onSignedIn: () => {
      sync.flush();
      refreshReferenceData();
    },
  });

  updatePrompt = createUpdatePrompt(document.getElementById("update-bar"));

  const routes = {};
  for (const [name, page] of Object.entries(PAGES)) {
    const section = document.getElementById(`page-${name}`);
    if (!section) throw new Error(`no section for page "${name}"`);
    routes[name] = { section, page };
  }
  router = createRouter(routes, { fallback: "setup", onChange: refreshUpdateAllowed });
  router.start();

  // Race state changes are writes, so this catches a race starting or
  // finishing as well as the OOD moving between pages.
  db.onWrite(refreshUpdateAllowed);
  await refreshUpdateAllowed();

  await showResumeBanner();

  // Ask for the PIN on a device that has never had one. Not a gate: the
  // dialog can be dismissed and the whole race day still works.
  if (!api.isSignedIn()) pinPrompt.open();
  else refreshReferenceData();

  // Signal came back on the drive home: catch the registers up too.
  globalThis.addEventListener("online", refreshReferenceData);

  startUpdateWatch({ onAvailable: updatePrompt.onAvailable });
}

/** Pull the registers down whenever there is a session and some signal. */
async function refreshReferenceData() {
  if (!api.isSignedIn() || navigator.onLine === false) return;
  try {
    const { counts } = await pullReferenceData();
    console.info("[reference] refreshed", counts);
  } catch (err) {
    // Stale reference data is survivable — the last-refreshed stamp is what
    // tells the OOD how old it is.
    console.warn("[reference] refresh failed", err.message);
  }
}

/** Offer the PIN prompt from anywhere (the dev panel, later the setup page). */
export function promptForPin() {
  pinPrompt?.open();
}

/** Decide whether now is a calm enough moment to offer a new build. */
async function refreshUpdateAllowed() {
  if (!updatePrompt) return;
  try {
    const races = await db.getAll("races");
    updatePrompt.setAllowed(
      canPromptNow({ page: router?.current, raceStatuses: races.map((r) => r.status) })
    );
  } catch (err) {
    // If we can't tell what's happening, say nothing rather than interrupt.
    console.error("could not evaluate update prompt state", err);
    updatePrompt.setAllowed(false);
  }
}

function wireSyncIndicator() {
  const pill = document.getElementById("sync-pill");
  const label = document.getElementById("sync-label");

  sync.subscribe(({ state, pending, blocked }) => {
    pill.dataset.state = state;
    if (blocked) {
      // Never hide this. Those events are on the phone and nowhere else.
      label.textContent = `${blocked} stuck${pending ? ` · ${pending} waiting` : ""}`;
    } else if (state === "offline") {
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
