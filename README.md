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

## Tests

Node is used for nothing but tests.

```sh
npm install   # one devDependency: fake-indexeddb
npm test
```

## What's here so far

Phase 1 of six — the plumbing, with the seven OOD pages as placeholders.

| | |
|---|---|
| `js/db.js` | IndexedDB + outbox. `localWrite()` commits a row and its outbox entry in one transaction. |
| `js/sync.js` | Drains the outbox to a backend with exponential backoff. Currently a fake backend that fails 30% of pushes; Phase 2 swaps in Supabase. |
| `js/resume.js` | Finds an unfinished race day on load and offers it back. |
| `js/router.js`, `js/app.js` | Hash router over the seven page sections. |
| `sw.js` | Cache-first app shell. **No build step, so the `SHELL` list is maintained by hand — add a file, add it to the list and bump `VERSION`.** |
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
