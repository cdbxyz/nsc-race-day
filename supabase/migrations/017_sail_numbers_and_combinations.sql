-- 017_sail_numbers_and_combinations.sql
--
-- Two model changes, and a live bug they expose.
--
-- 1. HULLS GO; SAIL NUMBERS STAY.
--
-- Named hulls were never useful here. They added a decision at every sign-on
-- ("which boat is this?") for a club that thinks in pairings, and all four
-- rows ended up inactive with no entry ever pointing at one. What an OOD
-- actually needs is a number they can read on the water, so the sail number
-- moves onto the ENTRY, where it belongs: a helm may borrow a different boat
-- next week, and the number is a fact about that race, not about the person.
--
-- entries.class_id already carries the PY source (011), so nothing of value
-- is lost with the table.
--
-- 2. COMBINATIONS BECOME A REAL TABLE.
--
-- They were derived from entry history, which is elegant and wrong: the list
-- is empty on the first day of the fortnight, which is the busiest sign-on of
-- the year. The club knows its regular pairings; it should be able to write
-- them down. The table stays self-maintaining — creating an entry upserts its
-- combination — so a pairing nobody thought to seed still appears after its
-- first race.
--
-- 3. THE BUG.
--
-- published_results joined boats INNER on entries.boat_id and took the class
-- from the BOAT. Since 011 made boat_id optional and moved class onto the
-- entry, every entry has had a null boat_id — so the view has returned ZERO
-- rows for every published race. Four published races, ten entries, nothing
-- public. Nobody noticed because the app scores locally from the event log
-- and only the club website reads this view.
--
-- Rewriting it here is not scope creep; dropping the column forces the view
-- to be rebuilt, and rebuilding it wrong again would be the actual mistake.

/* ---- 1. the sail number, on the entry ---------------------------------- */

alter table entries add column sail_no text;

comment on column entries.sail_no is
  'Sail number as read on the water, for this race only. A helm may borrow a different boat next week.';

/* ---- 2. combinations ---------------------------------------------------- */

create table combinations (
  id uuid primary key,
  helm_id uuid not null references helms(id),
  -- Null means sailing solo, which is a DIFFERENT combination from the same
  -- helm with a crew, not a missing value.
  crew_id uuid references helms(id),
  class_id uuid not null references classes(id),
  default_sail_no text,
  -- Maintained by the app on every entry, so the sign-on list can put the
  -- pairings this club actually races at the top.
  times_raced int not null default 0,
  last_raced timestamptz,
  -- Retired, never deleted: a pairing that stops sailing still owns its
  -- history, and deleting it would orphan the seasons it appears in.
  active boolean not null default true,
  created_at timestamptz default now()
);

/* Uniqueness has to treat null crew as a value, or "Hamish solo" could be
   inserted a hundred times: in SQL, null <> null, so a plain unique
   constraint on (helm_id, crew_id, class_id) does not constrain solo rows at
   all. coalesce to the nil UUID rather than `nulls not distinct` so the
   intent is visible in the index and the behaviour does not depend on the
   server version. */
create unique index combinations_identity_idx
  on combinations (
    helm_id,
    coalesce(crew_id, '00000000-0000-0000-0000-000000000000'::uuid),
    class_id
  );

create index combinations_order_idx on combinations (active, times_raced desc, last_raced desc);

comment on table combinations is
  'Helm (+ crew) in a class — the identity that persists at this club. Committee-editable and self-maintaining.';
comment on column combinations.crew_id is
  'Null means solo. Solo and crewed are distinct combinations, not one with a missing field.';
comment on column combinations.default_sail_no is
  'The number this pairing usually sails under. Pre-filled at sign-on and editable per race.';

alter table combinations enable row level security;

create policy "club full access" on combinations
  for all to authenticated using (true) with check (true);

/* Member names, so authenticated only — the same rule as helms. Explicitly
   revoked from anon rather than relying on the absence of a policy, matching
   the second lock 006 put on club_config. */
revoke all on combinations from anon;
grant select, insert, update, delete on combinations to authenticated;

/* ---- 3. rebuild the views without boats -------------------------------- */

/* helm_season_wins reads published_results, so it comes down and goes back up
   with it. Its own definition is unchanged — it is listed here only because
   Postgres will not let the view beneath it be replaced otherwise, and
   dropping it with CASCADE would leave no record of what was rebuilt. */
drop view if exists helm_season_wins;
drop view if exists published_results;
drop view if exists race_entry_facts;

alter table entries drop column boat_id;
drop table boats;

create view race_entry_facts as
with finish as (
  select distinct on (entry_id) entry_id, occurred_at
  from live_race_events
  where type = 'boat_finished' and entry_id is not null
  order by entry_id, occurred_at desc
), laps as (
  select entry_id, count(*) as lap_count
  from live_race_events
  where type = 'lap_recorded' and entry_id is not null
  group by entry_id
), coded as (
  select distinct on (entry_id) entry_id, payload ->> 'code' as code
  from live_race_events
  where type = 'code_applied' and entry_id is not null
  order by entry_id, occurred_at desc
), corrected as (
  select distinct on (entry_id) entry_id,
    (payload ->> 'laps')::int as laps,
    (payload ->> 'elapsed_seconds')::numeric as elapsed_seconds,
    payload ->> 'code' as code
  from live_race_events
  where type = 'correction' and entry_id is not null
  order by entry_id, occurred_at desc
)
select
  en.id as entry_id,
  en.race_id,
  en.class_id,
  en.helm_id,
  en.crew_id,
  en.sail_no,
  en.base_py,
  en.handicap_factor,
  en.personal_py,
  en.fleet,
  coalesce(c.laps::bigint,
           coalesce(l.lap_count, 0::bigint) + case when f.entry_id is not null then 1 else 0 end)
    as laps_sailed,
  coalesce(c.elapsed_seconds, extract(epoch from f.occurred_at - r.start_at)) as elapsed_seconds,
  coalesce(c.code, cd.code) as code,
  f.entry_id is not null as finished
from entries en
  join races r on r.id = en.race_id
  left join finish f on f.entry_id = en.id
  left join laps l on l.entry_id = en.id
  left join coded cd on cd.entry_id = en.id
  left join corrected c on c.entry_id = en.id;

create view published_results as
with scored as (
  select
    f.entry_id, f.race_id, f.class_id, f.helm_id, f.crew_id, f.sail_no,
    f.base_py, f.handicap_factor, f.personal_py, f.fleet,
    f.laps_sailed, f.elapsed_seconds, f.code, f.finished,
    r.race_day_id, r.number as race_number, r.name as race_name, r.published_at,
    rd.date as race_date,
    coalesce(s.season, extract(year from rd.date)::int) as season,
    s.id as series_id, s.name as series_name,
    (f.code is null and f.finished) as ranks,
    max(case when f.code is null and f.finished then f.laps_sailed else null::bigint end)
      over (partition by f.race_id) as max_laps,
    count(*) over (partition by f.race_id) as starters
  from race_entry_facts f
    join races r on r.id = f.race_id
    join race_days rd on rd.id = r.race_day_id
    left join series s on s.id = r.series_id
  where r.status = 'published'
), computed as (
  select scored.*,
    case when ranks
      then elapsed_seconds * max_laps::numeric / nullif(laps_sailed, 0)::numeric
      else null::numeric end as lap_adjusted_seconds
  from scored
), ranked as (
  select computed.*,
    case when ranks
      then lap_adjusted_seconds * 1000::numeric / nullif(personal_py, 0::numeric)
      else null::numeric end as corrected_seconds
  from computed
), placed as (
  select ranked.*,
    case when ranks
      then rank() over (partition by race_id order by (case when ranks then corrected_seconds else null::numeric end))
      else null::bigint end as position
  from ranked
)
select
  p.race_id, p.race_day_id, p.race_number, p.race_name, p.race_date, p.published_at,
  p.series_id, p.series_name, p.season,
  p.entry_id,
  p.sail_no,
  cl.id as class_id, cl.name as class_name,
  p.helm_id, h.name as helm_name,
  p.crew_id, cr.name as crew_name,
  p.base_py, p.handicap_factor, p.personal_py, p.fleet,
  p.laps_sailed, p.max_laps, p.elapsed_seconds, p.lap_adjusted_seconds, p.corrected_seconds,
  p.code, p.position, p.starters,
  case
    when not p.ranks then (p.starters + 1)::numeric
    else p.position::numeric + (count(*) over (partition by p.race_id, p.corrected_seconds) - 1)::numeric / 2.0
  end as points
from placed p
  /* Class comes from the ENTRY now, and it is NOT NULL, so this join can no
     longer silently drop a row the way the old boats join did. */
  join classes cl on cl.id = p.class_id
  join helms h on h.id = p.helm_id
  left join helms cr on cr.id = p.crew_id;

/* Definer end to end, per 007: anon has no grant on the intermediate views,
   and published_results' `where status = 'published'` is the boundary. */
create view helm_season_wins as
select helm_id, season, count(*)::int as wins
from published_results
where position = 1 and code is null
group by helm_id, season;

alter view race_entry_facts set (security_invoker = false);
alter view published_results set (security_invoker = false);
alter view helm_season_wins set (security_invoker = false);

revoke all on race_entry_facts from anon;
revoke all on helm_season_wins from anon;
grant select on race_entry_facts to authenticated;
grant select on helm_season_wins to authenticated;
grant select on published_results to anon, authenticated;

/* ---- 4. seed combinations from the history that already exists ---------- */

/* INSERT ONLY, per the 008 precedent. This is a derivation of entries the
   club has already sailed, so it can only ever add rows the app would have
   added itself at the next sign-on. */
insert into combinations (id, helm_id, crew_id, class_id, times_raced, last_raced)
select
  gen_random_uuid(),
  en.helm_id,
  en.crew_id,
  en.class_id,
  count(*),
  max(rd.date)::timestamptz
from entries en
  join races r on r.id = en.race_id
  join race_days rd on rd.id = r.race_day_id
  join helms h on h.id = en.helm_id
  join classes c on c.id = en.class_id
where coalesce(rd.is_test_data, false) = false
group by en.helm_id, en.crew_id, en.class_id
on conflict do nothing;
