-- 013_race_calendar.sql — the season programme.
--
-- A committee-agreed list of what is being sailed and when. It exists so the
-- OOD does not have to remember on the day, and so a trophy race is named
-- correctly on its results sheet rather than approximately.
--
-- Deliberately thin: date, name, start time. `series` is here and nullable
-- because the committee may group races later, but nothing reads it yet —
-- there are no accumulators, discards or sub-award trophies in v1.
--
-- INSERT ONLY, per the 008 precedent. This is a DRAFT committee proposal and
-- the register UI is where it gets corrected; a re-run of this migration must
-- never overwrite an edit someone has made in the app.

create table race_calendar (
  id uuid primary key,
  season int not null,
  date date not null,
  name text not null,
  start_time time not null,
  series text,
  -- v1 scores handicap races only. A pursuit start is a different format and
  -- the app cannot run one, so it is flagged rather than silently offered.
  is_pursuit boolean not null default false,
  created_at timestamptz default now()
);

create index race_calendar_season_date_idx on race_calendar (season, date, start_time);

comment on table race_calendar is
  'The season programme. Committee-editable in the app; seeds are insert-only.';
comment on column race_calendar.is_pursuit is
  'Pursuit starts are not supported in v1 — the OOD is pointed at the club calculator instead.';

alter table race_calendar enable row level security;

create policy "club full access" on race_calendar
  for all to authenticated using (true) with check (true);

-- The programme is public information; the club website can show it.
create policy "public reads the programme" on race_calendar
  for select to anon using (true);

/* ---- 2026 programme ----------------------------------------------------
   Two dates carry two races (8 and 11 August). 15 and 16 August have no
   scheduled racing and therefore no rows — an absence, not a blank. */

insert into race_calendar (id, season, date, name, start_time, is_pursuit)
select id, season, date, name, start_time, is_pursuit from (values
  ('c1a00000-0000-4000-8000-000000000001'::uuid, 2026, date '2026-08-02', 'Whitaker Cup',            time '14:00', false),
  ('c1a00000-0000-4000-8000-000000000002'::uuid, 2026, date '2026-08-03', 'Keen Trophy',             time '14:00', false),
  ('c1a00000-0000-4000-8000-000000000003'::uuid, 2026, date '2026-08-04', 'Caeau Capel Cup',         time '14:00', false),
  ('c1a00000-0000-4000-8000-000000000004'::uuid, 2026, date '2026-08-05', 'Coventry Cup (Long Distance)', time '14:00', false),
  ('c1a00000-0000-4000-8000-000000000005'::uuid, 2026, date '2026-08-06', 'Barnes Shield',           time '14:00', false),
  ('c1a00000-0000-4000-8000-000000000006'::uuid, 2026, date '2026-08-07', 'Spencer Cup',             time '14:00', false),
  ('c1a00000-0000-4000-8000-000000000007'::uuid, 2026, date '2026-08-08', 'Commodore''s Tankard',    time '13:00', false),
  ('c1a00000-0000-4000-8000-000000000008'::uuid, 2026, date '2026-08-08', 'Richard Burrell Trophy',  time '15:00', false),
  ('c1a00000-0000-4000-8000-000000000009'::uuid, 2026, date '2026-08-09', 'The Lifeboat Bay Race',   time '15:00', false),
  ('c1a00000-0000-4000-8000-00000000000a'::uuid, 2026, date '2026-08-10', 'Craven Cup',              time '14:00', false),
  ('c1a00000-0000-4000-8000-00000000000b'::uuid, 2026, date '2026-08-11', 'Jones Cup',               time '13:00', false),
  ('c1a00000-0000-4000-8000-00000000000c'::uuid, 2026, date '2026-08-11', 'Wilcocks Trophy',         time '15:00', false),
  ('c1a00000-0000-4000-8000-00000000000d'::uuid, 2026, date '2026-08-12', 'Partington Cannon',       time '14:00', false),
  ('c1a00000-0000-4000-8000-00000000000e'::uuid, 2026, date '2026-08-13', 'Andy''s Andicap',         time '14:00', false),
  ('c1a00000-0000-4000-8000-00000000000f'::uuid, 2026, date '2026-08-14', 'Crowther Cup',            time '14:00', true)
) as seed (id, season, date, name, start_time, is_pursuit)
where not exists (
  select 1 from race_calendar existing where existing.season = seed.season
)
on conflict (id) do nothing;
