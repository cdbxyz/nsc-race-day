-- 004_club_auth.sql — where the club PIN lives, and how it is checked.
--
-- ARCHITECTURE.md section 9 puts the PIN in Supabase secrets. This adds a
-- second, preferred home for it: a bcrypt hash in a table only the service role
-- can reach. The edge function still honours a CLUB_PIN environment secret and
-- prefers it if set, so the documented route works — but the table is the
-- default because:
--
--   * the committee can rotate the PIN from the dashboard with one SQL snippet,
--     with no CLI, no redeploy and nobody needing a Supabase login with secret
--     permissions;
--   * it is hashed at rest, where an environment secret is plain text;
--   * checking it in Postgres lets the same statement do the rate limiting.
--
-- Rate limiting is not optional here. A four-digit PIN is ten thousand guesses,
-- which an unthrottled endpoint gives up in minutes — and the prize is write
-- access to the club's race records.

create table club_config (
  id text primary key default 'default',
  pin_hash text not null,
  updated_at timestamptz not null default now()
);

-- RLS on with no policies at all: unreachable by anon and authenticated alike.
-- Only the service role, which bypasses RLS, can see it.
alter table club_config enable row level security;

create table pin_attempts (
  id bigserial primary key,
  ip text not null,
  ok boolean not null,
  at timestamptz not null default now()
);

alter table pin_attempts enable row level security;

create index pin_attempts_ip_at_idx on pin_attempts (ip, at desc);

-- ---------------------------------------------------------------------------
-- verify_club_pin — the only way to test a PIN.
--
-- Returns {"ok": bool, "locked": bool, "remaining": int}. Records every
-- attempt, and refuses outright once an address has failed too often, so a
-- guessing script hits a wall rather than the whole keyspace.
-- ---------------------------------------------------------------------------
create or replace function verify_club_pin(p_pin text, p_ip text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  max_failures constant int := 10;
  window_length constant interval := interval '15 minutes';
  recent_failures int;
  stored_hash text;
  matched boolean;
begin
  select count(*) into recent_failures
  from pin_attempts
  where ip = p_ip and not ok and at > now() - window_length;

  if recent_failures >= max_failures then
    return jsonb_build_object('ok', false, 'locked', true, 'remaining', 0);
  end if;

  select pin_hash into stored_hash from club_config where id = 'default';

  if stored_hash is null then
    -- No PIN configured yet. Refuse rather than let anyone in.
    return jsonb_build_object('ok', false, 'locked', false, 'remaining', max_failures - recent_failures);
  end if;

  matched := stored_hash = crypt(p_pin, stored_hash);

  insert into pin_attempts (ip, ok) values (p_ip, matched);

  if matched then
    -- A correct PIN clears the slate for that address.
    delete from pin_attempts where ip = p_ip and not ok;
    return jsonb_build_object('ok', true, 'locked', false, 'remaining', max_failures);
  end if;

  return jsonb_build_object(
    'ok', false,
    'locked', false,
    'remaining', greatest(max_failures - recent_failures - 1, 0)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- set_club_pin — how the committee rotates it. See SETUP.md.
-- ---------------------------------------------------------------------------
create or replace function set_club_pin(p_pin text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if length(p_pin) < 4 then
    raise exception 'club PIN must be at least 4 characters';
  end if;

  insert into club_config (id, pin_hash, updated_at)
  values ('default', crypt(p_pin, gen_salt('bf')), now())
  on conflict (id) do update
    set pin_hash = excluded.pin_hash, updated_at = now();
end;
$$;

-- Neither function is reachable from the public API. The edge function calls
-- them with the service role key; nothing else can.
revoke all on function verify_club_pin(text, text) from public, anon, authenticated;
revoke all on function set_club_pin(text) from public, anon, authenticated;
grant execute on function verify_club_pin(text, text) to service_role;
grant execute on function set_club_pin(text) to service_role;
