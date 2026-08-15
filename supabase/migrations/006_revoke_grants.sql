-- 006_revoke_grants.sql — a second lock on the secrets.
--
-- Supabase grants the anon and authenticated roles ALL privileges on every
-- table in `public` by default, and relies on RLS to decide what they can
-- actually see. For most tables that is fine and intended.
--
-- For the PIN it is one layer too few. `club_config` holds the bcrypt hash of
-- the club PIN and is protected only by having no RLS policy — so a single
-- careless `create policy` in some future migration would publish it. Removing
-- the grant means that mistake alone would not be enough: PostgREST refuses
-- before RLS is even consulted.
--
-- The internal views are revoked from anon for tidiness. RLS already limits
-- them to published races, but nothing anonymous has any business reading a
-- view whose entire purpose is to feed published_results.

revoke all on club_config  from anon, authenticated;
revoke all on pin_attempts from anon, authenticated;

revoke all on race_entry_facts from anon;
revoke all on live_race_events from anon;

-- Re-grant exactly what is wanted, nothing more.
grant select on race_entry_facts to authenticated;
grant select on live_race_events to authenticated;
