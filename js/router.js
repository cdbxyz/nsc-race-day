/* router.js — hash routing for the seven OOD pages.
 *
 * Deliberately tiny. Sections already exist in index.html; the router just
 * hides all but one and hands that one to its page module. Page modules are
 * plain objects: { title, mount(el), unmount() }.
 */

export function createRouter(routes, { fallback = "setup" } = {}) {
  let currentName = null;

  function nameFromHash() {
    const name = (globalThis.location.hash || "").replace(/^#\/?/, "").split("?")[0];
    return routes[name] ? name : fallback;
  }

  function show(name) {
    if (name === currentName) return;

    if (currentName) {
      const leaving = routes[currentName];
      try {
        leaving.page.unmount?.();
      } catch (err) {
        console.error(`unmount ${currentName} failed`, err);
      }
      leaving.section.hidden = true;
    }

    const entering = routes[name];
    entering.section.hidden = false;
    currentName = name;
    document.title = entering.page.title
      ? `${entering.page.title} — NSC Race Day`
      : "NSC Race Day";
    // Screen readers and scroll position both want to start at the top.
    globalThis.scrollTo?.(0, 0);

    try {
      entering.page.mount?.(entering.section);
    } catch (err) {
      console.error(`mount ${name} failed`, err);
    }
  }

  function navigate(name) {
    const target = `#/${name}`;
    if (globalThis.location.hash === target) show(nameFromHash());
    else globalThis.location.hash = target;
  }

  function start() {
    globalThis.addEventListener("hashchange", () => show(nameFromHash()));
    show(nameFromHash());
  }

  return { start, navigate, get current() { return currentName; } };
}
