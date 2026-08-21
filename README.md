# NSC Race Day

Officer of the Day race management for Nefyn Sailing Club — an offline-first
PWA that runs a whole race day from a phone on a beach with no signal.

See [ARCHITECTURE.md](ARCHITECTURE.md) for scope, schema and behaviour, and
[CLAUDE.md](CLAUDE.md) for the rules any change has to respect.

## Documentation

| Document | For whom |
|---|---|
| [GUIDE.md](GUIDE.md) | The Officer of the Day. Plain language, no jargon. Also rendered in the app at `#/guide`, from this same file, and precached so it works with no signal. |
| [DRILL.md](DRILL.md) | Whoever maintains the app. The pre-season offline drill, automated and physical-device halves. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Anyone changing the code. Scope, schema and the decisions behind them. |
| [CLAUDE.md](CLAUDE.md) | The project's hard rules. Read before any work. |

## Running it

There is no build step. Serve the repo root over HTTP (a service worker needs
`localhost` or HTTPS — opening `index.html` from the filesystem will not work):

```sh
python3 -m http.server 8000
# then http://localhost:8000
```

Deployment is `git push`: GitHub Pages serves the repo as-is. Every path in the
app is relative so it works from `/nsc-race-day/`.

## Working on it

```sh
npm install   # devDependency: fake-indexeddb — also wires up the git hook
npm test
```

Node is used for nothing but tests and the cache stamp. Neither runs at deploy
time; the repo is served exactly as committed.

### The cache stamp

`sw.js` precaches the app shell so the app opens with no signal. That makes a
stale cache the worst kind of bug — phones keep running an old build, and you
find out on the beach. Two things have to stay in step with the files on disk:
the list of files to precache, and the cache version that invalidates the old
copies. Both are generated rather than remembered.

**[tools/stamp-sw.mjs](tools/stamp-sw.mjs)** scans `index.html`, `css/`, `js/`
and `fonts/`, writes the file list into the generated block in `sw.js`, and
sets `VERSION` to a hash of those files' contents. Add a page module and it
appears in the precache list on its own; change a single byte and the cache
name changes with it. Run it with `npm run stamp`. Never edit the generated
block by hand.

Three layers make sure it actually happens:

1. **`npm install`** runs [tools/install-hooks.mjs](tools/install-hooks.mjs)
   via npm's `prepare` script, which sets `core.hooksPath` to `.githooks`.
   That config is per-clone, so without this a fresh clone silently loses the
   hook. It no-ops outside a git repo, so CI checkouts don't break.
2. **The pre-commit hook** ([.githooks/pre-commit](.githooks/pre-commit)) runs
   the stamper and re-stages `sw.js`, so committing a shell change stamps it
   whether or not you remembered.
3. **`npm test`** fails if `sw.js` has drifted from the files on disk — the
   backstop for a clone where step 1 never ran (`npm install --ignore-scripts`,
   a tarball, a manual copy).

### Updates on the phone

A new build installs in the background and **waits**. The app shows a small
"Update available — tap to refresh" bar; nothing swaps over until the OOD taps
it, and the reload that follows is safe by design — every screen is rebuilt
from the event log in IndexedDB.

The bar is held back entirely while the OOD has their hands full: it appears
only on the setup, sign-on, results and stand-down pages, and never while any
race is in `sequence` or `racing`. A build that lands mid-race is remembered
and offered as soon as the app returns to a calm page.

## What's here so far

Phase 1 of six — the plumbing, with the seven OOD pages as placeholders.

| | |
|---|---|
| `js/db.js` | IndexedDB + outbox. `localWrite()` commits a row and its outbox entry in one transaction. |
| `js/sync.js` | Drains the outbox to a backend with exponential backoff. Currently a fake backend that fails 30% of pushes; Phase 2 swaps in Supabase. |
| `js/resume.js` | Finds an unfinished race day on load and offers it back. |
| `js/router.js`, `js/app.js` | Hash router over the seven page sections. |
| `sw.js` | Cache-first app shell. Its file list and cache version are generated — see [The cache stamp](#the-cache-stamp). |
| `js/update.js` | Registers the worker and offers a new build as a prompt rather than swapping silently. |
| `js/pages/dev.js` | `#/dev` harness: write events, watch the outbox, force a flush, wind the failure rate up. |

`reference/index.html` is the club's existing race calculator, kept for the
scoring and PDF port in Phase 5.

## Checking it survives the beach

1. Load the app once, then go offline in DevTools and hard-reload — it should
   render completely, fonts included.
2. `#/dev` → Write test event a few times with the network off. The sync pill
   climbs "Offline · N waiting".
3. Back online: the pill drains to "All synced" despite the fake backend
   rejecting roughly a third of pushes.
4. Quit the browser, reopen: the resume banner names the day and the
   furthest-progressed race.
