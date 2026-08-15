/* install-hooks.mjs — points git at the hooks committed in .githooks/.
 *
 * core.hooksPath is per-clone config, so without this a fresh clone silently
 * loses the pre-commit stamping and sw.js starts drifting from the files it
 * caches. npm's "prepare" script runs this on every `npm install`.
 *
 * Anywhere without a git repository — a CI checkout of a tarball, say — this
 * quietly does nothing rather than failing the install.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

try {
  git(["rev-parse", "--git-dir"]);
} catch {
  // Not a git repo (or no git installed). Nothing to wire up.
  process.exit(0);
}

try {
  if (git(["config", "--get", "core.hooksPath"]) === ".githooks") {
    process.exit(0); // already set; stay quiet
  }
} catch {
  // `git config --get` exits non-zero when unset, which is the normal case.
}

try {
  git(["config", "core.hooksPath", ".githooks"]);
  console.log("hooks enabled: core.hooksPath = .githooks");
} catch (err) {
  console.warn(`could not set core.hooksPath (${err.message}); run: git config core.hooksPath .githooks`);
}
