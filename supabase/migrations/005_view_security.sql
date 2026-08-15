-- 005_view_security.sql — narrow the security-definer surface to one view.
--
-- Postgres views run as their owner unless told otherwise, which means they
-- bypass RLS. For most of these that is an accident rather than a decision, and
-- the database linter is right to flag it.
--
-- After this migration exactly one view is security definer:
--
--   published_results   DELIBERATE. It is the only way an anonymous visitor
--                       may see a boat or helm name, and only for races that
--                       have been published. Its WHERE clause is the whole of
--                       the protection, so change it with care.
--
-- The rest become security invoker. They are granted to `authenticated` only,
-- and that role already has full access under RLS, so nothing is lost. When
-- published_results (still definer) reads them, they execute in its owner's
-- context and behave exactly as before.

alter view live_race_events set (security_invoker = true);
alter view race_entry_facts set (security_invoker = true);
alter view helm_season_wins set (security_invoker = true);
