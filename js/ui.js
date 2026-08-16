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

/* ---------------------------------------------------------------------------
 * Tap to arm
 *
 * Native alert/confirm/prompt are banned here: they freeze the page, are
 * miserable on a phone, and cannot show what the action would do. A destructive
 * control instead needs two taps — the first arms it, the second acts.
 *
 * The armed state lives HERE, keyed by action id, and deliberately not on the
 * button. It used to live in the button's own closure, which meant any
 * re-render destroyed it: the start sequence page repaints four times a second
 * to move the countdown, so an armed button was replaced within 250ms and the
 * second tap never found it armed.
 * ------------------------------------------------------------------------ */

const ARM_WINDOW_MS = 5000;
const armedUntil = new Map();
const armListeners = new Set();
let armTimer = null;

function notifyArmChange() {
  for (const fn of armListeners) {
    try {
      fn();
    } catch (err) {
      console.error("arm listener failed", err);
    }
  }
}

/** Re-render when something arms or disarms. Returns an unsubscribe. */
export function onArmChange(fn) {
  armListeners.add(fn);
  return () => armListeners.delete(fn);
}

export function isArmed(id) {
  const until = armedUntil.get(id);
  if (!until) return false;
  if (Date.now() > until) {
    armedUntil.delete(id);
    return false;
  }
  return true;
}

export function disarmAll({ quiet = false } = {}) {
  if (!armedUntil.size) return false;
  armedUntil.clear();
  clearTimeout(armTimer);
  if (!quiet) notifyArmChange();
  return true;
}

function arm(id) {
  // Only ever one thing armed: arming Abandon must not leave Postpone primed.
  armedUntil.clear();
  armedUntil.set(id, Date.now() + ARM_WINDOW_MS);
  clearTimeout(armTimer);
  armTimer = setTimeout(() => {
    armedUntil.delete(id);
    notifyArmChange();
  }, ARM_WINDOW_MS);
  notifyArmChange();
}

/* A tap anywhere else disarms, so nothing stays primed while the OOD is doing
   something unrelated. Registered once, on the bubble phase, after the
   button's own handler has run. */
if (typeof document !== "undefined") {
  document.addEventListener("click", (event) => {
    if (event.target?.closest?.("[data-arm]")) return;
    disarmAll();
  });
}

/**
 * A button that needs two taps.
 *
 * @param {string} id stable identity for this action, so the armed state
 *        survives the page being re-rendered underneath it.
 */
export function armedButton(id, { label, armedLabel, classes = "", onConfirm }) {
  const active = isArmed(id);

  const button = el(`button.btn.${classes}${active ? " armed" : ""}`, {
    type: "button",
    text: active ? armedLabel : label,
    "data-arm": id,
    "aria-live": "polite",
    onclick: async () => {
      if (!isArmed(id)) {
        arm(id);
        navigator.vibrate?.(20);
        return;
      }
      disarmAll({ quiet: true });
      button.disabled = true;
      await onConfirm();
    },
  });

  return button;
}

/** A short-lived inline message, for the places a native alert was reached for. */
export function flash(container, message, tone = "info") {
  container.querySelectorAll(".notice").forEach((n) => n.remove());
  const node = notice(message, tone);
  container.prepend(node);
  setTimeout(() => node.remove(), 5000);
  return node;
}
