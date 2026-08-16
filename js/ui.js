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
    if (value == null) continue;
    if (key === "class") node.className = [node.className, value].filter(Boolean).join(" ");
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = value; // only for our own markup
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== "list" && typeof value !== "object") {
      /* A boolean DOM property must be given a boolean. Assigning the STRING
         "false" to node.spellcheck sets it true, because a non-empty string is
         truthy — which is exactly how spellcheck="false" quietly became
         spellcheck="true" on the picker's filter box. */
      node[key] =
        typeof node[key] === "boolean" ? value !== false && value !== "false" : value;
    } else if (value === false) {
      node.removeAttribute(key);
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

/**
 * A primary action that says why it cannot be used.
 *
 * A greyed-out button with no explanation is a dead end: on a beach, with the
 * fleet waiting, "Publish results" being unavailable and silent is worse than
 * useless, because the OOD cannot tell whether the app is broken or whether
 * they have missed a step. Every disabled primary action in this flow is
 * required to give a reason.
 *
 * `reason` is the sentence shown when the action is unavailable; null means
 * it is available.
 *
 * @param {HTMLElement} button
 * @param {string|null} reason
 */
export function actionWithReason(button, reason) {
  button.disabled = Boolean(reason);
  const wrap = el("div.actions", {}, [button]);
  if (!reason) return wrap;

  // Tied to the button, because a sighted user sees the greying and a screen
  // reader user would otherwise get nothing at all.
  const id = `why-${Math.random().toString(36).slice(2, 9)}`;
  wrap.append(el("p.whydisabled", { id, text: reason, role: "status" }));
  button.setAttribute("aria-describedby", id);
  return wrap;
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
  const button = el(`button.btn.${classes}`, {
    type: "button",
    text: label,
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

  /* The button keeps its own appearance in step.
   *
   * It used to render its armed look once, at construction, and rely on the
   * page re-rendering to show any change. Pages that do not re-render — the
   * dev panel, which only rewrites its log text — therefore showed nothing at
   * all on the first tap: the control was armed but looked identical, so it
   * read as a dead button and nobody ever tapped it twice.
   */
  let painted = false;
  const paint = () => {
    // Once it has been in the document and left it, stop listening. Checked
    // against an explicit false so a node that has never been attached — a
    // freshly built button, or a test double — keeps its subscription.
    if (painted && button.isConnected === false) {
      off();
      return;
    }
    painted = true;
    const active = isArmed(id);
    button.textContent = active ? armedLabel : label;
    button.classList.toggle("armed", active);
  };
  const off = onArmChange(paint);
  paint();

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

/* ---------------------------------------------------------------------------
 * Register pickers
 *
 * Never a free-text box for choosing a person or a boat. A native text input
 * invites the phone keyboard to offer half-remembered autofill suggestions,
 * and tapping one signs on the wrong helm — which nobody notices until the
 * results are wrong. So: a list of real register entries, filtered as you
 * type, tap to select, and a deliberate "add new" path for someone genuinely
 * new. The filter field itself has every autofill affordance switched off,
 * because it is a search box and not a name.
 * ------------------------------------------------------------------------ */

/** Filter attributes that stop a keyboard trying to be helpful. */
export const NO_AUTOFILL = {
  autocomplete: "off",
  autocorrect: "off",
  autocapitalize: "off",
  spellcheck: "false",
  // A name browsers have no saved values for; "search" and "name" both attract
  // autofill on iOS.
  name: "filter-nsc",
  "data-1p-ignore": "",
  "data-lpignore": "true",
};

/**
 * Open a picker sheet.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {Array<{id, label, detail?}>} options.items
 * @param {(item) => void} options.onPick
 * @param {(text: string) => void} [options.onAddNew] given the filter text
 * @param {string} [options.addLabel]
 */
export function openPicker({ title, items, onPick, onAddNew = null, addLabel = "Add new…" }) {
  const scrim = el("div.sheetscrim.pickerscrim");
  const close = () => scrim.remove();

  const list = el("div.pickerlist");
  const filter = el("input.searchbox.pickerfilter", {
    type: "text",
    ...NO_AUTOFILL,
    placeholder: "Type to filter…",
    "aria-label": `Filter ${title}`,
    oninput: () => draw(),
  });

  function draw() {
    const needle = filter.value.trim().toLowerCase();
    clear(list);

    const matches = items.filter(
      (item) =>
        !needle ||
        `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(needle)
    );

    for (const item of matches) {
      list.append(
        el("button.regrow.tappable", {
          type: "button",
          onclick: () => {
            close();
            onPick(item);
          },
        }, [
          el("div.regmain", {}, [
            el("div.regname", { text: item.label }),
            item.detail ? el("div.regmeta", { text: item.detail }) : null,
          ]),
        ])
      );
    }

    if (!matches.length) {
      list.append(
        el("div.empty", {}, [
          el("p", {
            text: needle ? `Nobody matching “${filter.value}”.` : "Nothing in the register yet.",
          }),
        ])
      );
    }

    if (onAddNew) {
      list.append(
        el("button.regrow.tappable.addnewrow", {
          type: "button",
          onclick: () => {
            const text = filter.value.trim();
            close();
            onAddNew(text);
          },
        }, [
          el("div.regmain", {}, [
            el("div.regname", { text: needle ? `${addLabel} “${filter.value.trim()}”` : addLabel }),
            el("div.regmeta", { text: "Only for someone genuinely new" }),
          ]),
          el("span.addmark", { text: "+", "aria-hidden": "true" }),
        ])
      );
    }
  }

  scrim.addEventListener("click", (event) => {
    if (event.target === scrim) close();
  });

  scrim.append(
    el("div.boatsheet.pickersheet", {}, [
      el("div.eyebrow", { text: "Choose" }),
      el("h2", { text: title }),
      filter,
      list,
      el("div.actions", {}, [
        el("button.btn.ghost", { type: "button", text: "Cancel", onclick: close }),
      ]),
    ])
  );

  draw();
  document.body.append(scrim);
  // Do NOT autofocus: a keyboard springing up covers the list on a phone, and
  // most choices are a single tap from the top of a short register.
  return { close };
}

/**
 * A labelled control that opens a picker. Reads as a field, behaves as a
 * button — there is no text input to mistype into.
 */
export function pickerField(label, { value = null, placeholder = "Choose…", ...pickerOptions }) {
  // Held in a variable so setItems() can narrow the list later — a hull picker
  // shows only the chosen class's boats, and the class is chosen after it.
  let options = pickerOptions;

  const button = el("button.pickerbutton", {
    type: "button",
    onclick: () => openPicker({ title: label, ...options }),
  }, [
    el("span.pickervalue", { text: value ?? placeholder, class: value ? "" : "empty" }),
    el("span.pickerchevron", { text: "▾", "aria-hidden": "true" }),
  ]);

  return {
    button,
    node: el("div.field", {}, [el("label", { text: label }), button]),
    set(text) {
      const span = button.querySelector(".pickervalue");
      span.textContent = text ?? placeholder;
      span.classList.toggle("empty", !text);
    },
    setItems(items) {
      options = { ...options, items };
    },
  };
}
