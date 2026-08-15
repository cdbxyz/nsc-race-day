# Supabase setup

Everything below has already been done for the club's live project. This
document exists so it can be redone — on a new project, after a disaster, or by
whoever inherits this in three years.

**Live project:** `nsc-race-day` (`lqqueagkoobpdcvcjomm`), region `eu-west-2`.

> **Before the club uses this for real, do step 7** — the PIN currently set is a
> temporary one used to test the flow.

---

## What the two config values are

`js/supabase.js` starts with a `CONFIG` block holding the only two values the
app needs:

```js
export const CONFIG = {
  url: "https://lqqueagkoobpdcvcjomm.supabase.co",
  publishableKey: "sb_publishable_SzJkkqsDM5EIkr8HinKXFw_xn3519n0",
};
```

Both are safe in public JavaScript. The publishable key grants nothing beyond
the `anon` policies in `002_rls.sql`: read-only, and only on published races.
Find them in the dashboard under **Project Settings → API**.

The **service role key is not in this repo and must never be.** It lives only in
the edge function's runtime environment, where Supabase injects it
automatically.

---

## 1. Create the project

Dashboard → **New project**. Pick a region near the club (`eu-west-2`, London)
— every tap on the beach makes a round trip to it.

Keep the generated database password somewhere safe. You will not need it for
anything below, but you will want it eventually.

## 2. Run the migrations

With the [Supabase CLI](https://supabase.com/docs/guides/cli):

```sh
supabase link --project-ref <your-ref>
supabase db push
```

That applies, in order:

| file | what it does |
|---|---|
| `001_schema.sql` | the ten tables from ARCHITECTURE.md §4, all keyed on client-generated UUIDs |
| `002_rls.sql` | RLS on every table: `authenticated` full access, `anon` read-only on published races |
| `003_views.sql` | `published_results` and `helm_season_wins`, both derived from the event log |
| `004_club_auth.sql` | the hashed club PIN, attempt rate limiting, and the two functions that manage them |
| `005_view_security.sql` | an attempt to make the intermediate views security-invoker |
| `006_revoke_grants.sql` | removes `anon`'s default grants on the PIN tables and internal views |
| `007_view_security_fix.sql` | reverts 005, which broke the public results page |

Without the CLI, paste each file into the dashboard **SQL Editor** in numeric
order instead.

> 005 and 007 cancel out. They are both kept because the comments in them
> explain why the views are the way they are, which is the first thing anyone
> will want to change.

### About the "Security Definer View" warnings

The database linter reports four views as `SECURITY DEFINER` errors. This is
expected and deliberate. `published_results` has to bypass RLS — it is the one
place an anonymous visitor may read a boat or helm name, and only for races
that have been published. What protects the data is:

1. `anon` has **no grant at all** on the internal views (`race_entry_facts`,
   `live_race_events`) or the PIN tables, so it cannot query them directly;
2. `published_results` filters to `status = 'published'`.

That `WHERE` clause is the security boundary. Treat changes to it accordingly.

## 3. Create the shared club account

There are no per-member accounts. One account is shared, and the PIN is what
gates access to it (ARCHITECTURE.md D5).

Dashboard → **Authentication → Users → Add user**:

- Email: `club@nsc-race-day.local`
- Password: generate a long random one — **nobody ever needs to know it**, and
  no part of this system stores it. The edge function mints sessions with the
  service role key instead.
- Tick **Auto Confirm User**.

Then note the user's UUID and make the edge function aware of the email if you
chose a different one (see step 5).

> **Do not create this user by hand with `INSERT INTO auth.users`.** Several of
> that table's text columns have no default, and GoTrue reads them into
> non-nullable strings — a hand-made row fails every lookup with the unhelpful
> "Database error finding user". If you must, set `confirmation_token`,
> `recovery_token`, `email_change_token_new` and `email_change` to `''`
> explicitly. The dashboard does this correctly.

## 4. Deploy the edge function

```sh
supabase functions deploy pin-auth --no-verify-jwt
```

`--no-verify-jwt` is required and deliberate: this is the endpoint a phone with
no session calls in order to get one. Its own authentication is the PIN check
plus per-IP rate limiting inside `verify_club_pin()`.

## 5. Optional environment settings

| secret | needed? | what it does |
|---|---|---|
| `CLUB_EMAIL` | only if you used a different address in step 3 | which account to mint sessions for |
| `CLUB_PIN` | no | if set, this plain-text PIN is used instead of the hashed one in the database |

```sh
supabase secrets set CLUB_EMAIL=club@nsc-race-day.local
```

ARCHITECTURE.md §9 describes the PIN living in Supabase secrets. It still can —
`CLUB_PIN` takes precedence if set. The database is the default because it is
hashed at rest, the committee can rotate it without the CLI, and putting the
check in Postgres lets the same statement do the rate limiting.

## 6. Paste the config into the app

Copy the project URL and publishable key into the `CONFIG` block at the top of
`js/supabase.js`, then `npm run stamp` and commit. (The stamp is what tells
already-installed phones there is a new build — see the README.)

## 7. Set the club PIN

> **Never commit the real PIN to this repository.** It is public: anything
> written here is readable by anyone, and git remembers it even after the line
> is deleted. The PIN is the only thing standing between the internet and
> write access to the club's race records. Keep it where the committee keeps
> its other shared secrets, and put a placeholder in this file.

**This is the step that matters before first real use.** Dashboard → **SQL
Editor**:

```sql
select set_club_pin('<the club PIN>');
```

Minimum four characters; six digits is a reasonable club choice. It is stored
bcrypt-hashed — the plain PIN is never written down anywhere in the system, so
if the committee forgets it, set a new one.

**Rotating it** is the same statement with a new value. No redeploy, no code
change, nothing to reinstall on anyone's phone. Rotate immediately if the PIN
has ever been written somewhere public.

### If someone is locked out

Ten wrong PINs from one IP address within fifteen minutes locks that address
out, correct PIN included. That is deliberate: a six-digit PIN is a million
guesses, and an unthrottled endpoint gives it up. To clear it early:

```sql
delete from pin_attempts where ip = '<their ip>';
-- or, to clear everyone
delete from pin_attempts;
```

---

## Checking it works

```sh
URL=https://lqqueagkoobpdcvcjomm.supabase.co
KEY=sb_publishable_SzJkkqsDM5EIkr8HinKXFw_xn3519n0

# wrong PIN -> 401, and tells you how many tries remain
curl -s -X POST -H "apikey: $KEY" -H "Content-Type: application/json" \
     -d '{"pin":"000000"}' "$URL/functions/v1/pin-auth"

# right PIN -> a session
curl -s -X POST -H "apikey: $KEY" -H "Content-Type: application/json" \
     -d '{"pin":"<the club PIN>"}' "$URL/functions/v1/pin-auth"

# the public can read a published race...
curl -s -H "apikey: $KEY" "$URL/rest/v1/published_results?select=boat_name,position"

# ...but not the boat register, and not anything unpublished
curl -s -H "apikey: $KEY" "$URL/rest/v1/boats?select=name"          # []
curl -s -H "apikey: $KEY" "$URL/rest/v1/races?select=number,status" # published only
```

---

## Test data

The live project currently holds a seeded race day (2026-08-15) with three
races, used to verify the results views. Clear it before the club's first real
race day:

```sql
delete from race_events;
delete from entries;
delete from races;
delete from checklist_runs;
delete from race_days;
delete from series;
delete from boats;
delete from helms;
delete from classes;
```

Leave `club_config` alone — that is the PIN.
