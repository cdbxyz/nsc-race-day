-- 016_status_override_and_device_claim.sql
--
-- Two hardening changes, both about leaving a record of something that
-- previously happened silently.
--
-- 1. status_overridden
--
-- The dev panel can force a race into any status. It is kept deliberately:
-- it is the escape hatch for the situation nobody predicted, on a beach, with
-- no developer available. But it used to leave no trace at all, so a race
-- found in a strange status months later was unexplainable.
--
-- It is now an event like everything else, carrying the status before and
-- after, and it shows up in the history drawer next to the taps around it.
-- Append-only: overriding twice leaves two events, and undoing one is an
-- event_undone like any other.
--
-- 2. The device claim
--
-- A race day is run from one phone. A second phone opening the same day and
-- also tapping laps would double-record silently, and the outbox would
-- happily sync both. So a day names the device running it.
--
-- This is a SOFT lock and must stay soft. A takeover is usually a handover —
-- a dying battery, an OOD swap at lunch — not a conflict. The losing device
-- keeps every row it has and keeps draining its outbox, because discarding
-- unsynced events is the one unrecoverable act in this system and the losing
-- phone is often holding the only copy of the last few taps. It simply stops
-- being able to record anything new.
--
-- claimed_at is what makes takeover resolvable: last claim wins, and both
-- devices can see which is newer.

alter table race_events
  drop constraint race_events_type_check;

alter table race_events
  add constraint race_events_type_check check (type = any (array[
    'sequence_started',
    'postponed',
    'general_recall',
    'race_abandoned',
    'race_ended',
    'course_shortened',
    'lap_recorded',
    'boat_finished',
    'code_applied',
    'event_undone',
    'correction',
    'status_overridden',
    'dev_test'
  ]));

comment on constraint race_events_type_check on race_events is
  'Every event type the app can write. A new type needs this constraint updated in the same commit, or the server refuses the row and it quarantines in the outbox.';

alter table race_days
  add column claimed_by text,
  add column claimed_by_name text,
  add column claimed_at timestamptz;

comment on column race_days.claimed_by is
  'Device id currently running this day. A soft lock: a second device sees read-only until it takes over.';
comment on column race_days.claimed_by_name is
  'Human label for the takeover prompt. "Take over from Chris''s iPhone" is a decision an OOD can make; "take over from device a3f2c1" is not.';
comment on column race_days.claimed_at is
  'When the current claim was made. Last claim wins, and both devices can see which is newer.';
