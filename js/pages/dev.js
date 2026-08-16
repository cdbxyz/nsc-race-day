/* Dev harness — not part of the OOD journey.
 *
 * Exists to exercise the plumbing before there is any real UI on top of it,
 * and to run the offline drills in Phase 6: write events, watch the outbox
 * fill up with the network off, force a flush, wind the fake backend's failure
 * rate up and watch the backoff cope.
 */

import * as db from "./../db.js";
import { el, flash, armedButton } from "./../ui.js";
import { sync, fakeBackend } from "./../sync.js";
import * as raceLog from "./../raceevents.js";
import * as api from "./../supabase.js";
import { supabaseBackend, pullReferenceData, lastRefreshedAt } from "./../backend.js";
import { promptForPin } from "./../app.js";
import { SPEEDS, sequenceSpeed, setSequenceSpeed, isFastClock } from "./../devclock.js";

let stopWatching = null;

export default {
  title: "Dev",

  mount(section) {
    const failRate = section.querySelector("#dev-failrate");
    const failOut = section.querySelector("#dev-failrate-out");
    const log = section.querySelector("#dev-outbox");

    failRate.value = String(Math.round(fakeBackend.failureRate * 100));
    failOut.textContent = `${failRate.value}%`;
    failRate.addEventListener("input", () => {
      fakeBackend.failureRate = Number(failRate.value) / 100;
      failOut.textContent = `${failRate.value}%`;
    });

    /* The fast clock is in-memory only: a reload is always back to 1x, so a
       compressed sequence can never follow anyone into a real race day. */
    const speedSelect = section.querySelector("#dev-speed");
    const speedNote = section.querySelector("#dev-speed-note");
    speedSelect.value = String(sequenceSpeed());
    const describeSpeed = () => {
      speedNote.textContent = isFastClock()
        ? `A full 10-minute sequence takes ${Math.round(600 / sequenceSpeed())}s. Any race started at this speed is permanently marked as test data. Reload to return to 1×.`
        : "Real time. Reloading always returns here.";
      speedNote.className = isFastClock() ? "notice notice-error" : "stub";
    };
    speedSelect.addEventListener("change", () => {
      setSequenceSpeed(speedSelect.value);
      speedSelect.value = String(sequenceSpeed());
      describeSpeed();
      render();
    });
    describeSpeed();

    const backendSelect = section.querySelector("#dev-backend");
    const refreshedLine = section.querySelector("#dev-refreshed");

    backendSelect.value = sync.stats().backend === "fake" ? "fake" : "supabase";
    backendSelect.addEventListener("change", () => {
      sync.setBackend(backendSelect.value === "fake" ? fakeBackend : supabaseBackend);
      render();
    });

    section.querySelector("#dev-signin").addEventListener("click", () => promptForPin());
    section.querySelector("#dev-signout").addEventListener("click", () => {
      api.signOut();
      render();
    });
    section.querySelector("#dev-pull").addEventListener("click", async () => {
      try {
        const { counts } = await pullReferenceData();
        flash(section, `Refreshed: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
      } catch (err) {
        flash(section, `Refresh failed: ${err.message}`, "error");
      }
      render();
    });

    /* Forcing a race status is kept — it is the escape hatch for the
       situation nobody predicted, on a beach, with no developer available.
       But it is no longer silent or accidental: it is tap-to-arm, and it
       appends a status_overridden event carrying the status before and
       after, so the history drawer explains a strange status months later. */
    const raceStatus = section.querySelector("#dev-race-status");
    // Once the user has chosen, the ticker must stop overwriting them —
    // the choice has to survive until the second, confirming tap.
    let statusTouched = false;
    raceStatus.addEventListener("change", () => { statusTouched = true; });
    const applyStatus = armedButton("dev.status", {
      label: "Force this status",
      armedLabel: "TAP AGAIN TO FORCE THE STATUS",
      classes: "danger",
      onConfirm: async () => {
        const race = await latestRace();
        if (!race) {
          flash(section, "There is no race to move.", "error");
          return;
        }
        const to = raceStatus.value;
        if (!to || to === race.status) {
          flash(section, "Pick a different status first.", "error");
          return;
        }
        // The event first: the record of the override must exist before the
        // thing it describes, so a failed write cannot leave an unexplained
        // status behind.
        await raceLog.overrideStatus(race.id, { from: race.status, to });
        await db.localWrite("races", { ...race, status: to });
        flash(section, `Forced ${race.status} → ${to}. Recorded in the race history.`);
        statusTouched = false;
        render();
      },
    });
    section.querySelector("#dev-status-apply").replaceWith(applyStatus);

    section.querySelector("#dev-write").addEventListener("click", async () => {
      await writeTestEvent();
      render();
    });
    section.querySelector("#dev-flush").addEventListener("click", () => sync.flush());
    section.querySelector("#dev-unblock").addEventListener("click", async () => {
      await db.unblockOutbox();
      await sync.flush();
      render();
    });
    /* Wiping the phone is the most destructive thing in the app, so it says
       what it is doing at every step and never fails silently. */
    const wipeStatus = el("p.stub", { text: "" });
    const replacement = armedButton("dev.clear", {
      label: "Clear all local data",
      armedLabel: "TAP AGAIN TO WIPE THIS PHONE",
      classes: "danger",
      onConfirm: () => wipeThisPhone((text) => { wipeStatus.textContent = text; }),
    });
    replacement.id = "dev-clear";
    const target = section.querySelector("#dev-clear");
    target.replaceWith(replacement);
    replacement.after(wipeStatus);

    async function render() {
      const outbox = await db.allOutbox();
      const { consecutiveFailures, lastDelay, backend } = sync.stats();
      const race = await latestRace();
      if (!statusTouched) raceStatus.value = race ? race.status : "";

      const refreshedAt = await lastRefreshedAt();
      refreshedLine.textContent = refreshedAt
        ? `reference data: ${new Date(refreshedAt).toLocaleString()}`
        : "reference data: never";

      const lines = [
        `signed in    ${api.isSignedIn() ? "yes" : "no"}`,
        `clock        ${sequenceSpeed()}x${isFastClock() ? "  (races marked TEST DATA)" : ""}`,
        `race         ${race ? `${race.number} — ${race.status}` : "none"}`,
        `backend      ${backend}${backend === "fake" ? ` (${Math.round(fakeBackend.failureRate * 100)}% failure)` : ""}`,
        `status       ${sync.status.state}`,
        `pending      ${sync.status.pending}`,
        `stuck        ${sync.status.blocked || 0}`,
        `failures     ${consecutiveFailures}${lastDelay ? ` (retry in ${lastDelay}ms)` : ""}`,
        `last error   ${sync.status.lastError || "none"}`,
        `backend rows ${fakeBackend.rows.size}`,
        "",
        ...outbox.map(
          (e) =>
            `#${e.seq} ${e.blocked ? "STUCK " : ""}${e.table} ${e.id.slice(0, 8)} attempts=${e.attempts}` +
            (e.blocked ? `\n     ${e.last_error}` : "")
        ),
      ];
      log.textContent = lines.join("\n");
    }

    // Redraw on every status change, plus a slow tick so the retry countdown
    // and outbox contents don't go stale while nothing else is happening.
    const unsubscribe = sync.subscribe(render);
    const ticker = setInterval(render, 1000);
    stopWatching = () => {
      unsubscribe();
      clearInterval(ticker);
    };
    render();
  },

  unmount() {
    stopWatching?.();
    stopWatching = null;
  },
};

/**
 * Wipe this phone back to a fresh install.
 *
 * Order matters. Sync is stopped first so nothing writes during the delete;
 * the session goes next so a reload cannot come back signed in; the database
 * is closed before it is deleted, because deleteDatabase waits silently on an
 * open connection; and only then does the app reload, so it boots genuinely
 * empty rather than showing a resume banner for a race day that no longer
 * exists.
 */
async function wipeThisPhone(setStatus) {
  try {
    setStatus("Stopping sync…");
    sync.stop();

    setStatus("Signing out…");
    api.signOut();
    // Anything else this app has parked in localStorage goes too.
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("nsc-race-day.")) localStorage.removeItem(key);
    }

    setStatus("Deleting the database…");
    const { blocked } = await db.deleteDatabase({
      onBlocked: () => setStatus("Waiting for another tab to close the app…"),
    });

    setStatus(blocked ? "Deleted. Reloading…" : "Wiped. Reloading…");
    // Hard reload: every page module holds state that is now meaningless.
    setTimeout(() => globalThis.location.reload(), 400);
  } catch (err) {
    // Never silent. If the wipe failed, say so and leave the data alone.
    setStatus(`Could not wipe: ${err.message}`);
    console.error("wipe failed", err);
  }
}

/** The most recent race of the open day, if there is one. */
async function latestRace() {
  const days = await db.getAllByIndex("race_days", "by_status", "open");
  if (!days.length) return null;
  const races = await db.getAllByIndex("races", "by_race_day", days[0].id);
  return races.length ? races[races.length - 1] : null;
}

/**
 * Seed an open race day, one race and one event — enough to prove writes
 * survive a restart and to give the resume banner something to find.
 */
async function writeTestEvent() {
  const days = await db.getAllByIndex("race_days", "by_status", "open");
  let raceDay = days[0];
  let race;

  if (!raceDay) {
    raceDay = {
      id: db.newId(),
      date: new Date().toISOString().slice(0, 10),
      ood_name: "Dev Harness",
      ro1_name: null,
      ro2_name: null,
      status: "open",
      created_at: db.nowIso(),
    };
    await db.localWrite("race_days", raceDay);
  }

  const races = await db.getAllByIndex("races", "by_race_day", raceDay.id);
  if (races.length) {
    race = races[races.length - 1];
  } else {
    race = {
      id: db.newId(),
      race_day_id: raceDay.id,
      series_id: null,
      number: 1,
      name: null,
      status: "setup",
      sequence_start_at: null,
      start_at: null,
      fast_laps: 3,
      slow_laps: 2,
      published_at: null,
    };
    await db.localWrite("races", race);
  }

  await db.localWrite("race_events", {
    id: db.newId(),
    race_id: race.id,
    entry_id: null,
    type: "dev_test",
    payload: { note: "written from the dev panel" },
    // Tap time, captured on-device — never a server clock.
    occurred_at: db.nowIso(),
  });
}
