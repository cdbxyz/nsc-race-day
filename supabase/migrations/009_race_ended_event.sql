-- 009_race_ended_event.sql — allow the `race_ended` event type.
--
-- A race previously had no ending: the clock ran on for ever and the only way
-- out was to walk away from the page. Ending is now an explicit act by the
-- OOD, recorded like any other — `race_ended` with the tap time — so the
-- moment the race was closed is on the record and can be undone if it was
-- closed by mistake.
--
-- Per CLAUDE.md, a new race_events.type ships with the constraint change in
-- the same commit: the server refuses unknown values, and a refused row is
-- quarantined on the phone rather than syncing.

alter table race_events drop constraint race_events_type_check;

alter table race_events add constraint race_events_type_check check (
  type in (
    'sequence_started', 'postponed', 'general_recall', 'race_abandoned',
    'race_ended', 'course_shortened', 'lap_recorded', 'boat_finished',
    'code_applied', 'event_undone', 'correction', 'dev_test'
  )
);
