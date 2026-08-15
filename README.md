# NSC Race Day

Officer of the Day race management for Netley Sailing Club — an offline-first
PWA that runs a whole race day from a phone on a beach with no signal.

See [ARCHITECTURE.md](ARCHITECTURE.md) for scope, schema and behaviour, and
[CLAUDE.md](CLAUDE.md) for the rules any change has to respect.

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
npm install                        # one devDependency: fake-indexeddb
git config core.hooksPath .githooks  # once per clone — see below
npm test
```

Node is used for nothing but tests and the cache stamp. Neither runs at deploy
time; the repo is served exactly as committed.

### The cache stamp

`sw.js` precaches the app shell, so a stale cache means phones keep running an
old build. Both halves of that are generated rather than remembered:

- `npm run stamp` scans `index.html`, `css/`, `js/` and `fonts/`, writes the
  file list into `sw.js`, and sets `VERSION` to a hash of their contents. Add a
  page module and it appears in the precache list; change a byte and the cache
  name changes with it.
- The pre-commit hook in [.githooks/](.githooks/) runs it and re-stages `sw.js`
  automatically, which is what the `core.hooksPath` line above enables.
- `npm test` fails if `sw.js` has drifted from the files on disk — the backstop
  for a clone where the hook was never enabled.

Never edit the generated block in `sw.js` by hand.

### Updates on the phone

A new build installs in the background and **waits**. The app shows a small
"Update available — tap to refresh" bar; nothing swaps over until the OOD taps
it. That matters mid-race, and the reload it triggers is safe by design —
every screen is rebuilt from the event log in IndexedDB.

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
