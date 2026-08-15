-- 003_views.sql — results derived from the event log.
--
-- Nothing about a result is stored. Laps, elapsed times, codes and therefore
-- positions are all computed from race_events, which is what lets a correction
-- be an appended event rather than an edit (ARCHITECTURE.md D2).
--
-- js/scoring.js in Phase 5 is the authoritative implementation of the maths
-- for the OOD's own screen; these views exist so the public site and the
-- handicap engine can read the same answers straight from Postgres. The two
-- must agree, and the golden tests in Phase 5 are what keep them honest.
--
-- SECURITY NOTE: published_results is a security-definer view (Postgres's
-- default), so it reads the underlying tables without RLS. That is deliberate
-- and load-bearing: it is the one place anon may see boat and helm names, and
-- only for races that have been published. Its WHERE clause is therefore the
-- protection — change it with care.

-- ---------------------------------------------------------------------------
-- Which events still count.
--
-- An event is tombstoned by an `event_undone` whose payload names it. Undoing
-- an undo is a redo, so an event_undone that has itself been undone no longer
-- tombstones anything.
-- ---------------------------------------------------------------------------
create view live_race_events as
select e.*
from race_events e
where e.type <> 'event_undone'
  and not exists (
    select 1
    from race_events u
    where u.type = 'event_undone'
      and u.payload ->> 'undoes' = e.id::text
      and not exists (
        select 1
        from race_events u2
        where u2.type = 'event_undone'
          and u2.payload ->> 'undoes' = u.id::text
      )
  );

-- ---------------------------------------------------------------------------
-- Per-entry facts: how far each boat got, and how long it took.
--
-- A `correction` event may override laps, elapsed time or code before the race
-- is published. Expected payload keys — Phase 5 must write these exact names:
--   {"laps": <int>, "elapsed_seconds": <numeric>, "code": "<RRS code>"}
-- Any subset may be present; absent keys leave the computed value alone.
-- ---------------------------------------------------------------------------
create view race_entry_facts as
with finish as (
  select distinct on (entry_id)
    entry_id, occurred_at
  from live_race_events
  where type = 'boat_finished' and entry_id is not null
  order by entry_id, occurred_at desc
),
laps as (
  select entry_id, count(*) as lap_count
  from live_race_events
  where type = 'lap_recorded' and entry_id is not null
  group by entry_id
),
coded as (
  select distinct on (entry_id)
    entry_id, payload ->> 'code' as code
  from live_race_events
  where type = 'code_applied' and entry_id is not null
  order by entry_id, occurred_at desc
),
corrected as (
  select distinct on (entry_id)
    entry_id,
    (payload ->> 'laps')::int as laps,
    (payload ->> 'elapsed_seconds')::numeric as elapsed_seconds,
    payload ->> 'code' as code
  from live_race_events
  where type = 'correction' and entry_id is not null
  order by entry_id, occurred_at desc
)
select
  en.id            as entry_id,
  en.race_id,
  en.boat_id,
  en.helm_id,
  en.base_py,
  en.handicap_factor,
  en.personal_py,
  en.fleet,
  -- laps sailed = completed laps plus the finishing one, unless corrected
  coalesce(
    c.laps,
    coalesce(l.lap_count, 0) + case when f.entry_id is not null then 1 else 0 end
  ) as laps_sailed,
  coalesce(
    c.elapsed_seconds,
    extract(epoch from (f.occurred_at - r.start_at))
  ) as elapsed_seconds,
  coalesce(c.code, cd.code) as code,
  f.entry_id is not null as finished
from entries en
join races r on r.id = en.race_id
left join finish f    on f.entry_id = en.id
left join laps l      on l.entry_id = en.id
left join coded cd    on cd.entry_id = en.id
left join corrected c on c.entry_id = en.id;

-- ---------------------------------------------------------------------------
-- Published results, in the club's familiar shape.
--
-- Lap-adjusted elapsed = elapsed x max laps / laps sailed, where max laps is
-- taken from the boat that sailed furthest. Corrected = lap-adjusted x 1000 /
-- personal PY. Lowest corrected time wins.
-- ---------------------------------------------------------------------------
create view published_results as
with scored as (
  select
    f.*,
    r.race_day_id,
    r.number as race_number,
    r.name   as race_name,
    r.published_at,
    rd.date  as race_date,
    coalesce(s.season, extract(year from rd.date)::int) as season,
    s.id     as series_id,
    s.name   as series_name,
    -- a boat that neither finished nor carries a code simply has no result
    (f.code is null and f.finished) as ranks,
    max(case when f.code is null and f.finished then f.laps_sailed end)
      over (partition by f.race_id) as max_laps,
    count(*) over (partition by f.race_id) as starters
  from race_entry_facts f
  join races r      on r.id = f.race_id
  join race_days rd on rd.id = r.race_day_id
  left join series s on s.id = r.series_id
  where r.status = 'published'
),
computed as (
  select
    scored.*,
    case
      when ranks then scored.elapsed_seconds * scored.max_laps
                      / nullif(scored.laps_sailed, 0)
    end as lap_adjusted_seconds
  from scored
),
ranked as (
  select
    computed.*,
    case
      when ranks then computed.lap_adjusted_seconds * 1000
                      / nullif(computed.personal_py, 0)
    end as corrected_seconds
  from computed
),
placed as (
  select
    ranked.*,
    case
      when ranks then rank() over (
        partition by race_id
        order by case when ranks then corrected_seconds end
      )
    end as position
  from ranked
)
select
  p.race_id,
  p.race_day_id,
  p.race_number,
  p.race_name,
  p.race_date,
  p.published_at,
  p.series_id,
  p.series_name,
  p.season,
  p.entry_id,
  p.boat_id,
  b.name    as boat_name,
  b.sail_no,
  cl.id     as class_id,
  cl.name   as class_name,
  p.helm_id,
  h.name    as helm_name,
  p.base_py,
  p.handicap_factor,
  p.personal_py,
  p.fleet,
  p.laps_sailed,
  p.max_laps,
  p.elapsed_seconds,
  p.lap_adjusted_seconds,
  p.corrected_seconds,
  p.code,
  p.position,
  p.starters,
  -- RRS low point: your place, coded boats score starters + 1, and boats tied
  -- on corrected time share the average of the places they occupy.
  case
    when not p.ranks then p.starters + 1
    else p.position + (count(*) over (partition by p.race_id, p.corrected_seconds) - 1) / 2.0
  end as points
from placed p
join boats b   on b.id = p.boat_id
join classes cl on cl.id = b.class_id
join helms h   on h.id = p.helm_id;

-- ---------------------------------------------------------------------------
-- helm_season_wins — what the handicap engine reads.
--
-- A qualifying win is 1st place on corrected time in a published race in the
-- same season. Coded results never count (ARCHITECTURE.md section 5).
-- ---------------------------------------------------------------------------
create view helm_season_wins as
select
  helm_id,
  season,
  count(*)::int as wins
from published_results
where position = 1
  and code is null
group by helm_id, season;

-- The public site reads results and standings; the registers stay private.
grant select on published_results to anon, authenticated;
grant select on helm_season_wins to anon, authenticated;
grant select on race_entry_facts to authenticated;
grant select on live_race_events to authenticated;
