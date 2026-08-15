/* The secret tripwire.
 *
 * This exists because the club PIN was committed to a public repository once
 * already. The scanner is only useful if it stays true in both directions:
 * it must catch the known mistakes, and it must stay quiet on everything this
 * repo legitimately contains — a hook that cries wolf gets bypassed.
 *
 * Offending fixtures are assembled at runtime rather than written literally,
 * so this file never contains a line that looks like a real secret.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { scanText, scanTracked } from "../tools/scan-secrets.mjs";

/** Build a service-role JWT with the same shape as a real one. */
function fakeServiceRoleJwt(role = "service_role") {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return [
    b64({ alg: "HS256", typ: "JWT" }),
    b64({ iss: "supabase", ref: "example", role, iat: 1, exp: 2 }),
    "c2lnbmF0dXJlLXBsYWNlaG9sZGVy",
  ].join(".");
}

/* ---- the mistake that actually happened ---- */

test("a real club PIN in example SQL is caught", () => {
  const line = "select set_club_pin(" + "'1957'" + ");";
  const [finding] = scanText(line, "SETUP.md");

  assert.ok(finding, "this is the exact line that leaked");
  assert.equal(finding.rule, "club-pin-literal");
  assert.equal(finding.line, 1);
  assert.equal(finding.file, "SETUP.md");
  assert.match(finding.fix, /placeholder/);
});

test("the placeholder form is not flagged", () => {
  assert.deepEqual(scanText("select set_club_pin('<the club PIN>');"), []);
  assert.deepEqual(scanText("select set_club_pin('<a new PIN>');"), []);
});

test("a PIN of any length is caught, not just six digits", () => {
  for (const pin of ["1234", "19570", "0000"]) {
    const line = "select set_club_pin(" + `'${pin}'` + ");";
    assert.equal(scanText(line).length, 1, pin);
  }
});

/* ---- service-role keys ---- */

test("a service-role key is caught", () => {
  const line = `const KEY = "${fakeServiceRoleJwt()}";`;
  const [finding] = scanText(line, "js/supabase.js");

  assert.ok(finding);
  assert.equal(finding.rule, "service-role-key");
  assert.match(finding.what, /service-role/);
});

test("an anon key is NOT flagged — it belongs in public JavaScript", () => {
  // The whole design depends on shipping this one; flagging it would make the
  // hook something to switch off.
  const line = `publishableKey: "${fakeServiceRoleJwt("anon")}"`;
  assert.deepEqual(scanText(line), []);
});

test("a publishable key is not flagged", () => {
  assert.deepEqual(scanText(`publishableKey: "sb_publishable_SzJkkqsDM5EIkr8HinKXFw_xn3519n0"`), []);
});

test("a secret key prefix is flagged", () => {
  const line = `KEY=sb_secret_` + "abcdef0123456789";
  assert.equal(scanText(line).length, 1);
});

/* ---- password / key assignments ---- */

test("a real database password is caught", () => {
  const line = "SUPABASE_DB_PASSWORD=" + "s3cr3t-Hunter-2000";
  const [finding] = scanText(line, ".env");
  assert.ok(finding);
  assert.equal(finding.rule, "secret-assignment");
});

test("reading a secret from the environment is not a leak", () => {
  // This is the correct pattern and appears in the edge function.
  for (const line of [
    'const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;',
    "const CLUB_PIN = process.env.CLUB_PIN;",
    "SUPABASE_DB_PASSWORD=$SUPABASE_DB_PASSWORD",
    "SUPABASE_DB_PASSWORD=<your database password>",
  ]) {
    assert.deepEqual(scanText(line), [], line);
  }
});

test("documentation that merely names a secret is not flagged", () => {
  for (const line of [
    "| `CLUB_PIN` | no | if set, this plain-text PIN is used instead |",
    "supabase secrets set CLUB_EMAIL=club@nsc-race-day.local",
    "The service role key never leaves this function.",
  ]) {
    assert.deepEqual(scanText(line), [], line);
  }
});

/* ---- mechanics ---- */

test("the reported line number points at the offending line", () => {
  const text = ["-- setup", "-- notes", "select set_club_pin(" + "'4242'" + ");"].join("\n");
  const [finding] = scanText(text, "SETUP.md");
  assert.equal(finding.line, 3);
});

test("an explicit allow comment suppresses a finding", () => {
  const line = "select set_club_pin(" + "'1234'" + ");  -- scan-secrets: allow";
  assert.deepEqual(scanText(line), []);
});

/* ---- the repository as it stands ---- */

test("every tracked file in this repo is clean", () => {
  const findings = scanTracked();
  assert.deepEqual(
    findings.map((f) => `${f.file}:${f.line} ${f.what}`),
    [],
    "a real secret is committed to this repository"
  );
});
