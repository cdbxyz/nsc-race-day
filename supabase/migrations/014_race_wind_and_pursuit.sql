-- 014_race_wind_and_pursuit.sql — wind conditions, recorded per race.
--
-- Wind belongs to the RACE, not the day. Two races on one August afternoon can
-- be quite different, and a results sheet that reports the day's wind against
-- the morning race is simply wrong.
--
-- Direction is the 8-point compass and is the direction the wind blows FROM,
-- the way a sailor says it. Strength is Beaufort: it is what an OOD can judge
-- by eye from the beach without an anemometer, and it is what the club's own
-- race reports already use.
--
-- The force check allows the full 0-12 scale even though the app only offers
-- F0-F8. Nobody at this club is racing in a hurricane, but a constraint that
-- lies about the scale is worse than one that is generous, and widening a
-- CHECK later is a migration nobody should have to write.
--
-- is_pursuit is a flag, not a feature. v1 scores handicap starts only; a
-- pursuit race is a different format altogether, so the app names it and
-- points the OOD at the club's separate calculator rather than pretending.

alter table races
  add column wind_direction text,
  add column wind_force int,
  add column is_pursuit boolean not null default false;

alter table races
  add constraint races_wind_direction_check
  check (wind_direction is null
         or wind_direction in ('N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'));

alter table races
  add constraint races_wind_force_check
  check (wind_force is null or (wind_force >= 0 and wind_force <= 12));

comment on column races.wind_direction is
  'Compass point the wind blows FROM, 8-point. Null until recorded.';
comment on column races.wind_force is
  'Beaufort force. The app offers F0-F8; the constraint allows the full scale.';
comment on column races.is_pursuit is
  'Pursuit starts are not scored by this app — the OOD is sent to the club calculator.';
