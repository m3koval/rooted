-- FICTIONAL, transaction-only fixtures. Invoked by run_daily_rollback.py after
-- applying ONLY the daily forward migration inside the same BEGIN/ROLLBACK.
create temporary table daily_pass(label text primary key);
grant select,insert on daily_pass to service_role;
create function pg_temp.ok(b boolean,label text) returns void language plpgsql as $$
begin
 if b is distinct from true then raise exception 'FAILED: %',label; end if;
 insert into daily_pass values(label);
end $$;
create function pg_temp.denied(statement text,expected text,label text) returns void language plpgsql as $$
declare actual text;
begin
 begin execute statement; exception when others then get stacked diagnostics actual=returned_sqlstate; end;
 perform pg_temp.ok(actual=expected,label);
end $$;
-- Pure calendar cases, independent of database/client timezone and actual date.
set local timezone='Pacific/Honolulu';
select pg_temp.ok((((t at time zone 'America/New_York')::date+1)::timestamp at time zone 'America/New_York')=expected,label)
from (values
 ('2026-03-08 05:00:00+00'::timestamptz,'2026-03-09 04:00:00+00'::timestamptz,'DST spring day ends after 23 hours'),
 ('2026-11-01 04:00:00+00','2026-11-02 05:00:00+00','DST fall day ends after 25 hours'),
 ('2026-09-26 03:59:59+00','2026-09-26 04:00:00+00','one second before Eastern midnight'),
 ('2026-09-26 04:00:00+00','2026-09-27 04:00:00+00','at Eastern midnight next day begins')
) v(t,expected,label);
do $$
declare
 uid uuid:=gen_random_uuid(); sid uuid:=gen_random_uuid(); eid uuid:=gen_random_uuid();
 season uuid:=gen_random_uuid(); child uuid:=gen_random_uuid(); did uuid;
 station_token text:=encode(extensions.gen_random_bytes(32),'hex');
 pin text:='907431'; r jsonb; r2 jsonb; token text; original_expiry timestamptz;
 n bigint; pts bigint; payload jsonb; request uuid:=gen_random_uuid();
begin
 -- No existing leader, participant, event, season, or station is mutated.
 insert into auth.users(id,email) values(uid,'daily-rollback-'||uid||'@example.invalid');
 insert into rooted.leaders(user_id,display_name,role) values(uid,'Fictional Daily Leader','leader');
 -- Isolated direct fixture hash avoids altering real PINs or their uniqueness state.
 insert into rooted.checkin_pins(user_id,pin_hash) values(uid,extensions.crypt(pin,extensions.gen_salt('bf',4)));
 insert into rooted.seasons(id,name,starts_on,ends_on) values(season,'Fictional Daily Season',current_date,current_date+10);
 insert into rooted.events(id,season_id,name,date,reading_week) values(eid,season,'Fictional Daily Event',current_date,date_trunc('week',current_date)::date);
 insert into rooted.participants(id,name,previously_attended) values(child,'Fictional Daily Child',true);
 insert into rooted.stations(id,event_id,label,token_hash,authorized_by,expires_at)
 values(sid,eid,'Fictional Daily Station',extensions.digest(station_token,'sha256'),uid,clock_timestamp()+interval '3 days');
 execute 'set local role service_role';
 r:=public.rooted_station_unlock(station_token,pin); token:=r->>'device_token';
 perform pg_temp.ok((r->>'ok')::boolean,'PIN unlock succeeds');
 perform pg_temp.ok(public.rooted_kiosk(token,'context')->'event'->>'id'=eid::text,'same-day restored token context succeeds');
 perform pg_temp.ok(public.rooted_kiosk(token,'context')->'event'->>'id'=eid::text,'repeat same-day context needs no PIN');
 execute 'reset role';
 select id,expires_at into did,original_expiry from rooted.devices where token_hash=extensions.digest(token,'sha256');
 perform pg_temp.ok((select expires_at=((created_at at time zone 'America/New_York')::date+1)::timestamp at time zone 'America/New_York' from rooted.devices where id=did),'issued expiry is exactly next Eastern midnight');
 payload:=jsonb_build_object('participant_id',child,'bible',true,'chapters',3);
 execute 'set local role service_role';
 r:=public.rooted_kiosk(token,'checkin',payload,request);
 perform pg_temp.ok((r#>>'{result,duplicate}')::boolean=false,'first checkin is new');
 perform pg_temp.ok(public.rooted_kiosk(token,'person',jsonb_build_object('participant_id',child))->>'already_checked_in'='true','person reports Already checked in');
 perform pg_temp.ok(public.rooted_kiosk(token,'checkin',payload,request)=r,'same-request replay returns original receipt');
 execute 'reset role';
 select count(*),sum(points) into n,pts from rooted.ledger where participant_id=child;
 execute 'set local role service_role';
 r2:=public.rooted_kiosk(token,'checkin',payload,gen_random_uuid());
 perform pg_temp.ok((r2#>>'{result,duplicate}')::boolean,'new request same event is duplicate');
 perform pg_temp.ok(r2#>'{result,receipt}'=r#>'{result,receipt}','duplicate returns original receipt');
 perform pg_temp.denied(format('select public.rooted_kiosk(%L,''checkin'',%L::jsonb,gen_random_uuid())',token,payload||'{"chapters":4}'),'23505','changed duplicate denied');
 execute 'reset role';
 perform pg_temp.ok((select count(*)=1 from rooted.checkins where participant_id=child and event_id=eid),'one child-event attendance row');
 perform pg_temp.ok((select count(*)=n and sum(points)=pts from rooted.ledger where participant_id=child),'duplicates add no ledger rows or points');
 -- Simulate a previously issued 4-hour session: migration never extends it.
 update rooted.devices set expires_at=least(original_expiry,clock_timestamp()+interval '4 hours') where id=did;
 select expires_at into original_expiry from rooted.devices where id=did;
 perform rooted.require_device(token);
 perform pg_temp.ok((select expires_at=original_expiry from rooted.devices where id=did),'validation does not extend existing expiry');
 -- An old device manually prolonged into today must still fail server-side.
 update rooted.devices set created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()+interval '1 day' where id=did;
 execute 'set local role service_role';
 perform pg_temp.denied(format('select public.rooted_kiosk(%L,''context'')',token),'42501','previous-day prolonged session denied');
 perform pg_temp.denied(format('select public.rooted_kiosk(%L,''checkin'',%L::jsonb,%L::uuid)',token,payload,request),'42501','old-day receipt replay cannot bypass daily gate');
 r2:=public.rooted_station_unlock(station_token,pin);
 perform pg_temp.ok((r2->>'ok')::boolean and r2->>'device_token'<>token,'fresh PIN issues new session after old-day denial');
 perform pg_temp.ok(public.rooted_kiosk(r2->>'device_token','context')->'event'->>'id'=eid::text,'fresh daily session accepted');
 execute 'reset role';
 update rooted.devices set expires_at=(clock_timestamp() at time zone 'America/New_York')::date::timestamp at time zone 'America/New_York' where id=did;
 execute 'set local role service_role';
 perform pg_temp.denied(format('select public.rooted_kiosk(%L,''context'')',token),'42501','session expired at day boundary denied');
 execute 'reset role';
 token:=r2->>'device_token';
 update rooted.leaders set active=false where user_id=uid;
 execute 'set local role service_role';
 perform pg_temp.denied(format('select public.rooted_kiosk(%L,''context'')',token),'42501','inactive issuer still invalidates session');
 execute 'reset role';
 update rooted.leaders set active=true where user_id=uid;
 update rooted.events set open=false where id=eid;
 execute 'set local role service_role';
 perform pg_temp.denied(format('select public.rooted_kiosk(%L,''context'')',token),'22023','closed event still invalidates session');
 execute 'reset role';
 update rooted.events set open=true where id=eid;
 update rooted.stations set revoked_at=clock_timestamp(),revoked_by=uid where id=sid;
 execute 'set local role service_role';
 perform pg_temp.denied(format('select public.rooted_kiosk(%L,''context'')',token),'42501','revoked station still invalidates session');
 execute 'reset role';
 update rooted.stations set revoked_at=null,revoked_by=null,expires_at=clock_timestamp()+interval '1 second' where id=sid;
 select expires_at into original_expiry from rooted.stations where id=sid;
 execute 'set local role service_role';
 r2:=public.rooted_station_unlock(station_token,pin);
 perform pg_temp.ok((r2->>'expires_at')::timestamptz=original_expiry,'shorter parent station expiry caps new session');
 execute 'reset role';
end $$;
select pg_temp.ok(not exists(select 1 from daily_acl_before b join pg_proc p on p.oid=b.oid where p.proacl is distinct from b.proacl or p.proowner<>b.proowner or p.prosecdef<>b.prosecdef or p.proconfig is distinct from b.proconfig),'function ACL ownership definer and search_path unchanged');
select pg_temp.ok(not exists(select 1 from daily_devices_before b join rooted.devices d on d.id=b.id where d.expires_at<>b.expires_at),'all pre-existing device expiries unchanged');
select count(*) as passed_assertions,jsonb_agg(label order by label) as passed from daily_pass;
