# NSC Race Day — Architecture & Solution Design

**Status:** Agreed — scope locked, build-ready
**Date:** 15 August 2026
**Scope:** v1 — handicap races only, phone-only OOD device, GitHub Pages + Supabase

---

## 1. What we're building

A mobile web app that walks the Officer of the Day through an entire race day: duty setup, boat/helm sign-on with automatic personal handicaps, pre-race safety checklist, start sequence timer, live lap-and-finish recording, calculated results, and a stand-down checklist that doubles as the tally check. Multiple back-to-back races share one sign-on. Data persists in Supabase; the app must survive browser crashes, phone sleep, and — critically — the patchy 4G at the beach.

### Constraints that shape everything

The beach has unreliable signal, so the app cannot depend on connectivity at the moment of any tap. The OOD is a rotating volunteer on a phone, possibly with wet hands and sun glare, so every interaction must be large, forgiving, and undoable. There are no user accounts — accountability comes from recording the OOD, RO1 and RO2 names per race day. Race times are safety and fairness records: nothing recorded may ever be silently lost.

---

## 2. Headline decisions

**D1 — Offline-first PWA, not write-through.** The original instinct ("write every tap to the database immediately") fails when signal drops. Instead: every tap writes *synchronously to IndexedDB on the device* (survives crash, sleep, reload, and being offline for the whole race), and a background sync engine pushes to Supabase whenever connectivity allows. The app is installable as a PWA with a service worker caching the app shell, so it opens instantly on the beach even with zero signal.

**D2 — Append-only event log for race actions.** Every race action is an immutable event: `race_started`, `lap_recorded`, `boat_finished`, `code_applied`, `event_undone`, `general_recall`, `race_abandoned`. Results are always *calculated* from the event log, never stored as mutable state. Reload = replay events = exact recovery. Mistakes are corrected by appending an undo event that tombstones an earlier one — the original record is never destroyed, which matters for a safety log.

**D3 — Timestamps captured at tap time, on-device.** An event's time is `Date.now()` at the moment of the tap, stored in the event itself. Sync delay never corrupts race times. The countdown timer is *computed* from a stored `sequence_start_at` timestamp versus the wall clock — never a running JS interval — so a phone that sleeps for four minutes wakes up showing the correct remaining time.

`start_at` is the wall-clock instant the countdown crossed zero — **not** `sequence_start_at + 10 minutes`. Those coincide only at 1× with no general recall, and the dev fast clock breaks the coincidence: at 60× the sequence really takes ten seconds, so the projected value lands ten real minutes in the future and every elapsed time computed from it comes out negative. The gun is derived with `wallClockAt()`, the exact inverse of `scaledNow()`, so it stays exact to the millisecond even if the phone sleeps straight through the crossing.

The dev fast clock covers the whole race, not just the sequence. It works by scaling the instants handed to the ordinary pure functions — `countdown()`, `raceClock()`, `boatState()` — never by branching, so what is tested is what ships. Only *display* durations are ever compressed: `resultInputs()` takes no speed argument at all, so the results sheet is always computed from real stored timestamps. A 60× race therefore produces genuinely short elapsed times that will not match the clock the OOD watched, and the day carries `is_test_data` to say so.

**D4 — Buildless vanilla JS, ES modules, no framework.** Consistent with the existing calculator's ethos and your iteration style. No bundler, no build step: push to GitHub Pages and it's live. Supabase JS client loaded as an ES module from CDN. The existing scoring engine (lap adjustment, RRS codes, low-point points, tie averaging) is ported into a pure `scoring.js` module and reused verbatim.

> **Amended in Phase 2 — no CDN client.** The Supabase JS client is not used.
> A CDN import is a cross-origin dependency the service worker cannot precache,
> so a phone that is offline (or a CDN that is down) fails to boot the app at
> all — which defeats D1. `js/supabase.js` instead calls the REST and auth
> endpoints with plain `fetch`: four operations in all (exchange PIN for
> session, refresh session, upsert, select). Same reasoning as self-hosting the
> fonts rather than loading them from Google.

**D5 — Shared club PIN, exchanged for a real Supabase session.** No per-user accounts, but the database can't be world-writable either (the anon key ships in public JS). A tiny Supabase Edge Function accepts the club PIN and signs the device into a single shared club account; RLS then permits writes only to authenticated sessions. Entered once per device, remembered thereafter. Public (unauthenticated) reads are allowed only on *published* results — which gives you the members' results page on the website for free.

**D6 — Single-writer model.** One OOD phone runs a race day. This removes all conflict-resolution complexity (last-write-wins is safe). A second device can *view* live state read-only. Multi-recorder support is explicitly out of scope for v1 and the event model doesn't preclude adding it later.

**D7 — Elapsed times derive from taps — no manual time entry during racing.** The race start event and each boat's finish event carry timestamps; elapsed time and lap counts are computed. The results page allows manual correction *before publishing* (recorded as correction events), and retains a fully manual entry mode as fallback for a race scored on paper.

---

## 3. System architecture

```
┌─────────────────── OOD's phone (PWA) ───────────────────┐
│                                                          │
│  UI pages (setup → sign-on → checklist → sequence →      │
│            live race → results → stand-down)             │
│        │                                                 │
│  state.js  ← pure reducers: state = f(events)            │
│        │                                                 │
│  db.js  ── IndexedDB ──┐   synchronous local write       │
│        │               │   (source of truth on race day) │
│  sync.js ── outbox ────┘                                 │
│        │  retries with backoff; flushes on               │
│        │  'online' events + visibilitychange             │
└────────┼─────────────────────────────────────────────────┘
         │  HTTPS when signal allows — idempotent upserts
         ▼
┌──────────────── Supabase ────────────────┐
│  Postgres (schema below) + RLS           │
│  Edge Function: pin-auth                 │
│  Public read on published results        │
└──────────────────────────────────────────┘
         ▲
         │  read-only
   Club website results page / members' phones
```

### Sync engine mechanics

Every mutation gets a client-generated UUID and goes to two places in one IndexedDB transaction: the local table and the `outbox`. The sync loop pushes outbox rows to Supabase as **upserts keyed on that UUID** — retries are therefore idempotent; a request that succeeded but whose response was lost does no harm when retried. Outbox rows are marked synced only on confirmed success. The UI shows a persistent, honest sync indicator: *all synced / N events waiting / offline*. Reference data (members, classes, combinations, the season programme and season results for handicaps) is pulled and cached in IndexedDB whenever online, with a "last refreshed" stamp visible at sign-on.

### Crash/sleep/reload recovery

On every app load: read local IndexedDB first (instant, works offline), find any race day/race with status ≠ complete, and offer **"Resume: Race 2 — racing, 34:12 elapsed"** as the primary action. Because state is a pure function of the event log, resume is exact. Screen Wake Lock API is requested during the sequence and live race to prevent sleep in the first place; recovery handles the cases where it fails.

---

## 4. Data model

Seven core tables plus checklists. All primary keys are client-generatable UUIDs.

```sql
create table helms (
  id uuid primary key,
  name text not null,
  created_at timestamptz default now()
);

create table classes (
  id uuid primary key,
  name text not null unique,       -- e.g. Laser 2000
  base_py int not null,            -- from RYA PY list; annual update ripples to every boat
  created_at timestamptz default now()
);

-- There is no boats table. Named hulls were dropped in 017: they added a
-- decision at every sign-on for a club that thinks in pairings, and every row
-- ended up inactive with no entry pointing at one. The sail number an OOD
-- actually needs lives on the entry, because it is a fact about that race.

create table combinations (
  id uuid primary key,
  helm_id uuid references helms not null,
  crew_id uuid references helms,   -- null = solo, a DIFFERENT pairing
  class_id uuid references classes not null,   -- where the PY comes from
  default_sail_no text,            -- pre-filled at sign-on, editable per race
  times_raced int not null default 0,          -- maintained by addEntry
  last_raced timestamptz,
  active boolean not null default true,        -- retire, never delete
  created_at timestamptz default now()
);
-- Null crew is a VALUE, not a missing field, so the unique index coalesces it:
--   (helm_id, coalesce(crew_id, nil-uuid), class_id)

create table race_days (
  id uuid primary key,
  date date not null,
  ood_name text not null,
  ro1_name text,
  ro2_name text,
  status text not null default 'open',   -- open | complete
  created_at timestamptz default now()
);

create table series (
  id uuid primary key,
  name text not null,
  season int not null,             -- e.g. 2026
  discard_rule jsonb               -- v1: stored, not yet used
);

create table races (
  id uuid primary key,
  race_day_id uuid references race_days not null,
  series_id uuid references series,
  number int not null,             -- Race 1, 2, 3 within the day
  name text,
  status text not null default 'setup',
  -- setup | prestart | sequence | racing | finished | published | abandoned
  sequence_start_at timestamptz,   -- when 10-min gun fired
  start_at timestamptz,            -- the wall-clock moment the countdown crossed zero
  fast_laps int not null default 3,          -- lap plan, fast fleet (base PY < 1168)
  slow_laps int not null default 2,          -- lap plan, slow fleet (base PY >= 1168)
  published_at timestamptz         -- shorten-course updates fast_laps/slow_laps via event
);

create table entries (
  id uuid primary key,
  race_id uuid references races not null,
  class_id uuid references classes not null,   -- where the PY comes from
  helm_id uuid references helms not null,
  crew_id uuid references helms,   -- optional even in a double-hander
  sail_no text,                    -- THIS race only; a helm may borrow a boat
  base_py int not null,            -- snapshot of class base PY at entry time
  handicap_factor numeric not null default 1.0,  -- 1.0 / .97 / .96 / .95
  personal_py numeric not null,    -- base_py × factor, the PY actually used
  fleet text not null,             -- 'fast' (base PY < 1168) | 'slow' (>= 1168)
  laps_override int,               -- per-boat exception to the fleet lap plan
  unique (race_id, helm_id)        -- a helm sails one boat per race
);

create table race_events (
  id uuid primary key,             -- client-generated; upsert key
  race_id uuid references races not null,
  entry_id uuid references entries,          -- null for race-level events
  type text not null,
  -- sequence_started | postponed | general_recall | race_abandoned | course_shortened |
  -- lap_recorded | boat_finished | code_applied | event_undone | correction
  payload jsonb,                   -- e.g. {code:"OCS"} or {undoes:"<event uuid>"}
  occurred_at timestamptz not null,          -- device tap time
  recorded_at timestamptz default now()      -- server receipt time
);

create table checklist_templates (
  id uuid primary key,
  kind text not null,              -- pre_race | stand_down
  items jsonb not null             -- ordered [{id, label}]
);

create table checklist_runs (
  id uuid primary key,
  race_day_id uuid references race_days not null,
  template_id uuid references checklist_templates not null,
  kind text not null,
  responses jsonb not null,        -- {item_id: {done, at, note}}
  completed_at timestamptz
);
```

Sign-on lives at race-day level in practice (back-to-back races share it): the UI carries the entry list forward from race to race, creating fresh `entries` rows per race so each race's snapshot of PYs and handicap factors is independent and auditable.

### Why snapshot `personal_py` on the entry

The helm's handicap factor changes as the season progresses. Storing the applied PY on each entry means historical results never shift retroactively when a helm wins again, and every result sheet is self-explanatory ("Vaila, PY 930 × 0.97 = 902.1").

---

## 5. Handicap engine

A helm's factor for a given race = f(number of qualifying wins by that helm earlier in the current season): 0 wins → 1.00, 1 win → 0.97, 2 wins → 0.96, 3+ wins → 0.95 (capped). A *qualifying win* is 1st place on corrected time in a published handicap race in the same season; coded results (DNF, DSQ etc.) never count as wins; abandoned races produce no results.

Computed, not stored: a SQL view (`helm_season_wins`) counts wins per helm per season from published results; the sign-on page reads it (from cache when offline — refreshed whenever online) and stamps the resulting factor onto the entry. The sign-on card shows it plainly: **"Chris — 2 wins this season → PY × 0.96"**, with a manual override control for committee discretion (override recorded on the entry).

Same-day application is confirmed: a helm who wins Race 1 carries the reduced factor into Race 2 that afternoon. The win count therefore includes races published earlier the same day — which the local event data covers even when fully offline, since Race 1's results were computed on-device.

---

## 6. Scoring engine

Direct port of the proven calculator logic into a pure, dependency-free `scoring.js`: lap-adjusted elapsed (elapsed × max laps ÷ laps sailed), corrected = lap-adjusted × 1000 ÷ personal PY, RRS low-point points with coded boats scoring starters + 1 and ties sharing averaged points. Inputs now come from the event log — elapsed = finish event time − race `start_at`; laps = count of un-undone lap events + the finish — but the module accepts plain numbers, so the manual-entry fallback and unit tests use the exact same code path. The PDF writer (`NSCPDF`), CSV copy, and print output carry over as-is, with the addition of the handicap column.

---

## 7. The OOD journey, page by page

**0 — Race day setup.** Date (defaults today), OOD / RO1 / RO2 names (recent names suggested), pick or create the series, number of races planned. If an unfinished race day exists locally, the resume banner takes over the top of this screen.

**1 — Sign-on.** The full club combinations register, most-raced first then most-recent, with search-as-you-type over helm, crew, class or sail number; one tap signs a pairing on and pre-fills its usual sail number, editable per race. New combinations creatable inline through pickers (class, helm, crew) plus a free-text sail number. Because combinations are a real table pulled down with the reference data, a rotating OOD on a phone that has never run a race sees the whole club list offline — the derived version was empty on the first morning of the fortnight. Each card shows class, base PY, helm, win badge, applied personal PY (e.g. "Hamish · Laser 2000 · 1122 × 0.97 = 1088 (1 win)"), and fleet — fast (base PY below 1168, 3 laps by default) or slow (1168 and above, 2 laps) — with a per-boat lap override for oddities. Race setup carries the lap plan itself (fast/slow lap counts, defaulting 3/2). This list is the day's tally record. Late entries can be added even mid-race (they'll have started with the fleet).

**2 — Pre-race checklist.** Template-driven (editable in Supabase without code changes): rescue boat prepped and fuelled, radios checked, first aid aboard, flags ready, tide/weather noted, etc. Each item is a large toggle stamped with time. Completable offline. A "proceed anyway" path exists but flags the run as incomplete — the OOD stays in charge, the record stays honest.

**3 — Start sequence.** One big button: **Start 10-minute sequence** — writes the `sequence_started` event and everything else is derived. Full-screen countdown with flag-state banner (10: class up · 5: P flag up · 1: P down · 0: START), colour shift and vibration at each mark (no sound signals per your spec — phone stays a visual aid beside the real horn). Two always-visible controls: **Postpone (AP)** — abandons the sequence, ready to restart; **General recall** — appends the event and re-arms the sequence. At zero the race flips to `racing` and the live page opens itself.

**4 — Live race.** The heart of it. A grid of boat cards, sized so ~8 fit a phone screen without scrolling. Each card: boat name, helm, lap progress ("2 of 3") and each crossing as elapsed race time ("L1 4:12 · L2 8:23", becoming "L1 4:12 · L2 8:23 · F 12:41" on finishing), and one big explicit button that walks the boat through its race — **Lap 1 → Lap 2 → Finish** — becoming **Finish** on the boat's planned final lap, so the last crossing is a single tap and no boat can be given a lap it isn't due. No long-press gestures anywhere. A small **⋯** on each card opens the secondary sheet: OCS · RET · DNF · DSQ · undo this boat's last event. Finishing moves the boat to a "finished" rail at the top with its elapsed time, keeping the still-racing fleet prominent. A global **Undo** reverses the last event (appending `event_undone`); an event history drawer allows undoing any specific mistake. Race clock and sync indicator pinned top. Two race-level actions behind a two-step confirm: **Shorten course** — set new fast/slow lap counts (e.g. 3/2 → 2/1); by convention this is raised before any boat reaches the shortened finish, so still-racing boats simply see their button become Finish (or remaining laps reduce) and already-finished boats are untouched, with no retroactive logic — and **Abandon race**, which produces no results but preserves the sign-on for a resail.

**5 — Results.** Scoring engine output in the familiar results table: position, sail number (column dropped entirely when nobody in the race has one), helm, class, PY (base × factor), laps, elapsed, lap-adjusted, corrected, points, behind-leader. Correction affordances before publishing (adjust laps/elapsed/code — each an auditable `correction` event). **Publish** freezes the race, makes it publicly readable, and feeds the win into the handicap view. Copy / PDF / print as today. Then: **Next race →** loops back to sign-on with the entry list carried forward (drop-outs deselectable), or onward to stand-down.

**6 — Stand-down.** Opens with the auto-generated tally check: every signed-on boat listed as *finished / coded / **unaccounted***, and unaccounted boats blocking completion in red — this is the safety net, generated from data rather than memory. Then the stand-down template (rescue boat recovered, refuelled, radios stowed, incidents to report — free-text incident note feeding the club's RNLI-clinic agenda). Completing it closes the race day and pushes any final unsynced events.

---

## 8. Resilience — the failure matrix

**Browser crash / accidental close:** every event already in IndexedDB before the UI even repaints → reopen, resume banner, exact state. **Phone sleeps mid-race:** Wake Lock requested; if it sleeps anyway, timers recompute from timestamps on wake — no drift. **No signal all afternoon:** everything works locally; outbox flushes on the drive home; the phone must simply not be *cleared* before syncing (the sync indicator makes outstanding-event count impossible to miss, and closing the day while unsynced shows a hard warning). **Phone dies mid-race:** the true disaster case — mitigated by whatever has synced (patchy ≠ zero: most events will land within seconds when signal flickers in), so the paper backup finally has a digital ally rather than the reverse. Worth stating in the OOD guide that a charged phone is now race kit. **Wrong tap:** undo events, nothing destroyed. **Two OODs open the same race:** single-writer rule stated in-app; a soft lock (race claimed by device ID, with visible takeover) prevents accidents without ever locking out a legitimate handover.

---

## 9. Auth & RLS summary

`pin-auth` Edge Function: club PIN in → session for the shared club account out; PIN lives in Supabase secrets, rotatable by the committee without redeploying. RLS: authenticated role can insert/update everything; anon role can select only `races` where `status = 'published'` plus their entries, events-derived results view, and the series tables. The member, class and combination registers are readable to authenticated only (names of members ≠ public data — worth keeping GDPR-tidy given the club now holds a member-ish database).

---

## 10. Repository structure

```
nsc-race-day/
├── index.html              app shell (all pages, hidden sections)
├── manifest.json           PWA manifest (installable, icon, standalone)
├── sw.js                   service worker: cache-first app shell
├── css/app.css             design system carried over from the calculator
├── js/
│   ├── app.js              router + page lifecycle
│   ├── state.js            reducers: state = f(events)
│   ├── db.js               IndexedDB wrapper + outbox
│   ├── sync.js             outbox flush, backoff, status events
│   ├── supabase.js         client init + pin session handling
│   ├── scoring.js          ported calculator engine (pure, tested)
│   ├── handicap.js         factor computation + season wins cache
│   └── pages/              setup / signon / checklist / sequence /
│                           live / results / standdown
├── supabase/
│   ├── migrations/001_schema.sql
│   ├── migrations/002_rls.sql
│   ├── migrations/003_views.sql        helm_season_wins, results view
│   └── functions/pin-auth/index.ts
└── tests/scoring.test.js   the maths must be provably right
```

New repo, keeping `nsc-race-calc` live untouched as the standalone tool (it remains genuinely useful — visiting OODs, paper-scored races, the website embed).

---

## 11. Build phases (→ Claude Code prompts, one per phase)

1. **Foundations** — repo, PWA shell, design system port, IndexedDB + outbox + sync engine with fake backend, resume-on-load. *The risky plumbing first, testable without Supabase.*
2. **Supabase** — project, schema, RLS, pin-auth function, sync engine pointed at the real thing.
3. **Registers & setup** — members, classes, combinations, race day setup, sign-on page, handicap engine + view.
4. **Race running** — checklists, start sequence timer, live race page, event log + undo.
5. **Results & stand-down** — scoring port, corrections, publish, PDF/CSV/print, tally check, stand-down, next-race loop.
6. **Hardening** — offline drills (airplane-mode race day end-to-end), wake lock, iOS Safari quirks, OOD one-pager guide, dry run on the actual beach.

---

## 12. Open questions before build

1. Club PIN approach acceptable to the committee, and who holds/rotates it?
2. Checklist item lists — first drafts needed from the sailing committee (templates are data, so they can evolve freely afterwards).
3. Class register seeding — is there an existing list (spreadsheet, Sailwave file, the RYA PY list) to import?
4. Season definition for handicap resets — calendar year, or the club's sailing season?

None of these blocks the build. Resolved during scoping: same-day handicap application (yes); fleet boundary (fast = base PY strictly below 1168); baseline PY lives on the class, win adjustment follows the helm across boats; live race uses explicit lap/finish buttons, never long-press; shorten course is raised before any boat crosses at the shortened length, so no retroactive finishing.
