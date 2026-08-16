-- 010_rescue_crew_wording.sql — one checklist item renamed for consistency.
--
-- The duty trio is the OOD, who runs the race, and RO1 and RO2, who crew the
-- rescue boat. The pre-race checklist called them "Safety crew", which is a
-- third name for the same two people — the setup form now says "Rescue
-- Officer 1 (RO1)", so the checklist should agree.
--
-- No item said "race officer"; this is the only wording that referred to the
-- rescue crew by another name.
--
-- Deliberately NOT a re-seed. 008 replaces the whole `items` array on
-- conflict, which would silently discard any wording the committee has since
-- edited in the dashboard. This rewrites one label in place and leaves every
-- other item, and their order, exactly as found.

update checklist_templates
set items = (
  select jsonb_agg(item order by position)
  from (
    select
      case
        when element ->> 'id' = 'crew_briefed'
          then jsonb_set(
            element,
            '{label}',
            '"Rescue crew (RO1 and RO2) briefed and wearing lifejackets"'::jsonb
          )
        else element
      end as item,
      position
    from jsonb_array_elements(items) with ordinality as t(element, position)
  ) as rewritten
)
where kind = 'pre_race'
  and items @> '[{"id": "crew_briefed"}]'::jsonb;
