# NSC Race Day — project rules

This is a mobile-first PWA for a sailing club Officer of the Day, per ARCHITECTURE.md
(read it before any work — it is the source of truth for scope, schema and behaviour).

Hard rules:
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