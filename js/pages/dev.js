/* Dev harness — not part of the OOD journey.
 *
 * Exists to exercise the plumbing before there is any real UI on top of it,
 * and to run the offline drills in Phase 6: write events, watch the outbox
 * fill up with the network off, force a flush, wind the fake backend's failure
 * rate up and watch the backoff cope.
 */

import * as db from "./../db.js";
import { sync, fakeBackend } from "./../sync.js";

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

    const raceStatus = section.querySelector("#dev-race-status");
    raceStatus.addEventListener("change", async () => {
      const race = await latestRace();
      if (!race) {
        alert("Write a test event first — there is no race to move.");
        return;
      }
      // Status changes go through localWrite like everything else, which is
      // also what re-evaluates whether the update prompt may show.
      await db.localWrite("races", { ...race, status: raceStatus.value });
      render();
    });

    section.querySelector("#dev-write").addEventListener("click", async () => {
      await writeTestEvent();
      render();
    });
    section.querySelector("#dev-flush").addEventListener("click", () => sync.flush());
    section.querySelector("#dev-clear").addEventListener("click", async () => {
      if (!confirm("Delete all local race data? This cannot be undone.")) return;
      await db.clearAll();
      await sync.refreshStatus();
      render();
    });

    async function render() {
      const outbox = await db.peekOutbox(50);
      const { consecutiveFailures, lastDelay, backend } = sync.stats();
      const race = await latestRace();
      raceStatus.value = race ? race.status : "";
      const lines = [
        `race         ${race ? `${race.number} — ${race.status}` : "none"}`,
        `backend      ${backend} (${Math.round(fakeBackend.failureRate * 100)}% failure)`,
        `status       ${sync.status.state}`,
        `pending      ${sync.status.pending}`,
        `failures     ${consecutiveFailures}${lastDelay ? ` (retry in ${lastDelay}ms)` : ""}`,
        `last error   ${sync.status.lastError || "none"}`,
        `backend rows ${fakeBackend.rows.size}`,
        "",
        ...outbox.map(
          (e) => `#${e.seq} ${e.table} ${e.id.slice(0, 8)} attempts=${e.attempts}`
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
      created_at: Date.now(),
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
    occurred_at: Date.now(),
  });
}
