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
  storageSupport,
  checkPersisted,
  formatBytes,
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
  assert.equal(granted, false, "nothing was granted");
});

test("\"not supported\" is reported differently from \"refused\"", async () => {
  /* They collapse to the same boolean and mean very different things: one is
     an old browser where the question does not exist, the other is a browser
     that considered it and said no — and only the second costs a race day.
     The dev panel has to be able to tell an OOD which one they are looking
     at, because the fix (install to the home screen) only helps the second. */
  assert.equal(storageSupport().persist, false, "node has no storage API");

  await requestPersistence();
  assert.equal(storageState().persisted, null, "unknown, not a refusal");

  assert.equal(await checkPersisted(), null, "and reading it does not invent an answer");
});

test("checking persistence does not request it", async () => {
  /* Drill step B2 is "observe the result on a real device". Observing must
     not change it, or the check reports its own side effect. */
  const source = await readFile(new URL("../js/storage.js", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("export async function checkPersisted"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.ok(!/\.persist\(\)/.test(body), "checkPersisted must never call persist()");
  assert.match(body, /storage\.persisted\(\)/);
});

test("bytes are formatted for a phone screen, not a spreadsheet", () => {
  assert.equal(formatBytes(null), "unknown");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(790_528), "772 KB");
  assert.equal(formatBytes(10_995_116_277_760), "10 TB", "no false precision at double digits");
  assert.equal(formatBytes(1_073_741_824), "1.0 GB");
});

test("the dev panel can observe storage without a network or a race day", async () => {
  // B2 has to be runnable on a phone standing in a car park.
  const source = await readFile(new URL("../js/pages/dev.js", import.meta.url), "utf8");
  assert.match(source, /checkPersisted/);
  assert.match(source, /refreshEstimate/);
  assert.match(source, /requestPersistence/);
  assert.match(source, /display-mode: standalone/, "and says whether it is installed");
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

/* ---- readable in July sun -----------------------------------------------
 *
 * WCAG AA (4.5:1) is a floor, not a target. --slate #5F6E8C is 5.1:1 on
 * white: legal, and washed out on a phone held at arm's length in direct
 * sunlight. Anything an OOD READS TO ACT ON mid-race must be well above it.
 *
 * These pin the palette and the rule, so a later tidy-up cannot quietly put
 * the grey back on the lap counter.
 */

/** WCAG relative-luminance contrast ratio between two hex colours. */
function contrastRatio(a, b) {
  const lum = (hex) => {
    const [r, g, b2] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b2);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("the palette is what we think it is", () => {
  assert.ok(Math.abs(contrastRatio("#5F6E8C", "#FFFFFF") - 5.13) < 0.05, "--slate");
  assert.ok(Math.abs(contrastRatio("#1B3B76", "#FFFFFF") - 10.86) < 0.05, "--hull");
  assert.ok(Math.abs(contrastRatio("#0A1B3D", "#FFFFFF") - 16.98) < 0.05, "--ink");
});

test("mid-race text an OOD acts on is never the hint grey", async () => {
  const css = await readFile(new URL("../css/app.css", import.meta.url), "utf8");

  /* .boatmeta is "Lap 2 of 3" on the live card — read while a boat crosses.
     .railtime and .railsplits are the finished rail. .cmeta and .celap are
     the results sheet's own numbers. */
  for (const selector of [".boatmeta", ".railtime", ".railsplits", ".raillabel", ".cmeta", ".celap"]) {
    const start = css.indexOf(`\n${selector}{`);
    assert.ok(start > 0, `${selector} not found`);
    const rule = css.slice(start, css.indexOf("}", start));
    assert.ok(
      !rule.includes("var(--slate)"),
      `${selector} must not use --slate: 5.1:1 is legal and unreadable in sun`
    );
  }
});

test("no critical text is smaller than 10px", async () => {
  const css = await readFile(new URL("../css/app.css", import.meta.url), "utf8");
  for (const selector of [".boatmeta", ".railtime", ".railsplits", ".cmeta", ".celap"]) {
    const start = css.indexOf(`\n${selector}{`);
    const rule = css.slice(start, css.indexOf("}", start));
    const size = rule.match(/font-size:\s*([\d.]+)rem/)?.[1];
    if (size) {
      assert.ok(Number(size) * 16 >= 10, `${selector} at ${Number(size) * 16}px is too small to read wet`);
    }
  }
});

test("every tap target clears 44px in both directions", async () => {
  /* Height alone is not enough: the footer nav links were 44px tall and 35px
     wide, and "Correct" on the results sheet was 38px tall. */
  const css = await readFile(new URL("../css/app.css", import.meta.url), "utf8");

  const footRule = css.slice(css.indexOf("\n.foot a{"), css.indexOf("}", css.indexOf("\n.foot a{")));
  assert.match(footRule, /min-height:44px/);
  assert.match(footRule, /min-width:44px/);

  const correct = css.slice(css.indexOf("\n.correctbtn{"), css.indexOf("}", css.indexOf("\n.correctbtn{")));
  assert.match(correct, /min-height:44px/);
});

/* ---- [hidden] must actually hide ----------------------------------------
 *
 * The browser's own rule for [hidden] is display:none, but ANY class selector
 * outranks it. .authbar{display:flex} and .testmodebar{display:flex} therefore
 * rendered 64px of empty coloured strip on every page while the element was,
 * as far as the DOM and every hidden-attribute check was concerned, hidden.
 *
 * Both shipped that way, and nothing caught it: contrast audits see no text,
 * and probes that read `.hidden` see `true`. Only a screenshot showed it.
 */

test("a global [hidden] rule beats any display set on a class", async () => {
  const css = await readFile(new URL("../css/app.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\[hidden\]\{display:none ?!important\}/,
    "without this, any bar given display:flex ignores its hidden attribute"
  );
});

test("every shell bar that sets display is covered by it", async () => {
  /* The rule above is the fix; this is the list of things that depended on
     it, so a new bar with display:flex is caught by the same reasoning. */
  const css = await readFile(new URL("../css/app.css", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  const hiddenByDefault = [...html.matchAll(/<div class="([\w-]+)" id="([\w-]+)"[^>]*\shidden/g)];
  assert.ok(hiddenByDefault.length >= 4, "found the shell bars");

  const globalRule = /\[hidden\]\{display:none ?!important\}/.test(css);
  for (const [, className] of hiddenByDefault) {
    const rule = css.slice(css.indexOf(`\n.${className}{`), css.indexOf("}", css.indexOf(`\n.${className}{`)));
    if (/display:\s*(flex|grid|block|inline)/.test(rule)) {
      assert.ok(globalRule, `.${className} sets display and would ignore [hidden]`);
    }
  }
});
