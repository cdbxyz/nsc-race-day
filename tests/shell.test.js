/* The service worker's shell list and cache version must match the files on
 * disk. If they drift, phones keep serving a stale app from cache — the kind
 * of bug you only discover on the beach.
 *
 * The pre-commit hook in .githooks/ normally keeps this current; this test is
 * the backstop for when the hook was never installed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, unlink, mkdir, rm } from "node:fs/promises";

import { stamp } from "../tools/stamp-sw.mjs";

test("sw.js is stamped for the current shell files", async () => {
  const result = await stamp({ check: true });
  assert.equal(result.stale, undefined, "sw.js is out of date — run `npm run stamp`");
});

test("every shell file on disk is in the precache list", async () => {
  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  for (const path of ["./index.html", "./css/app.css", "./js/app.js", "./js/update.js"]) {
    assert.ok(sw.includes(`"${path}"`), `${path} missing from SHELL`);
  }
});

/* ---------------------------------------------------------------------------
 * The shell list is DISCOVERED, never maintained by hand.
 *
 * img/ was missing from the walk for several weeks. The mast logo and all
 * four start-sequence flags loaded from the network, which meant broken
 * images on a beach with no signal — the exact condition the app exists for.
 *
 * The fix was to add img/ to the directories that get walked, NOT to add
 * those particular files to a list. This test is the difference between the
 * two: it drops a brand-new file into img/ and requires the stamper to find
 * it. A committee volunteer replacing the placeholder flags, or dropping in
 * a real club logo, must not also have to know about a list in a build tool.
 * ------------------------------------------------------------------------ */

test("a new file dropped into img/ is precached without anyone being told", async () => {
  const asset = new URL("../img/__drill-probe.svg", import.meta.url);
  const nested = new URL("../img/__drill-nested/", import.meta.url);
  const nestedAsset = new URL("../img/__drill-nested/deep.svg", import.meta.url);
  const swPath = new URL("../sw.js", import.meta.url);
  const original = await readFile(swPath, "utf8");

  try {
    await writeFile(asset, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await mkdir(nested, { recursive: true });
    await writeFile(nestedAsset, '<svg xmlns="http://www.w3.org/2000/svg"/>');

    // Exactly what `npm run stamp` does.
    await stamp();
    const stamped = await readFile(swPath, "utf8");

    assert.ok(
      stamped.includes('"./img/__drill-probe.svg"'),
      "a new file in img/ must appear in SHELL after a stamp"
    );
    assert.ok(
      stamped.includes('"./img/__drill-nested/deep.svg"'),
      "and the walk must recurse, the way img/flags/ relies on"
    );
    assert.notEqual(stamped, original, "and the cache version must move with it");
  } finally {
    await unlink(asset).catch(() => {});
    await rm(nested, { recursive: true, force: true });
    // Put sw.js back exactly as it was, so the suite leaves no trace.
    await writeFile(swPath, original);
  }
});

test("the walked directories cover every asset kind the app ships", async () => {
  const tool = await readFile(new URL("../tools/stamp-sw.mjs", import.meta.url), "utf8");
  const dirs = tool.match(/const DIRECTORIES = \[([^\]]*)\]/)?.[1] ?? "";
  for (const dir of ["css", "js", "fonts", "img"]) {
    assert.match(dirs, new RegExp(`"${dir}"`), `${dir}/ must be walked, not hand-listed`);
  }
});

test("the worker does not skip waiting on install", async () => {
  // A new build must sit in "waiting" until the OOD taps the update prompt.
  // Skipping the wait during install would swap the app out mid-race.
  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  const code = sw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
  const installBlock = code.slice(
    code.indexOf('addEventListener("install"'),
    code.indexOf('addEventListener("activate"')
  );
  assert.ok(installBlock.length > 0, "could not find the install handler");
  assert.ok(!installBlock.includes("skipWaiting"), "install must not skip the waiting phase");
});

/* ---------------------------------------------------------------------------
 * Seed migrations for committee-editable data are insert-only.
 *
 * 008 used to replace the whole `items` array on conflict, so a re-run would
 * have silently discarded whatever wording the committee had written in the
 * dashboard. After first deploy the dashboard is the source of truth.
 * ------------------------------------------------------------------------ */

test("the checklist seed can never overwrite an edited template", async () => {
  const sql = await readFile(new URL("../supabase/migrations/008_checklist_templates.sql", import.meta.url), "utf8");
  const code = sql.replace(/^--.*$/gm, "");

  assert.ok(!/do\s+update/i.test(code), "a seed must not replace an existing row");
  assert.match(code, /on conflict \(id\) do nothing/i);
  assert.match(code, /where not exists/i, "and must skip a kind that already exists");
});
