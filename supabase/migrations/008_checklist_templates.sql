-- 008_checklist_templates.sql — first drafts of the two safety checklists.
--
-- These are DATA, not code. The sailing committee is expected to rewrite the
-- wording, reorder items and add their own, in the dashboard, without touching
-- the app or asking anyone to reinstall anything.
--
-- INSERT ONLY. This seeds a template the first time and never touches it
-- again: after first deploy the dashboard is the source of truth, and a
-- re-run of this migration must not silently discard whatever the committee
-- has since written. It previously replaced the whole `items` array on
-- conflict, which would have done exactly that.
--
-- Item ids must stay stable once a checklist has been run: checklist_runs
-- stores responses keyed by item id, and renaming an id orphans the history.

insert into checklist_templates (id, kind, items)
select id, kind, items from (values
(
  'aaaa1111-0000-4000-8000-000000000001'::uuid,
  'pre_race',
  '[
    {"id": "rescue_fuel",    "label": "Rescue boat fuelled and running"},
    {"id": "rescue_kit",     "label": "Rescue boat kit aboard — knife, throw line, anchor"},
    {"id": "first_aid",      "label": "First aid kit aboard and in date"},
    {"id": "radios",         "label": "Radios checked on both boats"},
    {"id": "crew_briefed",   "label": "Rescue crew (RO1 and RO2) briefed and wearing lifejackets"},
    {"id": "flags",          "label": "Flags ready — class, P, AP, first substitute"},
    {"id": "horn",           "label": "Horn or klaxon tested"},
    {"id": "tide_weather",   "label": "Tide and forecast noted, wind within limits"},
    {"id": "course_set",     "label": "Course laid and marks confirmed"},
    {"id": "signon_checked", "label": "Sign-on list matches the boats on the water"}
  ]'::jsonb
),
(
  'aaaa1111-0000-4000-8000-000000000002'::uuid,
  'stand_down',
  '[
    {"id": "all_ashore",     "label": "Every boat accounted for and ashore"},
    {"id": "rescue_recover", "label": "Rescue boat recovered and washed down"},
    {"id": "rescue_refuel",  "label": "Rescue boat refuelled for the next duty"},
    {"id": "radios_stowed",  "label": "Radios switched off and back on charge"},
    {"id": "kit_stowed",     "label": "Flags, horn and first aid kit stowed"},
    {"id": "marks_lifted",   "label": "Marks lifted or left as agreed"},
    {"id": "clubhouse",      "label": "Clubhouse secured"},
    {"id": "incidents",      "label": "Incidents, near misses or damage noted below"}
  ]'::jsonb
) as seed (id, kind, items)
where not exists (
  select 1 from checklist_templates existing where existing.kind = seed.kind
)
on conflict (id) do nothing;
