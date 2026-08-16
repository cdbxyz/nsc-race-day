-- 011_crew_and_combinations.sql — the entry becomes a combination.
--
-- At this club most boats have no name. The thing that persists from week to
-- week is the pairing: a helm, sometimes a crew, in a class. Modelling the
-- hull as the identity forced people to invent boats called "Hamish + Lisa",
-- which is a workaround pretending to be data.
--
-- So the entry now carries the class directly — that is where the PY comes
-- from — and the hull becomes optional, recorded only when there genuinely is
-- one worth naming. The duplicate guard changes to (race_id, helm_id), which
-- is the truer rule: a helm sails one boat per race.
--
-- Handicaps are untouched by any of this. Wins and factors attach to the HELM
-- alone, whoever is sitting on the wire.

/* ---- crew size on the class ------------------------------------------- */

alter table classes
  add column crew_size int not null default 1
  constraint classes_crew_size_check check (crew_size in (1, 2));

comment on column classes.crew_size is
  'People aboard: 1 single-handed, 2 double-handed. Drives whether sign-on offers a crew field.';

/* Standard configurations. Anything not listed keeps the default of 1, which
   is the safe way round: a crew field that should have appeared is a visible
   omission, one that should not have is a confusing empty box. */
update classes set crew_size = 2 where name in (
  'Laser 2000', 'Wayfarer', 'RS Vision', 'Feva XL', 'Albacore', 'Merlin', 'Hobie 16'
);
update classes set crew_size = 1 where name in (
  'Topper', 'Aero 5', 'Phantom', 'Supernova', 'Pico', 'Pico Race',
  'Mirror SH w/Spin', 'Mirror SH wo/spin'
);

/* ---- crew on the entry -------------------------------------------------
   Crew comes from the same people register as helms. There is deliberately
   no second table: `helms` IS the members register, and a person is a helm
   one week and crew the next. */

alter table entries add column crew_id uuid references helms;

comment on column entries.crew_id is
  'Optional second person, from the same register as helms. A double-hander sailed solo is normal.';

/* ---- the class moves onto the entry ----------------------------------- */

alter table entries add column class_id uuid references classes;

update entries e
set class_id = b.class_id
from boats b
where b.id = e.boat_id and e.class_id is null;

alter table entries alter column class_id set not null;

/* ---- the hull becomes optional ---------------------------------------- */

alter table entries alter column boat_id drop not null;
alter table boats   alter column name    drop not null;

comment on column entries.boat_id is
  'The physical hull, when there is one worth recording. Null is normal: most boats here are identified by who is sailing them.';

/* Entries currently pointing at a boat that is really a crew pairing are
   detached: the class has already been copied across, so nothing is lost, and
   the pairing rows can then go. Names are NOT parsed out of them — they are
   first names and initials, while the members register holds these people
   under their full names, and parsing would recreate the duplicate identities
   the register was just cleaned of. Crew is recorded properly at sign-on. */
update entries
set boat_id = null
where boat_id in (select id from boats where name like '%+%');

delete from boats where name like '%+%';

/* ---- duplicate guards -------------------------------------------------- */

alter table entries drop constraint entries_race_id_boat_id_key;

-- A helm sails one boat per race.
alter table entries add constraint entries_race_helm_key unique (race_id, helm_id);

-- And a real hull cannot be sailed twice in the same race either, but only
-- where one is recorded: any number of entries may have no hull at all.
create unique index entries_race_boat_key
  on entries (race_id, boat_id) where boat_id is not null;
