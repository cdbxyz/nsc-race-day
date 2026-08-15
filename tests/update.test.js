/* When the app is allowed to interrupt with an update prompt.
 *
 * The stakes are asymmetric: holding a prompt back costs nothing (the new
 * worker waits either way), while showing one mid-race risks a mis-tap and a
 * reload at the exact moment the OOD is watching boats cross a line.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { canPromptNow, PROMPT_PAGES } from "../js/update.js";

test("offered on the calm pages when nothing is under way", () => {
  for (const page of ["setup", "signon", "results", "standdown"]) {
    assert.equal(canPromptNow({ page, raceStatuses: [] }), true, page);
  }
});

test("never offered on the hands-full pages", () => {
  for (const page of ["checklist", "sequence", "live"]) {
    assert.equal(canPromptNow({ page, raceStatuses: [] }), false, page);
  }
});

test("suppressed while a race is in sequence or racing, whatever the page", () => {
  for (const status of ["sequence", "racing"]) {
    for (const page of PROMPT_PAGES) {
      assert.equal(
        canPromptNow({ page, raceStatuses: ["published", status] }),
        false,
        `${page} during ${status}`
      );
    }
  }
});

test("a finished or published race does not suppress it", () => {
  for (const status of ["setup", "prestart", "finished", "published", "abandoned"]) {
    assert.equal(canPromptNow({ page: "results", raceStatuses: [status] }), true, status);
  }
});

test("one active race among many is enough to suppress it", () => {
  assert.equal(
    canPromptNow({ page: "results", raceStatuses: ["published", "published", "racing"] }),
    false
  );
});

test("the prompt returns once the race finishes", () => {
  // The exact sequence the dev panel walks through by hand.
  const during = canPromptNow({ page: "results", raceStatuses: ["racing"] });
  const after = canPromptNow({ page: "results", raceStatuses: ["finished"] });
  assert.equal(during, false);
  assert.equal(after, true);
});

test("an unknown or missing page is treated as not calm", () => {
  assert.equal(canPromptNow({ page: "dev", raceStatuses: [] }), false);
  assert.equal(canPromptNow({ page: undefined, raceStatuses: [] }), false);
  assert.equal(canPromptNow({ page: null }), false);
});
