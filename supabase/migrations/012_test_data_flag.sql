-- 012_test_data_flag.sql — mark a race day that was run on a fast clock.
--
-- The dev panel can compress the ten-minute start sequence so a whole
-- sequence runs in ten seconds. That is only for testing, but the events it
-- produces are indistinguishable from real ones — the timestamps are genuine
-- wall clock, because faking those would poison the log.
--
-- So the day itself carries the flag. It is set when a sequence is STARTED at
-- anything other than 1x, it is never cleared by the app, and it travels with
-- the race day to the results sheet. A ten-second race must never be mistaken
-- for a real one, least of all months later by someone reading the season.

alter table race_days
  add column is_test_data boolean not null default false;

comment on column race_days.is_test_data is
  'True if any race on this day was started on the dev fast clock. Results from it are not real.';
