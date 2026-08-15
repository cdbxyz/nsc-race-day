/* stamp-sw.mjs — keeps the service worker's shell list and cache version
 * honest, so nobody has to remember to bump anything.
 *
 * It scans the files that make up the app shell, writes them into sw.js, and
 * derives VERSION from a hash of their contents. Change any shell file and the
 * version changes with it; change nothing and the stamp is byte-identical, so
 * this is safe to run as often as you like.
 *
 *   npm run stamp     rewrite sw.js
 *   npm test          fails if sw.js is out of date (see tests/shell.test.js)
 *
 * This is not a build step: it edits a file that is committed and served
 * as-is. GitHub Pages still deploys the repo by push alone.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SW_PATH = path.join(ROOT, "sw.js");

/* Everything the app needs to open with no signal. Directories are walked, so
   adding a page module or a font is picked up without touching anything. */
const ROOT_FILES = ["index.html", "manifest.json", "icon.svg"];
const DIRECTORIES = ["css", "js", "fonts"];

const BEGIN = "/* BEGIN GENERATED — npm run stamp */";
const END = "/* END GENERATED */";

async function walk(dir) {
  const entries = await readdir(path.join(ROOT, dir), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await walk(rel)));
    else files.push(rel);
  }
  return files;
}

async function shellFiles() {
  const found = [...ROOT_FILES];
  for (const dir of DIRECTORIES) found.push(...(await walk(dir)));
  // Sorted so the hash depends on content, never on directory read order.
  return found.sort();
}

/**
 * Build the generated block: the shell list and a version derived from it.
 * sw.js itself is deliberately excluded — it is what we are stamping, and
 * including it would mean the hash could never settle.
 */
async function generate() {
  const files = await shellFiles();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(path.join(ROOT, file)));
  }
  const version = hash.digest("hex").slice(0, 12);

  const list = ['  "./",', ...files.map((f) => `  "./${f}",`)].join("\n");
  return [
    BEGIN,
    `const VERSION = "${version}";`,
    "const SHELL = [",
    list,
    "];",
    END,
  ].join("\n");
}

function replaceBlock(source, block) {
  const start = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error(`sw.js is missing its ${BEGIN} / ${END} markers`);
  }
  return source.slice(0, start) + block + source.slice(end + END.length);
}

export async function stamp({ check = false } = {}) {
  const current = await readFile(SW_PATH, "utf8");
  const updated = replaceBlock(current, await generate());
  if (current === updated) return { changed: false, version: versionOf(updated) };
  if (check) return { changed: true, version: versionOf(updated), stale: true };
  await writeFile(SW_PATH, updated);
  return { changed: true, version: versionOf(updated) };
}

function versionOf(source) {
  return /const VERSION = "([^"]+)"/.exec(source)?.[1] ?? "unknown";
}

/* Run directly: `node tools/stamp-sw.mjs [--check]`.
   Both sides are resolved through realpath because macOS serves /tmp as a
   symlink to /private/tmp — comparing the raw strings silently skips the run. */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const check = process.argv.includes("--check");
  const result = await stamp({ check });
  if (check && result.stale) {
    console.error(
      `sw.js is out of date — shell files changed but the cache version did not.\n` +
        `Run: npm run stamp`
    );
    process.exit(1);
  }
  console.log(
    result.changed ? `sw.js stamped ${result.version}` : `sw.js already current (${result.version})`
  );
}
