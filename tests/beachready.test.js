/* Failure honesty: storage, sessions and screens.
 *
 * Each of these fails silently by default, and each silent failure costs a
 * race day. A write that could not find disk space looks exactly like one
 * that worked. An expired session looks like a slow network. A phone that
 * will not stay awake looks like a phone that is broken.
 */

import "fake-indexeddb/auto";
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import * as db from "../js/db.js";
import { createSync } from "../js/sync.js";
import { createSupabaseBackend } from "../js/backend.js";
import {
  isQuotaError,
  noteQuotaError,
  clearQuotaError,
  storageWarning,
  storageState,
  requestPersistence,
  resetStorageState,
  onStorageChange,
} from "../js/storage.js";
import { sleepWarning, isSupported } from "../js/wakelock.js";

beforeEach(async () => {
  await db.clearAll();
  resetStorageState();
});
after(() => db.closeDB());

/* ---- storage quota ------------------------------------------------------ */

test("a quota error is recognised however the browser spells it", () => {
  assert.equal(isQuotaError({ name: "QuotaExceededError" }), true);
  assert.equal(isQuotaError({ name: "NS_ERROR_DOM_QUOTA_REACHED" }), true, "Firefox");
  assert.equal(isQuotaError({ code: 22 }), true, "older WebKit");
  assert.equal(isQuotaError({ message: "The quota has been exceeded." }), true);

  assert.equal(isQuotaError(null), false);
  assert.equal(isQuotaError(new Error("network unavailable")), false);
});

test("a full disk is stated in words an OOD can act on", () => {
  assert.equal(storageWarning(), null, "nothing wrong, nothing said");

  noteQuotaError(new Error("QuotaExceededError"));
  const warning = storageWarning();
  assert.match(warning, /OUT OF STORAGE/);
  assert.match(warning, /may not have been saved/, "says what it costs");
  assert.match(warning, /Do not clear this app's data/, "and what not to do");
});

test("the warning is sticky until a write actually succeeds", () => {
  /* It must not scroll away with the tap that caused it: some taps did not
     land, and the OOD needs to know that after the moment has passed. */
  noteQuotaError(new Error("QuotaExceededError"));
  assert.ok(storageWarning());
  assert.ok(storageState().quotaError);

  clearQuotaError();
  assert.equal(storageWarning(), null);
});

test("subscribers hear about a full disk immediately", () => {
  const seen = [];
  const off = onStorageChange((s) => seen.push(Boolean(s.quotaError)));
  noteQuotaError(new Error("QuotaExceededError"));
  clearQuotaError();
  assert.deepEqual(seen, [true, false]);
  off();
});

test("a successful write clears a stale quota warning", async () => {
  noteQuotaError(new Error("QuotaExceededError"));
  assert.ok(storageWarning());

  await db.localWrite("classes", { id: db.newId(), name: "Solo", base_py: 1142 });
  assert.equal(storageWarning(), null, "the phone has room again");
});

test("localWrite surfaces a quota failure rather than swallowing it", async () => {
  const source = await readFile(new URL("../js/db.js", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("export async function localWrite"));
  assert.match(fn.slice(0, 1400), /isQuotaError\(err\)\)\s*noteQuotaError/);
  assert.match(fn.slice(0, 1400), /throw err/, "and still fails loudly to the caller");
});

test("persistence is requested, and a refusal is survivable", async () => {
  // No navigator.storage in node: the app must not fall over, just record it.
  const granted = await requestPersistence();
  assert.equal(typeof granted, "boolean");
  assert.equal(storageState().persisted, granted);
});

test("persistence is asked for on every boot, not once", async () => {
  /* The answer changes the moment the app is installed to the home screen,
     and asking again is free. */
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /requestPersistence\(\)/);
  const boot = app.slice(app.indexOf("async function boot()"));
  assert.ok(boot.includes("requestPersistence()"), "inside boot");
});

/* ---- a session that expires mid-day ------------------------------------- */

function offlineSync({ signedIn }) {
  const backend = createSupabaseBackend({
    upsert: async () => {},
    remove: async () => {},
    isSignedIn: () => signedIn,
  });
  return createSync({ backend, setTimeout: () => 0, clearTimeout: () => {} });
}

test("a signed-out phone keeps every row and asks for the PIN", async () => {
  await db.localWrite("classes", { id: db.newId(), name: "Solo", base_py: 1142 });
  const sync = offlineSync({ signedIn: false });

  const status = await sync.flush();

  assert.equal(status.pending, 1, "nothing was dropped");
  assert.equal(status.needsAuth, true, "and the app knows to ask");
  assert.equal(status.blocked, 0, "not quarantined — it is a PIN, not a bad row");
});

test("signing back in loses nothing and needs no repair", async () => {
  await db.localWrite("classes", { id: db.newId(), name: "Solo", base_py: 1142 });

  const out = offlineSync({ signedIn: false });
  await out.flush();
  assert.equal((await db.allOutbox()).length, 1);

  // Same rows, same order, now with a session.
  const back = offlineSync({ signedIn: true });
  const status = await back.flush();
  assert.equal(status.pending, 0, "drained on the next flush");
  assert.equal(status.needsAuth, false);
});

test("needsAuth is specific to being signed out, not to any failure", async () => {
  await db.localWrite("classes", { id: db.newId(), name: "Solo", base_py: 1142 });
  const backend = {
    name: "supabase",
    push: async () => {
      throw new Error("network unavailable");
    },
  };
  const sync = createSync({ backend, setTimeout: () => 0, clearTimeout: () => {} });

  const status = await sync.flush();
  assert.equal(status.pending, 1);
  assert.equal(status.needsAuth, false, "a flat battery on the router is not a PIN problem");
});

test("the sign-out bar only appears when something is actually waiting", async () => {
  /* Nagging for a PIN with an empty outbox would train the OOD to ignore it,
     which is exactly when it matters. */
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  const fn = app.slice(app.indexOf("function wireAuthBar"));
  assert.match(fn.slice(0, 900), /status\.needsAuth\).*&&.*status\.pending > 0/s);
});

/* ---- the screen --------------------------------------------------------- */

test("a browser with no Wake Lock is told what to do instead", () => {
  // node has no navigator.wakeLock, which is the unsupported case.
  assert.equal(isSupported(), false);
  const warning = sleepWarning();
  assert.match(warning, /may sleep/);
  assert.match(warning, /Nothing is lost/, "because timers are computed, not counted");
  assert.match(warning, /Auto-Lock/, "and the actual fix");
});

test("there is no battery-burning no-sleep hack", async () => {
  /* The video trick keeps the screen on by playing a hidden loop, which costs
     the one resource that actually ends race days. */
  const source = await readFile(new URL("../js/wakelock.js", import.meta.url), "utf8");
  assert.ok(!/<video|createElement\("video"\)|\.play\(\)/.test(source));
});

/* ---- iOS shell requirements --------------------------------------------- */

test("the home-screen icon is a real PNG, because iOS ignores SVG", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const tag = html.match(/<link rel="apple-touch-icon"[^>]*>/)?.[0] ?? "";
  assert.match(tag, /\.png/, "an SVG here shows a grey page thumbnail on iOS");
  assert.match(tag, /180x180/);
});

test("the icons are precached, so an installed app is not blank offline", async () => {
  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  assert.match(sw, /img\/apple-touch-icon\.png/);
  assert.match(sw, /img\/nsc-logo\.svg/, "the mast logo too");
  assert.match(sw, /img\/flags\/class\.svg/, "and the start-sequence flags");
});

test("the viewport opts into the safe area", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /apple-mobile-web-app-capable/);
});

test("layout never uses 100vh, which lies on iOS Safari", async () => {
  /* 100vh includes the browser chrome that scrolls away, so a full-height
     element is taller than the screen and the bottom of it is unreachable. */
  const css = await readFile(new URL("../css/app.css", import.meta.url), "utf8");
  assert.ok(!/height:\s*100vh/.test(css));
});

test("the safe area is actually used, not merely declared", async () => {
  const css = await readFile(new URL("../css/app.css", import.meta.url), "utf8");
  assert.match(css, /--safe-t:env\(safe-area-inset-top/);
  assert.ok(
    (css.match(/var\(--safe-[tblr]\)/g) ?? []).length >= 4,
    "top for the mast, bottom for anything fixed"
  );
});
