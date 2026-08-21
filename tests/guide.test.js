/* The OOD guide is ONE document.
 *
 * GUIDE.md is the source and the app renders that file directly, so there is
 * no second copy to drift. The risk that replaces drift is subtler: somebody
 * writes a Markdown construct the little renderer does not handle, and the
 * guide silently loses a paragraph on the one screen that has to be right.
 * These tests exist to make that impossible to do quietly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const guide = () => readFile(new URL("../GUIDE.md", import.meta.url), "utf8");

/* A DOM small enough to render into, so markdown.js can be tested in node
   without pulling in a browser. Only what the renderer actually touches. */
function installDom() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.attrs = {};
      this._text = "";
      this.className = "";
    }
    append(...kids) {
      for (const k of kids) this.children.push(k);
    }
    set textContent(v) {
      this._text = String(v);
      this.children = [];
    }
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join("");
    }
    get lastElementChild() {
      const els = this.children.filter((c) => c.tagName);
      return els[els.length - 1] ?? null;
    }
    set href(v) { this.attrs.href = v; }
    get href() { return this.attrs.href; }
    set target(v) { this.attrs.target = v; }
    set rel(v) { this.attrs.rel = v; }
  }
  class TextNode {
    constructor(t) { this._text = String(t); }
    get textContent() { return this._text; }
  }
  globalThis.document = {
    createElement: (tag) => new Node(tag),
    createTextNode: (t) => new TextNode(t),
    createDocumentFragment: () => new Node("#fragment"),
  };
  return { Node, TextNode };
}
installDom();
const { renderMarkdown, renderInline } = await import("../js/markdown.js");

/** Every element of a given tag, depth first. */
function findAll(node, tag) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children ?? []) {
      if (c.tagName === tag.toUpperCase()) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}

/* ---- the renderer handles what the document contains -------------------- */

test("GUIDE.md uses no Markdown the renderer cannot handle", async () => {
  const text = await guide();
  const handled = [
    /^#{1,6}\s/,        // headings
    /^[-*]\s/,          // bullets
    /^\d+\.\s/,         // ordered
    /^>\s?/,            // blockquote
    /^\|.*\|$/,         // table row
    /^-{3,}$/,          // rule
    /^\s+\S/,           // continuation of a list item
    /^\s*$/,            // blank
  ];
  const unhandled = [];
  for (const [n, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (handled.some((re) => re.test(raw) || re.test(line))) continue;
    // Anything left must be an ordinary paragraph line — no leading syntax.
    if (/^(```|~~~|\t|<|!\[|\[\^)/.test(line)) {
      unhandled.push(`line ${n + 1}: ${line.slice(0, 60)}`);
    }
  }
  assert.deepEqual(unhandled, [], "add support to markdown.js before using these");
});

test("every heading in the document survives rendering", async () => {
  const text = await guide();
  const expected = [...text.matchAll(/^#{2,6}\s+(.*)$/gm)].map((m) => m[1].trim());
  const frag = renderMarkdown(text);
  const rendered = ["h2", "h3", "h4", "h5", "h6"].flatMap((t) => findAll(frag, t)).map((n) => n.textContent);
  for (const heading of expected) {
    assert.ok(rendered.includes(heading), `heading lost: ${heading}`);
  }
});

test("the sync-pill table renders as a table, not as pipes", async () => {
  const frag = renderMarkdown(await guide());
  const tables = findAll(frag, "TABLE");
  assert.ok(tables.length >= 1, "the guide's tables must render");
  const text = tables[0].textContent;
  assert.ok(!text.includes("|"), "no raw pipes left in the output");
  assert.ok(text.includes("Synced"), "and the content survived");
});

test("the warnings in block quotes are not dropped", async () => {
  const frag = renderMarkdown(await guide());
  const text = await guide();
  // One blockquote per run of consecutive "> " lines.
  const blocks = (text.match(/(^>.*\n?)+/gm) ?? []).length;
  const quotes = findAll(frag, "BLOCKQUOTE");
  assert.equal(quotes.length, blocks, "every callout in the file becomes one on screen");
  assert.ok(quotes.length >= 2, `expected the guide's callouts, saw ${quotes.length}`);
  assert.ok(
    quotes.some((q) => /Do not type a name that is already there/.test(q.textContent)),
    "including the one that matters most"
  );
});

test("the numbered short version keeps its order", async () => {
  const frag = renderMarkdown(await guide());
  const ols = findAll(frag, "OL");
  assert.ok(ols.length >= 1);
  const items = findAll(ols[ols.length - 1], "LI").map((li) => li.textContent);
  assert.equal(items.length, 6, "six steps in the short version");
  assert.match(items[0], /charged/);
});

/* ---- inline ------------------------------------------------------------- */

test("bold, code and links render as elements", () => {
  const bold = renderInline("tap **Start race day** now");
  assert.equal(bold.filter((n) => n.tagName === "STRONG").length, 1);
  assert.equal(bold.map((n) => n.textContent).join(""), "tap Start race day now");

  const code = renderInline("open `#/dev` please");
  assert.equal(code.filter((n) => n.tagName === "CODE").length, 1);

  const link = renderInline("see [the drill](DRILL.md) for more");
  const a = link.find((n) => n.tagName === "A");
  assert.equal(a.textContent, "the drill");
  assert.equal(a.href, "DRILL.md");
});

test("a dangerous href is dropped, and the text kept", () => {
  /* The input is our own file today. A renderer that is safe only because of
     who feeds it is not safe. */
  const nodes = renderInline("[tap me](javascript:alert(1))");
  const a = nodes.find((n) => n.tagName === "A");
  assert.equal(a.textContent, "tap me");
  assert.equal(a.href, undefined, "no href at all rather than a live one");
});

test("nothing is rendered through innerHTML", async () => {
  const source = await readFile(new URL("../js/markdown.js", import.meta.url), "utf8");
  // Comments may discuss it; code may not use it.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(code));
});

/* ---- it must work with no signal ---------------------------------------- */

test("GUIDE.md is precached with the rest of the shell", async () => {
  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  assert.match(sw, /"\.\/GUIDE\.md"/, "an OOD who needs the guide has no signal");
});

test("the guide is discovered by the stamper, not hand-listed", async () => {
  const tool = await readFile(new URL("../tools/stamp-sw.mjs", import.meta.url), "utf8");
  assert.match(tool, /ROOT_FILES = \[[^\]]*"GUIDE\.md"/s);
});

test("the app reaches the guide from a link on every page", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  // The footer is outside every .page section, so it is on all of them.
  assert.match(html, /href="#\/guide"/);
  const foot = html.slice(html.indexOf('class="foot foot-help"'));
  assert.match(foot.slice(0, 400), /How to run a race day/);

  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  assert.match(app, /import guide from "\.\/pages\/guide\.js"/);
  assert.match(app, /guide,\n\}/, "and it is a routed page");
});

test("the guide page renders the file rather than a second copy of it", async () => {
  const page = await readFile(new URL("../js/pages/guide.js", import.meta.url), "utf8");
  assert.match(page, /fetch\("GUIDE\.md"/);
  // No prose of its own beyond the failure message.
  assert.ok(!/## |### /.test(page), "the page must not contain guide content");
});
