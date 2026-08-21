/* The OOD guide, in the app.
 *
 * Rendered from GUIDE.md itself so there is exactly one copy: the file in the
 * repo IS the page. A second HTML version would drift, and the copy that was
 * wrong would be the one somebody read on the beach.
 *
 * GUIDE.md is precached with the rest of the shell, so this works with no
 * signal — which is the whole point, because the OOD who needs the guide is
 * the one who is stuck.
 */

import { el, clear, panel, notice } from "./../ui.js";
import { renderMarkdown } from "./../markdown.js";

let host = null;
let cached = null;

export default {
  title: "Guide",

  async mount(section) {
    host = section.querySelector("#guide-body");
    await render();
  },

  unmount() {
    host = null;
  },
};

async function render() {
  if (!host) return;
  clear(host).append(el("p.stub", { text: "Loading the guide…" }));

  try {
    // Relative, so it resolves under the GitHub Pages sub-path too.
    if (cached == null) {
      const res = await fetch("GUIDE.md", { cache: "no-cache" });
      if (!res.ok) throw new Error(`${res.status}`);
      cached = await res.text();
    }
    const body = el("div.guidedoc");
    body.append(renderMarkdown(cached));
    clear(host).append(body);
  } catch (err) {
    clear(host).append(
      panel("Guide unavailable", [
        el("div.panel-body", {}, [
          notice(
            "The guide could not be loaded on this phone. It is normally stored for offline use — reopen the app somewhere with signal once, and it will be there next time.",
            "error"
          ),
          el("p.stub", { text: `(${err.message})` }),
        ]),
      ])
    );
  }
}
