# NSC Race Day — project rules

This is a mobile-first PWA for a sailing club Officer of the Day, per ARCHITECTURE.md
(read it before any work — it is the source of truth for scope, schema and behaviour).

Hard rules:
- **No real secret ever appears in any file in this repo.** It is public, and
  git remembers deleted lines — a leaked value must be rotated, not just
  removed. Documentation, SETUP.md and every code sample use `<placeholder>`
  values only; example SQL calling `set_club_pin` shows a placeholder, never
  digits. Service-role keys and database passwords live in the Supabase
  environment and are read from there, never written down. The pre-commit
  hook runs `tools/scan-secrets.mjs` and will refuse the commit.
- Duty roles: **OOD** = Officer of the Day, who runs the race. **RO1** and
  **RO2** = **Rescue Officers** 1 and 2, who crew the rescue boat. Never
  "Race Officer" — they are rescue crew, not race management. Display as
  "Rescue Officer 1 (RO1)" where there is room and "RO1" where compact
  (headers, PDF, CSV). The `ro1_name` / `ro2_name` columns and `ro1Name` /
  `ro2Name` identifiers are already correct and are not to be renamed.
- **Seed migrations for committee-editable data are INSERT ONLY.** Checklist
  templates and the like are seeded once; after first deploy the dashboard is
  the source of truth and a re-run must never replace an existing row. A
  seed that overwrites silently discards the committee's own wording.
- **There are no hulls. The combination is the identity.** A `combinations`
  row is helm (+ crew) in a class, and it is what persists at this club. An
  entry carries `class_id` (where the PY comes from), `helm_id`, optional
  `crew_id`, and optional `sail_no` — the number is a fact about THAT RACE,
  because a helm may borrow a different boat next week. The boats table was
  dropped in 017 and must not come back: it added a decision at every sign-on
  and every row ended up unused. `helms` is the members register for
  everyone: a person helms one week and crews the next; there is no second
  people table. Handicap wins and factors attach to the HELM alone, whoever
  is crewing.
- **Combinations are a real table, not a derivation.** A derived list is
  empty on the first morning of the fortnight, which is the busiest sign-on
  of the year. They are committee-editable, pulled down with the other
  reference data so a rotating OOD on a fresh phone sees the club's pairings
  offline, and self-maintaining: `addEntry` upserts the combination, so one
  nobody seeded still appears after its first race. Identity is
  (helm, crew, class) with **null crew treated as a value** — solo and
  crewed are different pairings, not one with a field missing. Retire, never
  delete: the history belongs to the row.
- The club is **Nefyn Sailing Club (never Netley)**. NSC expands to Nefyn
  Sailing Club everywhere it appears — UI copy, page titles, the PWA manifest,
  PDF and print headers, CSV exports. Check this whenever you write club-facing
  text; it has been wrong before.
- Buildless vanilla JS with ES modules. No frameworks, no bundlers, no build step.
  The repo must deploy to GitHub Pages by push alone.
- Offline-first: every user action commits to IndexedDB synchronously before
  anything else; Supabase sync is via the outbox and must be idempotent
  (upserts keyed on client-generated UUIDs).
- Race actions are an append-only event log. Never mutate or delete an event;
  corrections and undo are new events. All race state = pure function of events.
- Timestamps are captured on-device at tap time. Timers are computed from stored
  timestamps against the wall clock, never from running intervals.
- Mobile phone is the only target. Big touch targets (44px+), no long-press
  gestures, no hover-dependent UI. Test at 390px width.
- Visual language: carry over the design system in css/app.css (French navy
  #0A1B3D, chalk white, red #C8102E accents, Barlow Condensed display) — it
  matches the club's existing race calculator. Body and numeric text are
  Atkinson Hyperlegible Next / Mono, chosen for legibility in sun glare;
  all fonts are self-hosted in fonts/, never loaded from a CDN. Times and
  numeric columns use tabular figures.
- Keep scoring.js and handicap.js pure (no DOM, no IO) and covered by tests.
- Prefer boring, readable code over clever code. A committee volunteer may
  maintain this one day.
- The sw.js cache version and shell list are GENERATED — run `npm run stamp`,
  never edit the block by hand. `npm test` fails if they have drifted.

  - CLAUDE.md is living documentation. Any session that changes a
  convention this file describes (fonts, tooling, workflows, naming)
  must update the relevant rule in the same commit.

  - Any new race_events.type or races.status value must ship with a
  migration updating the corresponding CHECK constraint in the same
  commit — the server refuses unknown values and the row quarantines.
- Never use native blocking dialogs (alert/confirm/prompt). Inline
  sheets and tap-to-arm patterns only.
- **A register entity is CHOSEN, never typed.** Anywhere the user picks a
  helm, crew, class, boat or programme race, use `pickerField` /
  `openPicker` from ui.js: filter-as-you-type over what already exists,
  with adding something new as a separate, deliberate tap. Free-text boxes
  with a `<datalist>` are not acceptable — the phone keyboard's own autofill
  sits above the suggestions, a wet thumb takes the wrong one, and the
  register gains a duplicate person. Every duplicate splits a handicap
  history, which is the one thing this app must not get wrong. Filter inputs
  spread `NO_AUTOFILL`.
- **A disabled primary action must say why**, in one line beneath it, via
  `actionWithReason` from ui.js. A greyed-out button with no explanation is
  a dead end on a beach: the OOD cannot tell whether the app is broken or
  whether they have missed a step. Compact chrome may carry the reason in
  its label and `title` instead, but it must carry it somewhere.
- **`races.start_at` is the wall-clock moment the countdown crossed zero**,
  never `sequence_start_at + 10 minutes`. Those coincide only at 1x with no
  general recall. Derive it with `wallClockAt()`, the exact inverse of
  `scaledNow()`. The dev fast clock scales the instants fed to the ordinary
  pure functions and never branches; only DISPLAY durations are compressed,
  so `resultInputs` takes no speed and results are always computed from real
  stored timestamps.
- **Non-production modes must be impossible to miss and impossible to keep.**
  Any dev state that could survive into a real race day belongs in
  `devmode.js`: it paints a persistent, undismissable banner in the app
  shell (above every page, live race and results included), it lives in
  module memory with nothing written to any storage API so a reload is
  always a return to production, and a race day begun while it is active is
  branded `is_test_data` and records no handicap win. Adding a third dev
  mode means adding it to `activeModes()`, not remembering to paint another
  banner. The sync destination is the dangerous one: on the fake backend the
  sync pill still cheerfully reads "All synced".
- **A race day is claimed by one device.** `device.js` holds the claim; a
  second phone sees everything read-only with a visible "Take over on this
  device". The lock is SOFT and must stay soft: the losing device keeps
  every row and keeps draining its outbox, because discarding unsynced
  events is the one unrecoverable act in this system and the losing phone
  often holds the only copy of the last few taps. An unclaimed day (created
  before the feature, or synced down) is claimable by anyone — never
  read-only for everybody.
- **Timestamps are only as good as the phone's clock**, so `clockcheck.js`
  compares against the `Date` header on every PostgREST reply and warns in
  the shell when the device is more than 90s out. Advisory only: it never
  rewrites a stored timestamp and never blocks a write. A known offset is
  recoverable; an unknown one is not.
- **Anything read to ACT ON mid-race uses `--hull` or `--ink`, never
  `--slate`.** The hint grey is 5.1:1 — legal under WCAG AA and washed out on
  a phone at arm's length in July sun. `--hull` is 10.9:1. AA is the floor
  here, not the target, and critical text stays at 10px or larger. Every tap
  target clears 44px in BOTH directions: the footer links were 44 tall and 35
  wide, which counts as a failure.
- **Wind is recorded per race on the Beaufort scale** (F0–F8) plus an
  8-point compass direction it blows FROM. Beaufort because it is what an
  OOD can judge by eye from the beach without an anemometer, and what the
  club's own race reports already use. Captured on the start-sequence page,
  editable on results until publish, and carried into the results sheet,
  PDF and CSV.