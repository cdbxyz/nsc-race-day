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
 * Wire the update bar in the app shell.
 * @returns {(apply: () => void) => void} an onAvailable handler
 */
export function updateBanner(bar) {
  const refresh = bar.querySelector("#update-refresh");
  const dismiss = bar.querySelector("#update-dismiss");

  return (apply) => {
    bar.hidden = false;
    refresh.addEventListener("click", () => {
      refresh.disabled = true;
      refresh.textContent = "Updating…";
      apply();
    });
    // Dismissing only hides it for this session — the new build stays waiting
    // and will offer itself again next time the app is opened.
    dismiss.addEventListener("click", () => {
      bar.hidden = true;
    });
  };
}
