/* Tap-to-arm.
 *
 * The bug this exists to prevent: the armed state used to live in the
 * button's own closure, so any re-render replaced the button with a fresh,
 * disarmed one. The start sequence page repaints to move the countdown, so an
 * armed Postpone was destroyed within a fraction of a second and the second
 * tap never found it armed — the action could not be triggered at all.
 *
 * The armed state therefore lives outside the DOM, keyed by action id, and
 * these tests hold it there.
 */

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

/* A DOM small enough to exercise the module, since this app has no test
   browser. Only what ui.js touches. */
class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toString() { return [...this.set].join(" "); }
}

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.classList = new FakeClassList();
    this.textContent = "";
    this.disabled = false;
    this.parentNode = null;
  }
  set className(v) {
    this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className() { return this.classList.toString(); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  append(...kids) {
    for (const k of kids) { if (k && typeof k === "object") k.parentNode = this; this.children.push(k); }
  }
  closest(selector) {
    const attr = /^\[([^\]]+)\]$/.exec(selector)?.[1];
    let node = this;
    while (node) {
      if (attr && node.attributes && attr in node.attributes) return node;
      node = node.parentNode;
    }
    return null;
  }
  /** Fire a click the way a browser would: on the node, then the document. */
  click() {
    const event = { target: this, type: "click" };
    for (const fn of this.listeners.click || []) fn(event);
    for (const fn of documentListeners.click || []) fn(event);
    return event;
  }
}

const documentListeners = {};
globalThis.document = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (t) => ({ nodeValue: t, textContent: t }),
  addEventListener: (type, fn) => ((documentListeners[type] ||= []).push(fn)),
};
globalThis.Node = FakeNode;
// navigator is a getter-only global in Node, so add the one method ui.js uses.
if (!globalThis.navigator?.vibrate) {
  Object.defineProperty(globalThis.navigator ?? (globalThis.navigator = {}), "vibrate", {
    value: () => true,
    configurable: true,
  });
}

const { armedButton, isArmed, disarmAll, onArmChange } = await import("../js/ui.js");

beforeEach(() => disarmAll({ quiet: true }));
afterEach(() => disarmAll({ quiet: true }));

const make = (id, onConfirm = () => {}) =>
  armedButton(id, { label: "Postpone (AP)", armedLabel: "Tap again to postpone", classes: "ghost", onConfirm });

test("the first tap arms rather than acting", () => {
  let fired = 0;
  const button = make("seq.postpone", () => { fired += 1; });

  button.click();

  assert.equal(fired, 0, "one tap must never fire a destructive action");
  assert.equal(isArmed("seq.postpone"), true);
});

test("the second tap confirms", async () => {
  let fired = 0;
  const button = make("seq.postpone", () => { fired += 1; });

  button.click();
  button.click();
  await Promise.resolve();

  assert.equal(fired, 1);
  assert.equal(isArmed("seq.postpone"), false, "and disarms afterwards");
});

test("the armed state survives a re-render", () => {
  // The actual bug: the sequence page rebuilds its buttons while the
  // countdown ticks. A rebuilt button must come back armed.
  const first = make("seq.postpone");
  first.click();
  assert.equal(isArmed("seq.postpone"), true);

  const rebuilt = make("seq.postpone");

  assert.equal(rebuilt.textContent, "Tap again to postpone", "renders in the armed state");
  assert.ok(rebuilt.classList.contains("armed"), "and looks different");
});

test("a rebuilt armed button confirms on its first tap", async () => {
  let fired = 0;
  make("seq.postpone", () => { fired += 1; }).click();

  // The page repaints; the OOD's second tap lands on the new node.
  const rebuilt = make("seq.postpone", () => { fired += 1; });
  rebuilt.click();
  await Promise.resolve();

  assert.equal(fired, 1, "the second tap fires, whichever node received it");
});

test("an unarmed button renders with its plain label", () => {
  const button = make("seq.postpone");
  assert.equal(button.textContent, "Postpone (AP)");
  assert.equal(button.classList.contains("armed"), false);
});

test("arming one control disarms another", () => {
  make("seq.postpone").click();
  assert.equal(isArmed("seq.postpone"), true);

  make("seq.recall").click();

  assert.equal(isArmed("seq.recall"), true);
  assert.equal(isArmed("seq.postpone"), false, "only one thing is ever primed");
});

test("tapping anywhere else disarms", () => {
  make("seq.postpone").click();
  assert.equal(isArmed("seq.postpone"), true);

  // Something unrelated, with no data-arm attribute anywhere above it.
  const elsewhere = new FakeNode("div");
  elsewhere.click();

  assert.equal(isArmed("seq.postpone"), false);
});

test("tapping the armed button itself does not count as tapping elsewhere", async () => {
  let fired = 0;
  const button = make("seq.postpone", () => { fired += 1; });

  button.click();          // arms; the document listener must not undo this
  assert.equal(isArmed("seq.postpone"), true);

  button.click();          // confirms
  await Promise.resolve();
  assert.equal(fired, 1);
});

test("the arm lapses after its window", async () => {
  const realNow = Date.now;
  try {
    make("seq.postpone").click();
    assert.equal(isArmed("seq.postpone"), true);

    Date.now = () => realNow() + 6000; // past the ~5s window
    assert.equal(isArmed("seq.postpone"), false);
  } finally {
    Date.now = realNow;
  }
});

test("subscribers are told when something arms, so the page can repaint", () => {
  let changes = 0;
  const off = onArmChange(() => { changes += 1; });

  make("seq.postpone").click();
  assert.equal(changes, 1);

  disarmAll();
  assert.equal(changes, 2);

  off();
  make("seq.recall").click();
  assert.equal(changes, 2, "unsubscribed");
});
