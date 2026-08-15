-- 001_schema.sql — the data model from ARCHITECTURE.md section 4.
--
-- Every primary key is a UUID generated on the phone before the row is written
-- to IndexedDB, and the same UUID is the conflict target when sync pushes the
-- row up. That is what makes a retried push harmless: it upserts the row it
-- already wrote rather than inserting a second copy.
--
-- There are deliberately no `default gen_random_uuid()` clauses. A
-- server-generated id would break that guarantee the moment a response was
-- lost, so the client always supplies one.

create table helms (
  id uuid primary key,
  name text not null,
  created_at timestamptz default now()
);

create table classes (
  id uuid primary key,
  name text not null unique,       -- e.g. Laser 2000
  base_py int not null,            -- from the RYA PY list; annual update ripples to every boat
  created_at timestamptz default now()
);

create table boats (
  id uuid primary key,
  name text not null,              -- boat name or sail number
  sail_no text,
  class_id uuid not null references classes,   -- boat inherits the class base PY
  active boolean default true,
  created_at timestamptz default now()
);

create table race_days (
  id uuid primary key,
  date date not null,
  ood_name text not null,
  ro1_name text,
  ro2_name text,
  status text not null default 'open',
  created_at timestamptz default now(),
  constraint race_days_status_check check (status in ('open', 'complete'))
);

create table series (
  id uuid primary key,
  name text not null,
  season int not null,             -- e.g. 2026
  discard_rule jsonb               -- v1: stored, not yet used
);

create table races (
  id uuid primary key,
  race_day_id uuid not null references race_days,
  series_id uuid references series,
  number int not null,             -- Race 1, 2, 3 within the day
  name text,
  status text not null default 'setup',
  sequence_start_at timestamptz,   -- when the 10-minute gun fired
  start_at timestamptz,            -- computed: sequence_start_at + 10 min
  fast_laps int not null default 3,          -- lap plan, fast fleet (base PY < 1168)
  slow_laps int not null default 2,          -- lap plan, slow fleet (base PY >= 1168)
  published_at timestamptz,        -- shorten-course updates fast_laps/slow_laps via event
  constraint races_status_check check (
    status in ('setup', 'prestart', 'sequence', 'racing', 'finished', 'published', 'abandoned')
  )
);

create table entries (
  id uuid primary key,
  race_id uuid not null references races,
  boat_id uuid not null references boats,
  helm_id uuid not null references helms,
  base_py int not null,            -- snapshot of the class base PY at entry time
  handicap_factor numeric not null default 1.0,  -- 1.0 / .97 / .96 / .95
  personal_py numeric not null,    -- base_py x factor, the PY actually used
  fleet text not null,             -- 'fast' (base PY < 1168) | 'slow' (>= 1168)
  laps_override int,               -- per-boat exception to the fleet lap plan
  unique (race_id, boat_id),
  constraint entries_fleet_check check (fleet in ('fast', 'slow'))
);

-- Append-only. Nothing in this table is ever updated or deleted; a mistake is
-- corrected by appending an `event_undone` that tombstones the earlier event,
-- because a race record is a safety document.
create table race_events (
  id uuid primary key,             -- client-generated; the upsert key
  race_id uuid not null references races,
  entry_id uuid references entries,          -- null for race-level events
  type text not null,
  payload jsonb,                   -- e.g. {"code":"OCS"} or {"undoes":"<event uuid>"}
  occurred_at timestamptz not null,          -- device tap time
  recorded_at timestamptz default now(),     -- server receipt time
  constraint race_events_type_check check (
    type in (
      'sequence_started', 'postponed', 'general_recall', 'race_abandoned',
      'course_shortened', 'lap_recorded', 'boat_finished', 'code_applied',
      'event_undone', 'correction', 'dev_test'
    )
  )
);

create table checklist_templates (
  id uuid primary key,
  kind text not null,              -- pre_race | stand_down
  items jsonb not null,            -- ordered [{id, label}]
  constraint checklist_templates_kind_check check (kind in ('pre_race', 'stand_down'))
);

create table checklist_runs (
  id uuid primary key,
  race_day_id uuid not null references race_days,
  template_id uuid not null references checklist_templates,
  kind text not null,
  responses jsonb not null,        -- {item_id: {done, at, note}}
  completed_at timestamptz
);

-- Indexes matching how the app actually reads: everything is scoped to a race
-- day, a race, or an entry.
create index boats_class_id_idx on boats (class_id);
create index race_days_status_idx on race_days (status);
create index races_race_day_id_idx on races (race_day_id);
create index races_status_idx on races (status);
create index races_series_id_idx on races (series_id);
create index entries_race_id_idx on entries (race_id);
create index entries_boat_id_idx on entries (boat_id);
create index entries_helm_id_idx on entries (helm_id);
create index race_events_race_id_idx on race_events (race_id);
create index race_events_entry_id_idx on race_events (entry_id);
create index race_events_occurred_at_idx on race_events (occurred_at);
create index checklist_runs_race_day_id_idx on checklist_runs (race_day_id);

-- Undo lookups ask "is there an event_undone pointing at this id?" constantly
-- while replaying a log, so index the payload key it uses.
create index race_events_undoes_idx on race_events ((payload ->> 'undoes'))
  where type = 'event_undone';
