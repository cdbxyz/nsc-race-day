-- 015_checklist_wording.sql — committee corrections to the safety checklists.
--
-- The club has permanent marks, so "marks lifted" is not a thing anyone does
-- at stand-down, and the rescue boat is not washed down. "Course laid and
-- marks confirmed" becomes simply "Course set".
--
-- Edited in place, item by item, rather than re-seeded. 008 is insert-only
-- precisely so a deploy cannot discard the committee's own wording, and this
-- migration honours the same rule: it touches only the three items named and
-- leaves every other item, and their order, exactly as found.

/* Pre-race: rename the course item. */
update checklist_templates
set items = (
  select jsonb_agg(item order by position)
  from (
    select
      case when element ->> 'id' = 'course_set'
        then jsonb_set(element, '{label}', '"Course set"'::jsonb)
        else element
      end as item,
      position
    from jsonb_array_elements(items) with ordinality as t(element, position)
  ) as rewritten
)
where kind = 'pre_race'
  and items @> '[{"id": "course_set"}]'::jsonb;

/* Stand-down: drop the two items that do not apply here. */
update checklist_templates
set items = (
  select coalesce(jsonb_agg(element order by position), '[]'::jsonb)
  from jsonb_array_elements(items) with ordinality as t(element, position)
  where element ->> 'id' not in ('rescue_recover', 'marks_lifted')
)
where kind = 'stand_down';

/* The rescue boat is still recovered, just not washed down — keep the
   recovery step under a clearer name rather than losing it entirely. */
update checklist_templates
set items = '[{"id": "rescue_ashore", "label": "Rescue boat recovered and secured"}]'::jsonb || items
where kind = 'stand_down'
  and not items @> '[{"id": "rescue_ashore"}]'::jsonb;
