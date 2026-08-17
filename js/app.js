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
import { activeModes, onModeChange } from "./devmode.js";
import { clockWarning, onClockChange } from "./clockcheck.js";
import { requestPersistence, storageWarning, onStorageChange } from "./storage.js";
import { createPinPrompt } from "./pin.js";
import { createRouter } from "./router.js";
import { findResumePoint, renderResumeBanner } from "./resume.js";
import { startUpdateWatch, createUpdatePrompt, canPromptNow } from "./update.js";

import home from "./pages/home.js";
import setup from "./pages/setup.js";
import registers from "./pages/registers.js";
import signon from "./pages/signon.js";
import checklist from "./pages/checklist.js";
import sequence from "./pages/sequence.js";
import live from "./pages/live.js";
import results from "./pages/results.js";
import standdown from "./pages/standdown.js";
import dev from "./pages/dev.js";

const PAGES = { home, setup, registers, signon, checklist, sequence, live, results, standdown, dev };

let router;
let updatePrompt;
let pinPrompt;

/**
 * The TEST MODE banner.
 *
 * Lives in the shell so it is above every page — the live race and the
 * results sheet included — and has no dismiss control at all. The only way
 * to clear it is to leave the mode, and since no dev mode survives a reload,
 * reloading always works.
 */
function wireTestModeBanner(node) {
  if (!node) return;

  const paint = (modes) => {
    node.textContent = "";
    node.hidden = modes.length === 0;
    for (const mode of modes) {
      const line = document.createElement("div");
      line.className = "testmodebar-line";

      const label = document.createElement("strong");
      label.textContent = mode.label;
      const detail = document.createElement("span");
      detail.className = "testmodebar-detail";
      detail.textContent = mode.detail;

      line.append(label, detail);
      node.append(line);
    }
  };

  onModeChange(paint);
  paint(activeModes());
}

/**
 * The device-clock warning.
 *
 * Advisory by design: it never rewrites a stored timestamp and never blocks a
 * write. A phone with a wrong clock still holds the best record of the race
 * that exists, and an offset that is KNOWN is recoverable afterwards — which
 * is the entire point of saying it out loud.
 */
function wireClockWarning(node) {
  if (!node) return;
  const paint = (warning) => {
    node.textContent = warning ?? "";
    node.hidden = !warning;
  };
  onClockChange(paint);
  paint(clockWarning());
}

function wireStorageWarning(node) {
  if (!node) return;
  const paint = () => {
    const warning = storageWarning();
    node.textContent = warning ?? "";
    node.hidden = !warning;
  };
  onStorageChange(paint);
  paint();
}

/**
 * The mid-day sign-out bar.
 *
 * A PIN session can expire in the middle of a race day. Nothing is lost when
 * it does — every tap is already committed locally and the outbox holds its
 * place in order — but without this the only symptom is a sync pill that
 * quietly retries forever, and the day's records never arrive.
 *
 * So it asks, in one line, with the button that fixes it. Re-entering the PIN
 * does not touch a single stored row: the outbox simply drains on the next
 * flush, in the same order it was tapped.
 */
function wireAuthBar(node) {
  if (!node) return;
  const text = node.querySelector(".authbar-text");
  node.querySelector("#auth-signin").addEventListener("click", () => promptForPin());

  sync.subscribe((status) => {
    const show = Boolean(status.needsAuth) && status.pending > 0;
    node.hidden = !show;
    if (show) {
      text.textContent =
        `${status.pending} record${status.pending === 1 ? "" : "s"} waiting — this phone is signed out. ` +
        "Nothing is lost; they will go up as soon as you sign in.";
    }
  });
}

async function boot() {
  await db.openDB();

  wireSyncIndicator();
  // Point sync at the real database. Nothing reaches the network until there
  // is a session; until then batches simply wait in the outbox.
  sync.setBackend(supabaseBackend);
  sync.start();

  wireSyncSheet();
  document.getElementById("mast-home").addEventListener("click", () => router.navigate("home"));

  pinPrompt = createPinPrompt(document.getElementById("pin-dialog"), {
    onSignedIn: () => {
      // Pull the registers straight away rather than waiting for a race day to
      // start: it is the fastest proof the phone can actually reach the club
      // database, and it stamps the pill within a second or two.
      refreshReferenceData();
      sync.flush();
    },
  });

  updatePrompt = createUpdatePrompt(document.getElementById("update-bar"));
  wireTestModeBanner(document.getElementById("testmode-bar"));
  wireClockWarning(document.getElementById("clock-bar"));
  wireStorageWarning(document.getElementById("storage-bar"));
  wireAuthBar(document.getElementById("auth-bar"));
  /* Ask on every boot, not once: the answer changes the moment the app is
     installed to the home screen, and asking again costs nothing. Not
     awaited — a race day must not wait on a permission. */
  requestPersistence();

  const routes = {};
  for (const [name, page] of Object.entries(PAGES)) {
    const section = document.getElementById(`page-${name}`);
    if (!section) throw new Error(`no section for page "${name}"`);
    routes[name] = { section, page };
  }
  router = createRouter(routes, { fallback: "home", onChange: refreshUpdateAllowed });
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
    // The pull recorded a server contact; let the pill show it.
    await sync.refreshStatus();
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

/**
 * Time of day, with the date added once it is no longer today — "Synced 14:32"
 * is reassuring on a race afternoon and misleading the next morning.
 */
function contactLabel(ts) {
  if (!ts) return null;
  const when = new Date(ts);
  const time = when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay = when.toDateString() === new Date().toDateString();
  if (sameDay) return time;
  return `${when.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

function wireSyncIndicator() {
  const pill = document.getElementById("sync-pill");
  const label = document.getElementById("sync-label");

  sync.subscribe(({ state, pending, blocked, lastSyncedAt }) => {
    pill.dataset.state = state;
    if (blocked) {
      // Never hide this. Those events are on the phone and nowhere else.
      label.textContent = `${blocked} stuck${pending ? ` · ${pending} waiting` : ""}`;
    } else if (state === "offline") {
      // Unchanged by design: offline is normal on the beach, not a warning.
      label.textContent = pending ? `Offline · ${pending} waiting` : "Offline";
    } else if (state === "error") {
      label.textContent = `Retrying · ${pending} waiting`;
    } else if (pending) {
      label.textContent = `${pending} waiting`;
    } else {
      // An empty outbox alone proves nothing — it looks identical on a phone
      // that has never reached the server. Show when we last actually did.
      const at = contactLabel(lastSyncedAt);
      label.textContent = at ? `Synced · ${at}` : "Not synced yet";
    }
  });

  pill.addEventListener("click", () => openSyncSheet());
}

/** The detail behind the pill, including a home for stuck events. */
function wireSyncSheet() {
  const sheet = document.getElementById("sync-sheet");
  const contact = sheet.querySelector("#sheet-contact");
  const waiting = sheet.querySelector("#sheet-waiting");
  const stuckRow = sheet.querySelector("#sheet-stuck-row");
  const stuck = sheet.querySelector("#sheet-stuck");
  const auth = sheet.querySelector("#sheet-auth");
  const note = sheet.querySelector("#sheet-note");
  const pinButton = sheet.querySelector("#sheet-pin");
  const retryButton = sheet.querySelector("#sheet-retry");

  function render() {
    const { pending, blocked, lastSyncedAt } = sync.status;
    const signedIn = api.isSignedIn();

    contact.textContent = contactLabel(lastSyncedAt) ?? "never";
    waiting.textContent = String(pending);
    stuck.textContent = String(blocked || 0);
    stuckRow.hidden = !blocked;
    auth.textContent = signedIn ? "yes" : "no";

    pinButton.hidden = signedIn;
    retryButton.hidden = !blocked;

    if (blocked) {
      note.textContent =
        "Stuck events are safe on this phone but the database refused them. " +
        "They need someone to look at them — nothing has been lost.";
    } else if (!signedIn) {
      note.textContent =
        "Without the PIN, everything is still recorded on this phone. It just " +
        "cannot reach the club database yet.";
    } else if (!lastSyncedAt) {
      note.textContent = "This phone has not reached the club database yet.";
    } else if (pending) {
      note.textContent = "Waiting for signal. Nothing is lost while it waits.";
    } else {
      note.textContent = "Everything recorded on this phone is in the club database.";
    }
  }

  sheet.querySelector("#sheet-close").addEventListener("click", () => sheet.close());
  pinButton.addEventListener("click", () => {
    sheet.close();
    pinPrompt.open();
  });
  retryButton.addEventListener("click", async () => {
    retryButton.disabled = true;
    await db.unblockOutbox();
    await sync.flush();
    retryButton.disabled = false;
    render();
  });

  sync.subscribe(() => {
    if (sheet.open) render();
  });

  openSyncSheet = () => {
    render();
    if (!sheet.open) sheet.showModal();
  };
}

let openSyncSheet = () => {};

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
