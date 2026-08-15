/* scan-secrets.mjs — a tripwire for the mistake we have already made once.
 *
 * The club PIN was committed to this public repository. Deleting the line did
 * not undo it: git remembers, and the PIN had to be rotated. This blocks the
 * commit instead.
 *
 * This is deliberately NOT a general secret scanner. It looks for three
 * specific things that would be serious here, and is tuned to stay quiet
 * otherwise — a hook that cries wolf gets bypassed, and then it protects
 * nothing.
 *
 *   npm run scan            check every tracked text file
 *   node tools/scan-secrets.mjs --staged   check what is about to be committed
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/* Files that necessarily contain the patterns themselves. Kept short and
   obvious — anything on this list is unscanned, so nothing else belongs here. */
const SELF = new Set(["tools/scan-secrets.mjs"]);

/* Binary and vendored things there is no point reading. */
const SKIP_EXTENSIONS = new Set([".woff2", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".zip"]);

/** Values that are obviously stand-ins rather than the real thing. */
function isPlaceholder(value) {
  const v = String(value).trim();
  if (!v) return true;
  // <the club PIN>, $CLUB_PIN, ${CLUB_PIN}, %CLUB_PIN%
  if (/^[<$%{]/.test(v)) return true;
  if (/^(your|my|the|some|example|placeholder|changeme|redacted|xxx+|\.\.\.)/i.test(v)) return true;
  return false;
}

/**
 * Reading a secret out of the environment is the correct thing to do, and
 * looks superficially like assigning one. `KEY = Deno.env.get("KEY")` and
 * `KEY = process.env.KEY` are code, not leaks.
 */
function looksLikeCode(value) {
  const v = String(value).trim();
  if (v.includes("(")) return true;
  if (/\benv\b/i.test(v)) return true;
  if (/^(process|Deno|globalThis|import|require|config|opts|options)\b/.test(v)) return true;
  return false;
}

/** A real credential is an opaque run of token characters, not a sentence. */
function looksLikeSecret(value) {
  const v = String(value).trim();
  return v.length >= 4 && /^[A-Za-z0-9_\-+/=.]+$/.test(v);
}

/** Decode a JWT payload without verifying it — we only want the claims. */
function jwtPayload(token) {
  try {
    const part = token.split(".")[1];
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export const RULES = [
  {
    name: "club-pin-literal",
    // set_club_pin('1957') — a quoted argument containing a digit is a real
    // PIN, because every placeholder we use is words in angle brackets.
    test(line) {
      const match = /set_club_pin\s*\(\s*(['"])([^'"]*)\1/.exec(line);
      if (!match) return null;
      const value = match[2];
      if (isPlaceholder(value) || !/\d/.test(value)) return null;
      return "a real club PIN";
    },
    fix: "Use a placeholder: select set_club_pin('<the club PIN>');",
  },
  {
    name: "service-role-key",
    // A Supabase service role key bypasses RLS entirely. The publishable and
    // anon keys are fine in public JS and must not be flagged, so the token is
    // decoded and only service_role is rejected.
    test(line) {
      for (const token of line.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) ?? []) {
        const payload = jwtPayload(token);
        if (payload?.role === "service_role") return "a Supabase service-role key";
      }
      if (/\bsb_secret_[A-Za-z0-9_-]{8,}/.test(line)) return "a Supabase secret key";
      return null;
    },
    fix: "Service-role keys belong only in the edge function environment, never in a file.",
  },
  {
    name: "secret-assignment",
    test(line) {
      const match =
        /\b(SUPABASE_DB_PASSWORD|SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE_KEY|DB_PASSWORD|CLUB_PIN)\b\s*[:=]\s*(["']?)([^\s"'`,;]+)\2/.exec(
          line
        );
      if (!match) return null;
      const value = match[3];
      if (isPlaceholder(value) || looksLikeCode(value) || !looksLikeSecret(value)) return null;
      return `a real value for ${match[1]}`;
    },
    fix: "Set it as a Supabase secret or an environment variable, and use a <placeholder> here.",
  },
];

/**
 * Scan one file's contents.
 * @returns {Array<{file:string, line:number, rule:string, what:string, fix:string, text:string}>}
 */
export function scanText(text, file = "<input>") {
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, index) => {
    // An explicit opt-out for the rare legitimate case, so the hook is never
    // something to disable wholesale.
    if (/scan-secrets:\s*allow/.test(line)) return;
    for (const rule of RULES) {
      const what = rule.test(line);
      if (!what) continue;
      findings.push({
        file,
        line: index + 1,
        rule: rule.name,
        what,
        fix: rule.fix,
        text: line.trim().slice(0, 120),
      });
    }
  });
  return findings;
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function scannable(file) {
  if (SELF.has(file)) return false;
  return !SKIP_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/** Files about to be committed, read as staged rather than as on disk. */
export function scanStaged() {
  const files = git(["diff", "--cached", "--name-only", "--diff-filter=ACM"])
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter(scannable);

  const findings = [];
  for (const file of files) {
    let content;
    try {
      content = git(["show", `:${file}`]);
    } catch {
      continue; // deleted or unreadable
    }
    findings.push(...scanText(content, file));
  }
  return findings;
}

/** Every tracked text file. */
export function scanTracked() {
  const files = git(["ls-files"]).split("\n").map((f) => f.trim()).filter(Boolean).filter(scannable);
  const findings = [];
  for (const file of files) {
    let content;
    try {
      content = readFileSync(path.join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    findings.push(...scanText(content, file));
  }
  return findings;
}

export function report(findings) {
  if (!findings.length) return "";
  const lines = ["", "Refusing to commit — this looks like a real secret:", ""];
  for (const f of findings) {
    lines.push(`  ${f.file}:${f.line}  ${f.what}`);
    lines.push(`    ${f.text}`);
    lines.push(`    fix: ${f.fix}`);
    lines.push("");
  }
  lines.push("This repository is public, and git remembers deleted lines.");
  lines.push("If a real secret has already been committed, rotate it — removing it is not enough.");
  lines.push("");
  lines.push("If this is genuinely a false positive, append:  scan-secrets: allow");
  lines.push("");
  return lines.join("\n");
}

/* Run directly. Both sides through realpath: macOS serves /tmp as a symlink,
   which otherwise makes this block silently skip. */
import { realpathSync } from "node:fs";
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const staged = process.argv.includes("--staged");
  const findings = staged ? scanStaged() : scanTracked();
  if (findings.length) {
    console.error(report(findings));
    process.exit(1);
  }
  console.log(staged ? "no secrets in staged changes" : "no secrets in tracked files");
}
