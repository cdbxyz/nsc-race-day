/* The service worker's shell list and cache version must match the files on
 * disk. If they drift, phones keep serving a stale app from cache — the kind
 * of bug you only discover on the beach.
 *
 * The pre-commit hook in .githooks/ normally keeps this current; this test is
 * the backstop for when the hook was never installed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
