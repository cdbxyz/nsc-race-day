/* The racing flags are matched against real bunting, so they have to be real.
 *
 * These are the constraints the artwork has to keep: the box the app draws
 * them in, flat colour with no effects, nothing touching the tile border, and
 * a hem on any flag with white at its edge — without which a white flag on a
 * translucent white tile has no edge at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const FLAGS = ["class", "p", "ap", "start"];
const read = (name) =>
  readFile(new URL(`../img/flags/${name}.svg`, import.meta.url), "utf8");

test("every flag uses the box the app draws it in", async () => {
  for (const name of FLAGS) {
    const svg = await read(name);
    assert.match(svg, /viewBox="0 0 144 96"/, `${name}: 3:2, as the tile is`);
  }
});

test("flat colour only — no gradients, filters, images or text", async () => {
  for (const name of FLAGS) {
    const svg = await read(name);
    assert.ok(!/<text|<tspan/i.test(svg), `${name}: no text elements`);
    assert.ok(!/Gradient|<filter|filter=|<image|url\(#.*[Gg]radient/i.test(svg), `${name}: flat only`);
    assert.ok(!/opacity="0?\.\d/i.test(svg), `${name}: no part-transparent fills`);
  }
});

test("nothing is painted in the outer 3% of the box", async () => {
  /* They sit on a bordered tile; artwork against the edge looks like a
     mistake and clips on a rounded corner. 3% of 144 is 4.3. */
  for (const name of FLAGS) {
    const svg = await read(name);
    const coords = [...svg.matchAll(/(?:x|y)="([\d.]+)"/g)].map((m) => Number(m[1]));
    for (const value of coords) {
      assert.ok(value >= 4.3 || value === 0, `${name}: ${value} is inside the safe margin`);
    }
    // Path points too.
    for (const match of svg.matchAll(/[ML]\s*([\d.]+)\s+([\d.]+)/g)) {
      assert.ok(Number(match[1]) >= 4.3, `${name}: path x ${match[1]}`);
      assert.ok(Number(match[2]) >= 4.3, `${name}: path y ${match[2]}`);
    }
  }
});

test("the background is transparent — the tile shows through", async () => {
  for (const name of FLAGS) {
    const svg = await read(name);
    // No full-bleed rect covering the whole viewBox.
    assert.ok(
      !/<rect[^>]*x="0"[^>]*y="0"[^>]*width="144"[^>]*height="96"/.test(svg),
      `${name}: nothing may fill the whole box`
    );
  }
});

/* ---- the flags themselves ----------------------------------------------- */

test("H is white on the hoist and red on the fly", async () => {
  /* Nefyn's warning signal, confirmed by the club. Hoist is the LEFT side —
     the half next to the pole — and getting that backwards would have an OOD
     flying the flag reversed. */
  const svg = await read("class");
  const white = /<rect x="5" y="5" width="67" height="86" fill="#FFFFFF"\/>/;
  const red = /<rect x="72" y="5" width="67" height="86" fill="#C8102E"\/>/;
  assert.match(svg, white, "white half at the hoist");
  assert.match(svg, red, "red half at the fly");
  assert.ok(svg.indexOf('fill="#FFFFFF"') < svg.indexOf('fill="#C8102E"'), "white first");
});

test("P is blue with an enclosed white rectangle", async () => {
  const svg = await read("p");
  assert.match(svg, /fill="#0033A0"/, "code-flag blue, not the app navy");
  assert.match(svg, /<rect x="40" y="27" width="64" height="42" fill="#FFFFFF"/);
});

test("AP is a tapered pennant, not a rectangle", async () => {
  /* The taper is half of how it is recognised at distance. */
  const svg = await read("ap");
  assert.match(svg, /<path d="M5 5 L139 37 L139 59 L5 91 Z"/, "tapered outline");
  const stripes = [...svg.matchAll(/fill="#(C8102E|FFFFFF)"/g)].map((m) => m[1]);
  assert.deepEqual(
    stripes,
    ["C8102E", "FFFFFF", "C8102E", "FFFFFF", "C8102E"],
    "five vertical stripes, red at both edges"
  );
});

test("a flag with white at its edge carries a hem", async () => {
  /* Without it the white half of H, and the white stripes of AP, have no
     edge at all on the translucent white tile. */
  for (const name of ["class", "ap"]) {
    const svg = await read(name);
    assert.match(svg, /stroke="#3A3A3A"/, `${name}: neutral hem`);
  }
  // P's white is enclosed by blue, so it needs none of its own.
  const p = await read("p");
  assert.ok(!/stroke="#3A3A3A"/.test(p), "P needs no hem — its white is enclosed");
});

test("the start mark is not dressed as a racing signal", async () => {
  /* There is no RRS flag meaning "started" — at the gun the class flag comes
     down. Anything that looked like bunting here would be inviting an OOD to
     fly something that does not exist. */
  const svg = await read("start");
  assert.match(svg, /fill="#007A33"/, "signal green");
  assert.match(svg, /<path d="M58 27 L96 48 L58 69 Z"/, "a play mark, not a device");
  assert.match(svg, /NOT a racing signal/, "and the file says so");
});

test("all four are precached, so they draw with no signal", async () => {
  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  for (const name of FLAGS) {
    assert.match(sw, new RegExp(`"\\./img/flags/${name}\\.svg"`), `${name} missing from SHELL`);
  }
});
