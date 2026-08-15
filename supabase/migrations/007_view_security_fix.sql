-- 007_view_security_fix.sql — undo most of 005.
--
-- 005 set security_invoker on the intermediate views to satisfy the database
-- linter. That broke the public results page: published_results is security
-- definer by design, but when it reads race_entry_facts — and that view reads
-- live_race_events — an invoker view re-checks the underlying objects against
-- the anonymous caller, which 006 had just revoked. The public site got
-- "permission denied for view live_race_events".
--
-- So the chain goes back to definer end to end. What actually protects these
-- views is not the invoker flag but the pair of rules below, which is a
-- simpler thing to reason about:
--
--   1. anon has no grant on the intermediate views at all (006), so it cannot
--      query them directly, whatever their security mode.
--   2. published_results filters to `status = 'published'`, and it is the only
--      anon-readable view that exposes a boat or helm name.
--
-- The linter will keep flagging these as SECURITY DEFINER views. That is
-- expected and accepted: it is how a public projection over private tables
-- works, and the WHERE clause in published_results is the boundary to guard.

alter view live_race_events set (security_invoker = false);
alter view race_entry_facts set (security_invoker = false);
alter view helm_season_wins set (security_invoker = false);
