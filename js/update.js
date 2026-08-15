/* update.js — registers the service worker and notices when a newer one is
 * waiting to take over.
 *
 * The OOD should never have to know what a service worker is, and should never
 * have the app change under them without asking. So a new build installs
 * quietly in the background, waits, and offers itself as a small prompt the
 * OOD can ignore. Applying it reloads the page, which is safe by design: all
 * state lives in IndexedDB and every screen is a pure function of the event
 * log, so a reload lands back exactly where it was.
 */

const CHECK_INTERVAL = 30 * 60 * 1000; // half an hour is plenty for a race day

/* The prompt is only ever offered on the calm pages. The checklist, start
   sequence and live race are the OOD's hands-full moments — a bar appearing
   there is a distraction and a mis-tap at the worst possible time. */
export const PROMPT_PAGES = new Set(["setup", "signon", "results", "standdown"]);

/* A race in either of these states is under way, so the whole app stays quiet
   regardless of which page is open. */
const ACTIVE_RACE_STATUSES = new Set(["sequence", "racing"]);

/**
 * Whether it is a good moment to offer an update. Pure, so the rule can be
 * tested directly rather than inferred from the DOM.
 *
 * @param {object} state
 * @param {string|null} state.page current route name
 * @param {string[]} state.raceStatuses statuses of every race known locally
 */
export function canPromptNow({ page, raceStatuses = [] }) {
  if (!PROMPT_PAGES.has(page)) return false;
  return !raceStatuses.some((status) => ACTIVE_RACE_STATUSES.has(status));
}

/**
 * @param {object} opts
 * @param {(apply: () => void) => void} opts.onAvailable called when a new build
 *   is waiting; hand it the function that applies the update.
 */
export async function startUpdateWatch({ onAvailable }) {
  if (!("serviceWorker" in navigator)) return null;

  let registration;
  try {
    // Relative path so the worker's scope is this directory, which is what
    // makes the app work as a GitHub Pages project site.
    //
    // updateViaCache:"none" because GitHub Pages serves sw.js with
    // max-age=600; without it the browser could keep checking a cached copy
    // and not notice a new build for ten minutes.
    registration = await navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
  } catch (err) {
    console.error("service worker registration failed", err);
    return null;
  }

  let announced = false;
  const announce = () => {
    // Only ever prompt once per page load, and never on a first-ever install
    // (no controller yet means there is no old build to replace).
    if (announced || !navigator.serviceWorker.controller) return;
    announced = true;
    onAvailable(() => applyUpdate(registration));
  };

  // A build that finished installing during an earlier visit.
  if (registration.waiting) announce();

  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed") announce();
    });
  });

  // Ask the browser to re-check sw.js: once now, whenever the phone comes back
  // to the app, and occasionally while it is sitting open.
  const check = () => registration.update().catch(() => {});
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
  setInterval(check, CHECK_INTERVAL);
  check();

  return registration;
}

function applyUpdate(registration) {
  if (!registration.waiting) {
    globalThis.location.reload();
    return;
  }
  // Reload once the new worker has actually taken control, so the page we come
  // back to is served entirely by the new build rather than a mix of the two.
  navigator.serviceWorker.addEventListener(
    "controllerchange",
    () => globalThis.location.reload(),
    { once: true }
  );
  registration.waiting.postMessage("skip-waiting");
}

/**
 * The update bar in the app shell.
 *
 * A waiting build is remembered rather than shown immediately: if it arrives
 * mid-race the prompt is held back and offered the moment the OOD reaches a
 * calm page. Nothing is lost by waiting — the new worker sits there either way.
 */
export function createUpdatePrompt(bar) {
  const refreshButton = bar.querySelector("#update-refresh");
  const dismissButton = bar.querySelector("#update-dismiss");

  let pendingApply = null;
  let allowed = false;
  let dismissed = false;

  function render() {
    bar.hidden = !(pendingApply && allowed && !dismissed);
  }

  refreshButton.addEventListener("click", () => {
    if (!pendingApply) return;
    refreshButton.disabled = true;
    refreshButton.textContent = "Updating…";
    pendingApply();
  });

  // Dismissing only hides it for this session — the new build stays waiting
  // and offers itself again next time the app is opened.
  dismissButton.addEventListener("click", () => {
    dismissed = true;
    render();
  });

  return {
    /** Pass to startUpdateWatch as onAvailable. */
    onAvailable(apply) {
      pendingApply = apply;
      render();
    },
    /** Called whenever the page or the race state changes. */
    setAllowed(next) {
      allowed = next;
      render();
    },
    get visible() {
      return !bar.hidden;
    },
  };
}
