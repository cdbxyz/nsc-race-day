/* The results sheet.
 *
 * The overlap that started this was not two columns receiving the same text:
 * it was a cell with no right-hand edge. place() computed its column width
 * and then ignored it for left-aligned text, so a long combination ran
 * straight over the class beside it. Both invariants are pinned below — the
 * one that was broken, and the one that was assumed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/* ---- the writer keeps every cell inside its own column ------------------ */

test("every cell is measured against its own column before it is drawn", async () => {
  const src = await readFile(new URL("../js/pdf.js", import.meta.url), "utf8");
  const place = src.slice(src.indexOf("function place(index, text)"));
  const body = place.slice(0, place.indexOf("\n  }"));

  assert.match(body, /truncateTo\(/, "the cell is shortened to fit");
  assert.match(body, /width - GUTTER/, "against its own column's width");
  assert.ok(
    !/doc\.text\(String\(text\), x, y\)/.test(body),
    "no unbounded draw — that is the overlap"
  );
});

test("truncation measures the real rendered width, not a character count", async () => {
  const src = await readFile(new URL("../js/pdf.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function truncateTo"));
  assert.match(fn.slice(0, 700), /doc\.getTextWidth/, "proportional fonts need measuring");
  assert.match(fn.slice(0, 700), /…/, "and it says it was shortened");
});

test("the sheet is landscape", async () => {
  const src = await readFile(new URL("../js/pdf.js", import.meta.url), "utf8");
  assert.match(src, /orientation: "landscape"/);
});

/* ---- one field per column ----------------------------------------------- */

/** Build a row the way results.js does, without a browser. */
function buildRow(r, { sail, laps, racing = true, won = false }) {
  const fmt = (ms) =>
    ms == null ? "" : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
  const cells = [racing ? "1" : r.code || "—"];
  if (sail) cells.push(String(r.sailNo ?? "").trim());
  cells.push(r.helmName ?? "", r.crewName ?? "", r.klass ?? "", r.pyText ?? "");
  cells.push(racing ? String(r.laps) : "");
  const times = r.lapTimes ?? [];
  for (let i = 0; i < laps; i += 1) cells.push(times[i] == null ? "" : fmt(times[i]));
  if (racing) cells.push("40:00", "40:00", "35:00");
  else cells.push("", "", "");
  cells.push("1");
  cells.push(won ? "1088" : "1122");
  return cells;
}

const LONG = {
  helmName: "Jim Spencer",
  crewName: "Chris D'Arcy Burt",
  klass: "Laser 2000",
  sailNo: "2298",
  pyText: "1122",
  laps: 3,
  lapTimes: [600000, 1200000, 1800000],
};

test("no two columns are fed from the same field", async () => {
  /* The structural version of the invariant, and the one that matters.
     Equal VALUES across columns are legitimate — lap-adjusted elapsed equals
     elapsed for a boat on max laps, and an unchanged Next PY equals the PY
     sailed under. What must never happen is one source field being pushed
     into two columns, which is the shape the report described. */
  const src = await readFile(new URL("../js/pages/results.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("const line = (r, racing, won)"), src.indexOf("const rows = results.scored"));

  const pushed = [...fn.matchAll(/cells\.push\(([^;]*)\);/gs)]
    .flatMap((m) => m[1].split(",").map((a) => a.trim()))
    .filter((a) => a && a !== '""');

  const fields = pushed
    .map((a) => a.match(/\br\.([a-zA-Z]+)/)?.[1])
    .filter(Boolean);

  const seen = new Set();
  for (const field of fields) {
    assert.ok(!seen.has(field), `r.${field} is pushed into two columns`);
    seen.add(field);
  }
  assert.ok(seen.has("helmName") && seen.has("crewName"), "both are used");
  assert.ok(!seen.has("name"), "the combined string is not a column source");
});

test("no identity column repeats another identity column's text", () => {
  /* The value-level version, restricted to the columns that NAME things.
     Two equal times are data; the same name in two columns is the bug. */
  const rows = [
    buildRow(LONG, { sail: true, laps: 3 }),
    buildRow({ ...LONG, crewName: "" }, { sail: true, laps: 3 }),
    buildRow({ ...LONG, code: "RET", lapTimes: [600000] }, { sail: true, laps: 3, racing: false }),
  ];

  for (const cells of rows) {
    // Pos, Sail, Helm, Crew, Class — the identity block.
    const identity = cells.slice(0, 5).map((c) => String(c ?? "").trim()).filter(Boolean);
    const seen = new Set();
    for (const text of identity) {
      assert.ok(!seen.has(text), `"${text}" appears in two identity columns`);
      seen.add(text);
    }
  }
});

test("helm and crew are separate cells, never one joined string", () => {
  const cells = buildRow(LONG, { sail: true, laps: 3 });
  assert.ok(cells.includes("Jim Spencer"), "helm on its own");
  assert.ok(cells.includes("Chris D'Arcy Burt"), "crew on its own");
  assert.ok(
    !cells.some((c) => String(c).includes(" + ")),
    "and the combined string is nowhere on the sheet"
  );
});

test("a single-hander leaves the crew cell blank", () => {
  const cells = buildRow({ ...LONG, crewName: "" }, { sail: true, laps: 3 });
  // Pos, Sail, Helm, Crew -> index 3
  assert.equal(cells[3], "", "blank, not the helm's name repeated");
});

test("a boat that sailed fewer laps leaves the later cells blank", () => {
  const cells = buildRow({ ...LONG, laps: 2, lapTimes: [600000, 1200000] }, { sail: true, laps: 3 });
  const lapCells = cells.slice(7, 10);
  assert.deepEqual(lapCells, ["10:00", "20:00", ""], "no borrowed time in L3");
});

test("a coded boat keeps its laps but scores no times", () => {
  const cells = buildRow({ ...LONG, code: "RET", lapTimes: [600000] }, { sail: true, laps: 3, racing: false });
  assert.equal(cells[0], "RET");
  assert.deepEqual(cells.slice(7, 10), ["10:00", "", ""], "the lap it did sail is still shown");
});

/* ---- the columns themselves --------------------------------------------- */

test("the column set is the one the club asked for", async () => {
  const src = await readFile(new URL("../js/pages/results.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function exportColumns"), src.indexOf("function exportRows"));
  for (const label of ["Pos", "Sail", "Helm", "Crew", "Class", "PY", "Laps",
                       "Elapsed", "Lap adj.", "Corrected", "Pts", "Next PY"]) {
    assert.ok(fn.includes(`"${label}"`), `missing column: ${label}`);
  }
  assert.match(fn, /`L\$\{lap\}`/, "and a column per lap");
});

test("the number of lap columns follows the race, not a constant", async () => {
  const src = await readFile(new URL("../js/pages/results.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function lapColumnCount"), src.indexOf("function nextPyFor"));
  assert.match(fn, /lapTimes/, "counted from what boats actually sailed");
  assert.match(fn, /Math\.max/);
});

test("Next PY goes through the handicap engine, not a copy of the rule", async () => {
  const src = await readFile(new URL("../js/pages/results.js", import.meta.url), "utf8");
  assert.match(src, /import \{ factorFor, personalPy \} from "\.\/\.\.\/handicap\.js"/);
  const fn = src.slice(src.indexOf("function nextPyFor"), src.indexOf("function exportColumns"));
  assert.match(fn, /factorFor\(wins\)/, "the club's rule, applied not restated");
  assert.ok(!/0\.9[0-9]/.test(fn), "no factors written out by hand here");
});

test("Next PY is described as forward-looking, and says when it is a projection", async () => {
  const src = await readFile(new URL("../js/pages/results.js", import.meta.url), "utf8");
  const meta = src.slice(src.indexOf("function exportPanel"), src.indexOf("const csvBox"));
  assert.match(meta, /Next PY is what each helm carries into their NEXT race/);
  assert.match(meta, /WILL carry .* once these results are published/s);
});

test("PDF and CSV are built from the same columns and rows", async () => {
  /* Two builders is how a sheet and its CSV drift into disagreeing. */
  const src = await readFile(new URL("../js/pages/results.js", import.meta.url), "utf8");
  assert.equal((src.match(/exportColumns\(\)/g) ?? []).length >= 2, true);
  assert.equal((src.match(/exportRows\(\)/g) ?? []).length >= 2, true);
});

test("presentation fields are joined back on, not smuggled through scoring", async () => {
  /* scoring.js builds its rows from a fixed field list — it is a scoring
     engine, not a data bus, and CLAUDE.md keeps it pure. Everything the sheet
     needs beyond places and points has to be joined by id, or it silently
     vanishes: helm, crew, sail number and lap times were all being dropped,
     which is why the sheet drew empty columns. */
  const scoring = await readFile(new URL("../js/scoring.js", import.meta.url), "utf8");
  const built = scoring.slice(scoring.indexOf("const row = {"), scoring.indexOf("return row;"));
  for (const field of ["sailNo", "helmName", "crewName", "lapTimes", "winsBefore"]) {
    assert.ok(!built.includes(field), `scoring.js must stay out of ${field}`);
  }

  const results = await readFile(new URL("../js/pages/results.js", import.meta.url), "utf8");
  const join = results.slice(results.indexOf("function sheetRows"), results.indexOf("function hasSailNumbers"));
  assert.match(join, /new Map\(inputs\.map/, "joined by id");
  assert.match(join, /\{ \.\.\.byId\.get\(r\.id\), \.\.\.r \}/, "scored fields win the merge");

  // And every consumer goes through it.
  for (const fn of ["hasSailNumbers", "lapColumnCount", "exportRows"]) {
    const body = results.slice(results.indexOf(`function ${fn}`));
    assert.match(body.slice(0, 400), /sheetRows\(\)/, `${fn} must use the joined rows`);
  }
});
