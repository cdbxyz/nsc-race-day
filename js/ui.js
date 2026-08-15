/* ui.js — the smallest DOM helpers that keep the pages readable.
 *
 * Not a framework. Just enough to build elements without a wall of
 * createElement/appendChild, and to set text safely (never innerHTML with
 * anything a volunteer typed).
 */

/**
 * Build an element.
 *   el("div.panel", { id: "x" }, [child, "text"])
 * The tag may carry classes: "button.btn.ghost".
 */
export function el(spec, props = {}, children = []) {
  const [tag, ...classes] = String(spec).split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");

  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = [node.className, value].filter(Boolean).join(" ");
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = value; // only for our own markup
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== "list" && typeof value !== "object") {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }

  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  node.textContent = "";
  return node;
}

/** A labelled input, the shape used everywhere in this app. */
export function field(label, inputProps = {}) {
  const id = inputProps.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  const input = el("input", { ...inputProps, id });
  return {
    input,
    node: el("div.field", {}, [el("label", { for: id, text: label }), input]),
  };
}

export function selectField(label, options, selectProps = {}) {
  const id = selectProps.id || `s-${Math.random().toString(36).slice(2, 9)}`;
  const select = el("select", { ...selectProps, id });
  for (const option of options) {
    select.append(el("option", { value: option.value, text: option.label }));
  }
  if (selectProps.value != null) select.value = selectProps.value;
  return {
    select,
    node: el("div.field", {}, [el("label", { for: id, text: label }), select]),
  };
}

export function panel(title, children, { count = null } = {}) {
  return el("div.panel", {}, [
    el("div.panel-head", {}, [
      el("span.panel-title", { text: title }),
      count == null ? null : el("span.count", { text: count }),
    ]),
    ...[].concat(children),
  ]);
}

/** A non-blocking message strip. Errors here are read on a beach, so plain. */
export function notice(message, tone = "info") {
  return el(`p.notice.notice-${tone}`, { text: message, role: tone === "error" ? "alert" : null });
}

/** Datalist for name suggestions. */
export function datalist(id, values) {
  return el("datalist", { id }, values.map((v) => el("option", { value: v })));
}
