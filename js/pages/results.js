/* Step 5 — results.
 *
 * The familiar sheet: position, boat, helm, the PY with its working shown,
 * laps, elapsed, lap-adjusted, corrected, points and how far behind the leader.
 *
 * Corrections are appended as `correction` events before publishing, never
 * edits — the history drawer on the live page shows every one. Publishing
 * freezes the race, makes it publicly readable and feeds helm_season_wins.
 */

import { el, clear, panel, notice, field, selectField } from "./../ui.js";
import * as db from "./../db.js";
import * as rd from "./../raceday.js";
import * as log from "./../raceevents.js";
import { resultInputs, correctionFor, raceLabel, raceName, entryLabel, entryDetail } from "./../state.js";
import { scoreRace, formatPoints, hms, gapText, pyText, placeText, CODE_ORDER } from "./../scoring.js";
import { savePdf } from "./../pdf.js";
import { navigate } from "./../router.js";
import { dutyLine } from "./setup.js";

let host = null;
let context = null;
let correcting = null;

export default {
  title: "Results",

  async mount(section) {
    host = section.querySelector("#results-body");
    correcting = null;
    await reload();
  },

  unmount() {
    host = null;
    context = null;
  },
};

async function load() {
  // The latest day, open or closed — a published result stays readable after
  // stand-down, because someone always wants the PDF again on Monday.
  const raceDay = await rd.latestRaceDay();
  if (!raceDay) return (context = null);

  const races = await rd.racesForDay(raceDay.id);
  // The race being looked at: the furthest one that has actually been sailed.
  const race =
    races.filter((r) => ["finished", "published", "racing"].includes(r.status)).pop() ??
    races[0];
  if (!race) return (context = null);

  const [events, entries, boats, helms, classes, series] = await Promise.all([
    log.eventsForRace(race.id),
    rd.entriesForRace(race.id),
    db.getAll("boats"),
    db.getAll("helms"),
    db.getAll("classes"),
    race.series_id ? db.get("series", race.series_id) : null,
  ]);

  const boatById = new Map(boats.map((b) => [b.id, b]));
  const helmById = new Map(helms.map((h) => [h.id, h]));
  const classById = new Map(classes.map((c) => [c.id, c]));

  const inputs = resultInputs({ race, entries, events }).map((row) => {
    const parts = {
      boat: row.entry.boat_id ? boatById.get(row.entry.boat_id) ?? null : null,
      helm: helmById.get(row.entry.helm_id) ?? null,
      crew: row.entry.crew_id ? helmById.get(row.entry.crew_id) ?? null : null,
      klass: classById.get(row.entry.class_id) ?? null,
    };
    return {
      ...row,
      // Where there is no hull, the combination IS the name.
      name: entryLabel(parts),
      helm: [parts.helm?.name, parts.crew?.name].filter(Boolean).join(" + "),
      klass: parts.klass?.name ?? "",
      sailNo: parts.boat?.sail_no ?? "",
    };
  });

  context = {
    raceDay,
    race,
    series,
    events,
    entries,
    inputs,
    results: scoreRace(inputs),
  };
  return context;
}

async function reload() {
  await load();
  render();
}

function render() {
  if (!host) return;

  if (!context) {
    clear(host).append(
      panel("No results yet", [
        el("div.panel-body", {}, [el("p.stub", { text: "Nothing has been sailed." })]),
        el("div.actions", {}, [
          el("button.btn", { type: "button", text: "Race day setup", onclick: () => navigate("setup") }),
        ]),
      ])
    );
    return;
  }

  const node = el("div");
  if (rd.isTestDay(context.raceDay)) node.append(testDataBanner());
  node.append(headerPanel());
  node.append(resultsPanel());
  if (correcting) node.append(correctionSheet());
  node.append(exportPanel());
  node.append(publishPanel());
  clear(host).append(node);
}

function headerPanel() {
  const { race, raceDay, series } = context;
  const published = race.status === "published";

  const header = el("div.raceline", {}, [
    el("div.raceline-main", {}, [
      el("div.eyebrow", { text: `${raceDay.date} · ${dutyLine(raceDay)}` }),
      el("div.raceline-title", { text: raceLabel(race) }),
      el("div.regmeta", {
        text: [series ? `${series.name} ${series.season}` : null, published ? "Published" : "Provisional"]
          .filter(Boolean)
          .join(" · "),
      }),
    ]),
  ]);

  /* Naming a race is usually an afterthought — someone remembers it was the
     Whittaker Cup while the results are on screen. Editable until publish,
     which is the point the sheet becomes the record. */
  if (!published) {
    const nameBox = el("input.racenamefield", {
      type: "text",
      value: raceName(race),
      placeholder: "Name this race (optional)",
      "aria-label": "Race name",
      onchange: async (event) => {
        await rd.setRaceName(race, event.target.value);
        await reload();
      },
    });
    header.append(nameBox);
  }

  return header;
}

function testDataBanner() {
  return notice(
    "TEST DATA — this race was run on the dev fast clock. These results are not real and must not be published as if they were.",
    "error"
  );
}

/* ---- the sheet ---------------------------------------------------------- */

function resultsPanel() {
  const { results, race } = context;
  const editable = race.status !== "published";
  const cards = el("div.cards");

  for (const row of results.scored) {
    cards.append(resultCard(row, editable, false));
  }
  for (const row of results.out) {
    cards.append(resultCard(row, editable, true));
  }

  if (!results.scored.length && !results.out.length) {
    cards.append(el("div.empty", {}, [el("p", { text: "No boats to score." })]));
  }

  return panel("Results", [cards, footnote()], {
    count: `${results.scored.length} scored`,
  });
}

function resultCard(row, editable, isOut) {
  const input = context.inputs.find((i) => i.id === row.id);
  const meta = [
    row.name === row.helm ? null : row.helm,
    row.klass,
    row.sailNo || null,
    pyText(row),
    isOut ? row.reason : `${row.laps} lap${row.laps === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const times = isOut
    ? el("div.ctime", {}, [el("div.ccorr", { text: formatPoints(row.points) })])
    : el("div.ctime", {}, [
        el("div.ccorr", { text: hms(row.corrected) }),
        el("div.celap", { text: `${hms(row.elapsed)} · adj ${hms(row.ladj)}` }),
        el("div.celap", { text: `${formatPoints(row.points)} pts` }),
      ]);

  const gap = isOut
    ? null
    : el("div.cgap", {}, [
        el("div.gapbar", {}, [el("i", { style: `width:${Math.round(row.frac * 100)}%` })]),
        el("span.gaptxt", { text: gapText(row.gap) }),
      ]);

  const card = el(`div.card${isOut ? ".out" : ""}${row.place === 1 && !isOut ? ".lead" : ""}`, {}, [
    el("div.cpos", { text: isOut ? row.code || "—" : placeText(row) }),
    el("div.cwho", {}, [
      el("div.cboat", { text: row.name }),
      el("div.cmeta", { text: meta }),
      input?.corrected ? el("span.correctedmark", { text: "corrected" }) : null,
    ]),
    times,
    gap,
  ]);

  if (editable) {
    card.append(
      el("button.kill.correctbtn", {
        type: "button",
        text: "Correct",
        onclick: () => {
          correcting = row.id;
          render();
        },
      })
    );
  }

  return card;
}

function footnote() {
  const { results } = context;
  return el("div.foot", {}, [
    el("span.stub", {
      text:
        "Lowest corrected time wins. Max laps is taken from the boat that sailed furthest. " +
        `Points use the RRS low-point system: a finisher scores its place (tied boats share the average), and any coded boat scores starters + 1 = ${results.penalty}.`,
    }),
  ]);
}

/* ---- corrections -------------------------------------------------------- */

function correctionSheet() {
  const input = context.inputs.find((i) => i.id === correcting);
  if (!input) {
    correcting = null;
    return el("div");
  }

  const existing = correctionFor(input.id, context.events) ?? {};
  const close = () => {
    correcting = null;
    render();
  };

  const laps = field("Laps", {
    type: "number", min: 0, max: 30, inputMode: "numeric", value: input.laps,
  });
  const elapsed = field("Elapsed (h:mm:ss)", {
    class: "text", value: hms(input.elapsedSeconds), inputMode: "numeric",
  });
  const code = selectField("Code", [
    { value: "", label: "— finished —" },
    ...CODE_ORDER.map((c) => ({ value: c, label: c })),
  ], { value: input.code });
  code.select.value = input.code || "";

  return el("div.sheetscrim", {
    onclick: (e) => e.target.classList.contains("sheetscrim") && close(),
  }, [
    el("div.boatsheet", {}, [
      el("div.eyebrow", { text: input.name }),
      el("h2", { text: "Correct before publishing" }),
      el("p.stub", {
        text: "Recorded as a correction event, so the change is on the record alongside what was originally tapped.",
      }),
      laps.node,
      elapsed.node,
      code.node,
      el("div.actions", {}, [
        el("button.btn", {
          type: "button",
          text: "Save correction",
          onclick: async () => {
            const seconds = parseHms(elapsed.input.value);
            if (seconds == null) {
              const sheetBody = document.querySelector(".boatsheet");
              sheetBody?.prepend(notice("Elapsed must look like 0:41:30.", "error"));
              return;
            }
            await log.correct(context.race.id, input.id, {
              laps: Number(laps.input.value),
              elapsed_seconds: seconds,
              code: code.select.value || null,
            });
            correcting = null;
            await reload();
          },
        }),
        el("button.btn.ghost", { type: "button", text: "Cancel", onclick: close }),
      ]),
      Object.keys(existing).length
        ? el("p.stub", { text: "This boat has already been corrected once; a second correction is appended, not replaced." })
        : null,
    ]),
  ]);
}

/** "0:41:30", "41:30" or plain seconds. */
export function parseHms(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const parts = raw.split(":").map((p) => p.trim());
  if (parts.some((p) => p === "" || Number.isNaN(Number(p)))) return null;
  const numbers = parts.map(Number);
  if (numbers.length === 1) return numbers[0];
  if (numbers.length === 2) return numbers[0] * 60 + numbers[1];
  if (numbers.length === 3) return numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
  return null;
}

/* ---- export ------------------------------------------------------------- */

const COLUMNS = [
  { label: "Pos", width: 5, align: "left" },
  { label: "Boat", width: 20, align: "left" },
  { label: "Helm", width: 16, align: "left" },
  { label: "PY", width: 18, align: "left" },
  { label: "Laps", width: 6, align: "right" },
  { label: "Elapsed", width: 12, align: "right" },
  { label: "Lap adj.", width: 12, align: "right" },
  { label: "Corrected", width: 12, align: "right" },
  { label: "Pts", width: 7, align: "right" },
];

function exportRows() {
  const { results } = context;
  const rows = results.scored.map((r) => [
    placeText(r), r.name, r.helm, pyText(r), String(r.laps),
    hms(r.elapsed), hms(r.ladj), hms(r.corrected), formatPoints(r.points),
  ]);
  const muted = [];
  results.out.forEach((r) => {
    muted.push(rows.length);
    rows.push([r.code || "—", r.name, r.helm, pyText(r), "", "", "", "", formatPoints(r.points)]);
  });
  return { rows, muted };
}

function exportPanel() {
  const { race, raceDay, series } = context;
  const meta = [
    `${raceDay.date}`,
    series ? `${series.name} ${series.season}` : null,
    dutyLine(raceDay),
    rd.isTestDay(raceDay) ? "TEST DATA — not a real race" : null,
    `Max laps ${context.results.maxLaps}`,
    `${context.results.starters} starters`,
  ]
    .filter(Boolean)
    .join(" · ");

  const csvBox = el("textarea.copybox", { readonly: true, "aria-label": "Results as CSV" });

  const body = el("div.panel-body", {}, [
    el("div.actions", { style: "padding:0" }, [
      el("button.btn.ghost", {
        type: "button",
        text: "Save as PDF",
        onclick: (event) => {
          const { rows, muted } = exportRows();
          savePdf({
            title: rd.isTestDay(raceDay) ? `${raceLabel(race)} — TEST DATA` : raceLabel(race),
            subtitle: "Portsmouth Yardstick corrected time",
            meta,
            columns: COLUMNS,
            rows,
            muted,
            footer: `${raceDay.date} · generated by Nefyn Sailing Club Race Day`,
            filename: pdfFilename(),
          }, event.currentTarget);
        },
      }),
      el("button.btn.ghost", {
        type: "button",
        text: "Copy CSV",
        onclick: async (event) => {
          // Hold the button itself: currentTarget is null by the time the
          // await resolves, let alone when the timeout fires.
          const button = event.currentTarget;
          const csv = toCsv();
          csvBox.value = csv;
          try {
            await navigator.clipboard.writeText(csv);
            button.textContent = "Copied";
          } catch {
            // No clipboard permission, or an insecure context. Show the text
            // and let the OOD copy it by hand rather than failing silently.
            csvBox.hidden = false;
            csvBox.select();
            button.textContent = "Select and copy";
          }
          setTimeout(() => {
            button.textContent = "Copy CSV";
          }, 1800);
        },
      }),
      el("button.btn.ghost", { type: "button", text: "Print", onclick: () => window.print() }),
    ]),
    csvBox,
  ]);
  csvBox.hidden = true;

  return panel("Share", [body]);
}

function toCsv() {
  const { rows } = exportRows();
  const { race, raceDay } = context;
  const head = COLUMNS.map((c) => c.label);
  const escape = (cell) => (/[",\n]/.test(String(cell)) ? `"${String(cell).replace(/"/g, '""')}"` : String(cell));
  // A title line first: a named trophy race's sheet is the one that gets kept,
  // and a bare grid of numbers does not say which race it was.
  const title = [
    `${raceLabel(race)}`,
    raceDay.date,
    rd.isTestDay(raceDay) ? "TEST DATA — not a real race" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return [[title], head, ...rows].map((row) => row.map(escape).join(",")).join("\n");
}

/** A filename someone can find again: date, race number, and the name. */
function pdfFilename() {
  const { race, raceDay } = context;
  const slug = raceName(race)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `nefyn-${raceDay.date}-r${race.number}${slug ? `-${slug}` : ""}.pdf`;
}

/* ---- publish ------------------------------------------------------------ */

function publishPanel() {
  const { race, results } = context;

  if (race.status === "published") {
    return panel("Published", [
      el("div.panel-body", {}, [
        el("p.stub", {
          text: "These results are final and publicly readable. They now count towards season handicaps.",
        }),
      ]),
      el("div.actions", {}, [
        el("button.btn", { type: "button", text: "Next race →", onclick: () => nextRace() }),
        el("button.btn.ghost", { type: "button", text: "Stand down", onclick: () => navigate("standdown") }),
      ]),
    ]);
  }

  const publish = el("button.btn", {
    type: "button",
    text: "Publish results",
    disabled: !results.scored.length,
    onclick: async () => {
      publish.disabled = true;
      await doPublish();
    },
  });

  return panel("Publish", [
    el("div.panel-body", {}, [
      el("p.stub", {
        text: "Publishing freezes the race, makes it readable on the club website, and feeds the winner's season handicap. Make any corrections first.",
      }),
    ]),
    el("div.actions", {}, [publish]),
  ]);
}

async function doPublish() {
  const { race, results, raceDay, series } = context;
  const publishedAt = db.nowIso();

  await rd.setRaceStatusIfEarlier(race, "published", {
    status: "published",
    published_at: publishedAt,
  });

  /* Record the win locally as well, so the same-day handicap rule works with
     no signal — the server view cannot be consulted on the beach. */
  /* A ten-second test race must never move a real helm's season handicap. */
  const winner = rd.isTestDay(raceDay) ? null : results.scored[0];
  if (winner && !winner.tied) {
    const entry = context.entries.find((e) => e.id === winner.id);
    if (entry) {
      await rd.recordLocalWin({
        raceId: race.id,
        helmId: entry.helm_id,
        season: rd.seasonForRace({ ...race, race_date: raceDay.date }, series),
        publishedAt,
      });
    }
  }

  await reload();
}

async function nextRace() {
  const races = await rd.racesForDay(context.raceDay.id);
  const next = races.find((r) => r.status === "setup");
  // The day planned one race and the wind held: add another rather than
  // sending the OOD back to setup.
  if (!next) await rd.addRace(context.raceDay);
  navigate("signon");
}
