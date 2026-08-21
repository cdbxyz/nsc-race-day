/* markdown.js — just enough Markdown to render GUIDE.md in the app.
 *
 * Why this exists rather than a library: the OOD guide has to be ONE
 * document. A second copy written as HTML inside the app would drift from the
 * file the moment somebody edited one of them, and the copy that was wrong
 * would be the one on the beach. So the app renders the file itself.
 *
 * Why not a CDN parser: the service worker cannot precache a cross-origin
 * script, and a guide that needs signal is no guide at all — the OOD reading
 * it is the one who is stuck.
 *
 * Deliberately small. It handles exactly the constructs GUIDE.md uses, and
 * tests/guide.test.js asserts that GUIDE.md never grows one this cannot
 * render, so the document and the renderer cannot drift apart silently.
 *
 * Everything is built with DOM nodes and textContent. Nothing here ever
 * touches innerHTML: the input is our own file today, but a renderer that is
 * safe only because of who feeds it is not safe.
 */

/**
 * Inline: **bold**, `code`, and [text](href). Returns an array of nodes.
 */
export function renderInline(text) {
  const nodes = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(document.createTextNode(text.slice(last, match.index)));

    if (match[1] !== undefined) {
      const strong = document.createElement("strong");
      strong.textContent = match[1];
      nodes.push(strong);
    } else if (match[2] !== undefined) {
      const code = document.createElement("code");
      code.textContent = match[2];
      nodes.push(code);
    } else {
      const a = document.createElement("a");
      a.textContent = match[3];
      /* Only http(s) and in-app hashes. A guide is rendered from a file in
         the repo, but "javascript:" in a link is the kind of thing that gets
         through once and never gets caught. */
      const href = match[4];
      if (/^(https?:\/\/|#|\.\/|[\w-]+\.md)/i.test(href)) a.href = href;
      if (/^https?:/i.test(href)) {
        a.target = "_blank";
        a.rel = "noopener";
      }
      a.className = "linkish";
      nodes.push(a);
    }
    last = pattern.lastIndex;
  }

  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

const el = (tag, className = "") => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

const fill = (node, text) => {
  for (const child of renderInline(text)) node.append(child);
  return node;
};

/** True for a table row: starts and ends with a pipe. */
const isTableRow = (line) => /^\|.*\|$/.test(line.trim());
const isDivider = (line) => /^\|[\s:|-]+\|$/.test(line.trim());
const cellsOf = (line) =>
  line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

/**
 * Render Markdown into a container element.
 *
 * @param {string} source
 * @returns {DocumentFragment}
 */
export function renderMarkdown(source) {
  const out = document.createDocumentFragment();
  const lines = String(source ?? "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(trimmed)) {
      out.append(el("hr"));
      i += 1;
      continue;
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      // The document's own H1 is the page title, already on screen.
      const level = Math.min(heading[1].length + 1, 6);
      out.append(fill(el(`h${level}`), heading[2]));
      i += 1;
      continue;
    }

    // Table
    if (isTableRow(trimmed) && isTableRow(lines[i + 1] ?? "") && isDivider(lines[i + 1])) {
      const table = el("table", "mdtable");
      const thead = el("thead");
      const headRow = el("tr");
      for (const cell of cellsOf(trimmed)) headRow.append(fill(el("th"), cell));
      thead.append(headRow);
      table.append(thead);

      const tbody = el("tbody");
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        const row = el("tr");
        for (const cell of cellsOf(lines[i])) row.append(fill(el("td"), cell));
        tbody.append(row);
        i += 1;
      }
      table.append(tbody);
      // Wide content scrolls inside its own box rather than the page.
      const wrap = el("div", "mdtable-wrap");
      wrap.append(table);
      out.append(wrap);
      continue;
    }

    // Blockquote — one or more consecutive "> " lines, joined as a paragraph.
    if (/^>\s?/.test(trimmed)) {
      const parts = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        parts.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      const quote = el("blockquote", "mdquote");
      // A blank "> " line separates paragraphs inside the quote.
      for (const para of parts.join("\n").split(/\n\s*\n/)) {
        if (para.trim()) quote.append(fill(el("p"), para.replace(/\n/g, " ").trim()));
      }
      out.append(quote);
      continue;
    }

    // Lists — bullet or ordered, with continuation lines indented.
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    const ordered = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (bullet || ordered) {
      const list = el(ordered ? "ol" : "ul", "mdlist");
      const marker = ordered ? /^\d+\.\s+(.*)$/ : /^[-*]\s+(.*)$/;
      while (i < lines.length) {
        const item = marker.exec(lines[i].trim());
        if (!item) {
          // An indented line continues the item above it.
          if (list.lastElementChild && /^\s+\S/.test(lines[i]) && lines[i].trim()) {
            list.lastElementChild.append(document.createTextNode(" "));
            for (const n of renderInline(lines[i].trim())) list.lastElementChild.append(n);
            i += 1;
            continue;
          }
          break;
        }
        list.append(fill(el("li"), item[1]));
        i += 1;
      }
      out.append(list);
      continue;
    }

    // Paragraph — consecutive plain lines.
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|>|[-*]\s|\d+\.\s|-{3,}$)/.test(lines[i].trim()) &&
      !isTableRow(lines[i].trim())
    ) {
      para.push(lines[i].trim());
      i += 1;
    }
    if (para.length) out.append(fill(el("p"), para.join(" ")));
    else i += 1;
  }

  return out;
}
