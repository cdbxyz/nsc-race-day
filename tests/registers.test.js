/* The pasted-class-list parser.
 *
 * This is a one-off seeding path a committee volunteer uses once, from
 * whatever the club's PY list happens to look like — a spreadsheet export, an
 * email, a copied web table. It has to be forgiving without being careless:
 * silently misreading a PY would mis-score every race that class ever sails.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parseClassCsv } from "../js/registers.js";

test("the straightforward case", () => {
  const { rows, errors } = parseClassCsv("Laser 2000,1122\nWayfarer,1100\nHeron,1345");
  assert.deepEqual(rows, [
    { name: "Laser 2000", base_py: 1122 },
    { name: "Wayfarer", base_py: 1100 },
    { name: "Heron", base_py: 1345 },
  ]);
  assert.deepEqual(errors, []);
});

test("blank lines and stray whitespace are ignored", () => {
  const { rows, errors } = parseClassCsv("\n  Laser 2000 , 1122 \n\n  Heron,1345\n\n");
  assert.deepEqual(rows.map((r) => r.name), ["Laser 2000", "Heron"]);
  assert.deepEqual(errors, []);
});

test("a header row is skipped rather than reported as a problem", () => {
  const { rows, errors } = parseClassCsv("Class,PY\nLaser 2000,1122");
  assert.equal(rows.length, 1);
  assert.deepEqual(errors, [], "a header is expected, not an error");
});

test("semicolons and tabs work as well as commas", () => {
  assert.equal(parseClassCsv("Laser 2000;1122").rows[0].base_py, 1122);
  assert.equal(parseClassCsv("Laser 2000\t1122").rows[0].base_py, 1122);
});

test("a class name containing a comma survives", () => {
  // Splitting on the last separator, not the first.
  const { rows } = parseClassCsv("Laser 2000, Mk2,1122");
  assert.deepEqual(rows, [{ name: "Laser 2000, Mk2", base_py: 1122 }]);
});

test("a quoted name is unwrapped", () => {
  const { rows } = parseClassCsv('"Laser 2000, Mk2",1122');
  assert.equal(rows[0].name, "Laser 2000, Mk2");
});

test("a line without a PY is reported, not guessed at", () => {
  const { rows, errors } = parseClassCsv("Laser 2000\nHeron,1345");
  assert.equal(rows.length, 1, "the good line still lands");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Line 1/);
});

test("a PY that is not a number is refused", () => {
  const { rows, errors } = parseClassCsv("Laser 2000,about 1100");
  assert.equal(rows.length, 0, "better to refuse than to mis-score every race");
  assert.match(errors[0], /not a PY/);
});

test("a zero or negative PY is refused", () => {
  assert.equal(parseClassCsv("Laser 2000,0").rows.length, 0);
  assert.equal(parseClassCsv("Laser 2000,-5").rows.length, 0);
});

test("a decimal PY is rounded to a whole number", () => {
  assert.equal(parseClassCsv("Laser 2000,1122.4").rows[0].base_py, 1122);
});

test("a class listed twice is flagged rather than duplicated", () => {
  const { rows, errors } = parseClassCsv("Laser 2000,1122\nlaser 2000,1130");
  assert.equal(rows.length, 1, "one row wins");
  assert.match(errors[0], /more than once/);
});

test("empty input is not an error", () => {
  const { rows, errors } = parseClassCsv("");
  assert.deepEqual(rows, []);
  assert.deepEqual(errors, []);
});

test("Windows line endings are handled", () => {
  const { rows } = parseClassCsv("Laser 2000,1122\r\nHeron,1345\r\n");
  assert.equal(rows.length, 2);
});
