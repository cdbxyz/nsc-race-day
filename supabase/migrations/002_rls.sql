-- 002_rls.sql — row level security, per ARCHITECTURE.md section 9.
--
-- The anon key ships inside public JavaScript, so the database cannot be
-- world-writable. Two roles matter:
--
--   authenticated  the shared club account, reached by entering the club PIN.
--                  Full read/write: this is the OOD's phone.
--   anon           the public. Read-only, and only on races that have been
--                  deliberately published.
--
-- The boat and helm registers are NOT readable by anon. They are effectively a
-- membership list, and keeping them behind auth is the GDPR-tidy default. The
-- public results page reads names through the published_results view in 003,
-- which exposes only the names that appear in a published race.

alter table helms               enable row level security;
alter table classes             enable row level security;
alter table boats               enable row level security;
alter table race_days           enable row level security;
alter table series              enable row level security;
alter table races               enable row level security;
alter table entries             enable row level security;
alter table race_events         enable row level security;
alter table checklist_templates enable row level security;
alter table checklist_runs      enable row level security;

-- ---------------------------------------------------------------------------
-- authenticated: the club account can do everything.
-- ---------------------------------------------------------------------------

create policy "club full access" on helms
  for all to authenticated using (true) with check (true);
create policy "club full access" on classes
  for all to authenticated using (true) with check (true);
create policy "club full access" on boats
  for all to authenticated using (true) with check (true);
create policy "club full access" on race_days
  for all to authenticated using (true) with check (true);
create policy "club full access" on series
  for all to authenticated using (true) with check (true);
create policy "club full access" on races
  for all to authenticated using (true) with check (true);
create policy "club full access" on entries
  for all to authenticated using (true) with check (true);
create policy "club full access" on race_events
  for all to authenticated using (true) with check (true);
create policy "club full access" on checklist_templates
  for all to authenticated using (true) with check (true);
create policy "club full access" on checklist_runs
  for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- anon: select only, and only what has been published.
--
-- There are deliberately no insert/update/delete policies below. With RLS on,
-- the absence of a policy is a denial, so anon writes fail without anything
-- further needing to be said.
-- ---------------------------------------------------------------------------

create policy "public reads published races" on races
  for select to anon using (status = 'published');

create policy "public reads entries of published races" on entries
  for select to anon using (
    exists (select 1 from races r where r.id = entries.race_id and r.status = 'published')
  );

create policy "public reads events of published races" on race_events
  for select to anon using (
    exists (select 1 from races r where r.id = race_events.race_id and r.status = 'published')
  );

-- Series and classes are reference data with nothing personal in them, and the
-- public standings need both.
create policy "public reads series" on series
  for select to anon using (true);

create policy "public reads classes" on classes
  for select to anon using (true);
