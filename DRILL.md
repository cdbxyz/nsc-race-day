# The offline drill

**Who this is for:** whoever is looking after NSC Race Day. Run it once before
the season starts, and again after any change to sync, storage or the service
worker. It takes about twenty minutes.

**Why it exists:** every interesting failure in this app happens with no
signal, and none of them announce themselves. A race day that quietly failed
to save looks exactly like one that worked, right up until somebody goes
looking for the results in September.

---

## How this document is split

The drill is in two parts, and **the split matters**:

| Part | Who runs it | What it proves |
|---|---|---|
| **A — Automated** | A script, in headless Chrome | The plumbing: offline start, local writes, resume, sync recovery |
| **B — Physical device** | **A human, on an actual iPhone** | Everything about being iOS, being installed, and being outdoors |

Part A is run for you and is genuinely verified — every result in it below was
observed, not predicted. **Part B cannot be automated and has never been run
by a machine.** Headless Chrome is not Safari, a desktop is not a phone, and
no amount of emulation tells you whether a screen is readable in July sun.
Part B is the part that needs your hands.

---

# Part A — the automated drill

## Running it

```
npm test                 # all green before you start — no point drilling a known-broken build
python3 -m http.server 8000
node tools/drill.mjs http://127.0.0.1:8000/
```

The script drives a real browser over the DevTools protocol: it installs the
service worker, cuts the network at the OS level (not by faking a flag), runs a
complete two-race day, kills the app mid-day, and brings the network back.

## What it checks, and what a pass looks like

### 1. Cold start online

```
serviceWorkerActive: true
shellCached: 57
```

57 files precached — every script, font, icon and flag. If this number falls,
something has dropped out of the shell list; run `npm run stamp`.

### 2. Cold start with the network off

```
appRenderedOffline: true
fontsLoaded: true
logoDrawn: true
```

The app opens completely from cache. `logoDrawn` is here because `img/` was
missing from the precache list for several weeks — the logo and the four
start-sequence flags loaded from the network, which meant broken images in
exactly the condition the app exists for. Fixed, and now checked.

### 3–4. Set up a day and sign boats on, offline

```
phoneNamed:  "Chris Darcy-Burt's Mac"
racesCreated: 2
signedOn: 6
outboxGrowingOffline: 17
```

The outbox is *supposed* to grow. Rows waiting is the system working.

### 5. Start sequence and race 1

```
sequenceRanOffline: true
dayBrandedTestData: true
race1Ended: true
```

Run on the 60× dev clock so the drill takes minutes rather than an afternoon.
The day is branded test data automatically, which is what stops a drill from
moving anybody's real handicap.

### 6. Results and publish, offline

```
scored: 6
windOnSheet: true
publishAvailable: true
race1Published: "published"
```

Publishing works with no signal — it writes locally and queues, like
everything else.

> **This step found a real bug.** On the first run `windOnSheet` was `false`:
> the wind recorded before the gun vanished the moment the sequence started.
> The start-sequence page held a race object from its last render, the wind
> picker wrote to the stored row, and then arming the gun spread the stale copy
> back over it. Fixed by making `setRaceStatusIfEarlier` merge onto the stored
> row rather than the caller's. This is the kind of thing the drill is for —
> every unit test passed throughout.

### 7. Race 2, still offline

```
race2Current: 2
carryForwardOffered: true
race2Entries: 6
```

Handicaps recalculate from the race just published, offline, from local data.

### 8. Kill the app mid-day

```
outboxSurvivedReload: { before: 70, after: 70 }
resumeBannerShown: true
speedResetTo1x: 1
```

70 rows before, 70 after. The resume banner offers the day back. The dev fast
clock is gone, as it must be after any reload.

### 9. Stand down, still offline

```
standdownWarnsUnsynced: true
```

The hard warning appears with the count. Closing is allowed — the alternative
is an OOD stuck on a beach — but the words are unambiguous about not clearing
the app's data.

### 10. Network back

```
pendingBeforeFlush: 70
syncNeedsPin: true
nothingDroppedWithoutPin: 70
authBarVisible: true
```

The last two lines are the important ones. The session had expired during the
drill, and **not one row was dropped**: all 70 stayed queued, and the app asked
for the PIN instead of retrying silently forever.

**Console errors across the whole drill: none.**

---

# Part B — the physical device pass

**None of this has been verified. It is your job, on a real iPhone.**

Do it outdoors, in daylight, ideally on the beach. Sit inside and you will pass
things that fail in sun.

### B1 — Install to the home screen

- [ ] Open the app in **Safari** (not Chrome — iOS installs only from Safari)
- [ ] Share → **Add to Home Screen**
- [ ] The icon is the navy NSC mark, **not a grey page thumbnail**
      *(if it is grey, `img/apple-touch-icon.png` is missing or unreachable)*
- [ ] Launch from the home screen: it opens **standalone**, no Safari chrome
- [ ] The status bar area is navy, and no content hides behind the notch

### B2 — Persistent storage

- [ ] With the app installed, open `#/dev` and check the storage line
- [ ] Confirm persistence is **granted**

> Headless Chrome reports `persisted: false` because it refuses the permission
> without user engagement, so **Part A cannot verify this at all**. iOS grants
> it to installed PWAs without prompting. This matters more than it sounds:
> Safari clears the storage of sites unvisited for seven days, which is exactly
> how a sailing club uses an app.

### B3 — Airplane mode, for real

- [ ] Airplane mode **on**
- [ ] Force-quit the app (swipe up) and relaunch from the home screen
- [ ] It opens fully, with correct fonts and a visible logo
- [ ] Run a complete race: sign on, sequence, laps, finishes, results
- [ ] Force-quit mid-race and relaunch — the resume banner offers the race back
- [ ] Airplane mode **off**, enter the PIN, watch the pill reach "Synced"

### B4 — The screen, outdoors

> **What was checked here already:** every text node on all nine pages passes
> WCAG AA contrast, and everything an OOD reads to act on mid-race — the lap
> counter, the finished rail, the results columns — was moved off the hint
> grey (`--slate`, 5.1:1) onto `--hull` at 10.9:1. Every tap target clears
> 44px in both directions. **None of that proves it is readable in sun**,
> which is a property of the screen, the brightness, and the angle of the sky.
> That is what this step is for.


- [ ] Screen at **full brightness**, in direct sun
- [ ] The race clock is readable at arm's length
- [ ] Boat names and lap buttons are readable **without shading the screen**
- [ ] Check the Wake Lock: does the screen stay on through a sequence?
      If a warning appears telling you to set Auto-Lock to Never, follow it —
      that is the fallback working
- [ ] Tap every main button **with a wet thumb**. Anything you miss twice is a
      bug worth reporting

### B5 — Two phones

- [ ] Open the same race day on a second phone
- [ ] It shows **READ ONLY** and names the phone holding the day
- [ ] The second phone can still see the race — clock, boats, history
- [ ] "Take over on this device" needs **two taps**
- [ ] After takeover, check the **first** phone: it keeps every event it
      recorded, and its outbox still drains

### B6 — Time and date inputs

- [ ] Race day setup: the date field fits without the page scrolling sideways
- [ ] Calendar register: the time field accepts a time and stores it correctly
      *(iOS uses a spinner rather than a text field; the stored value must
      still be `HH:MM`)*

### B7 — Deliberate damage

- [ ] Set the phone's clock forward an hour in Settings, then sync.
      A warning names the offset. Set it back
- [ ] Fill the phone's storage almost full, then sign a boat on.
      If a write fails, the red **OUT OF STORAGE** bar appears and stays

---

## If something fails

Write down **what you tapped and what you saw** — not a diagnosis. "Tapped
Finish on boat 3, the card didn't move, clock still running" is more useful
than "sync is broken".

The event log is the truth: `#/dev` dumps the outbox, and the live race page's
History drawer lists every recorded tap in order. Between them they can
reconstruct what actually happened, which is the whole reason the log is
append-only.

**Do not clear the app's data to fix a problem.** It is the only copy of
anything that has not synced.
