/* pin.js — the club PIN prompt.
 *
 * Shown once per device. Everything the OOD does works offline without it;
 * the PIN only decides whether the outbox can reach Supabase. So this must
 * never block the app — it appears, it can be dismissed, and racing carries on
 * regardless with events piling up safely in IndexedDB.
 */

import * as api from "./supabase.js";

export function createPinPrompt(dialog, { onSignedIn } = {}) {
  const form = dialog.querySelector("#pin-form");
  const input = dialog.querySelector("#pin-input");
  const error = dialog.querySelector("#pin-error");
  const submit = dialog.querySelector("#pin-submit");
  const later = dialog.querySelector("#pin-later");

  function setError(message) {
    error.textContent = message || "";
    error.hidden = !message;
  }

  function open() {
    setError("");
    input.value = "";
    submit.disabled = false;
    submit.textContent = "Sign in";
    if (!dialog.open) dialog.showModal();
    input.focus();
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const pin = input.value.trim();
    if (!pin) return;

    submit.disabled = true;
    submit.textContent = "Checking…";
    setError("");

    try {
      await api.signInWithPin(pin);
      close();
      onSignedIn?.();
    } catch (err) {
      // Say what happened plainly. A volunteer on a beach needs to know
      // whether to try again, wait, or go and find someone.
      if (err.code === "too_many_attempts") {
        setError("Too many wrong PINs. Try again in 15 minutes.");
      } else if (err.code === "invalid_pin") {
        const left = err.remaining;
        setError(
          typeof left === "number" && left <= 3
            ? `PIN not recognised. ${left} ${left === 1 ? "try" : "tries"} left.`
            : "PIN not recognised."
        );
      } else if (err.status === 0 || !navigator.onLine) {
        setError("No signal. You can carry on — everything is saved on the phone.");
      } else {
        setError(err.message || "Could not sign in.");
      }
      submit.disabled = false;
      submit.textContent = "Sign in";
      input.select();
    }
  });

  later.addEventListener("click", () => close());

  // Escape closes the dialog; make sure that path is not treated as an error.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });

  return { open, close };
}
