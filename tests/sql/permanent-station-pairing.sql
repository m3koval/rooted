-- Disposable PostgreSQL only. Run after the old chain, before the new migration.
\set ON_ERROR_STOP on
create function pg_temp.ok(b boolean,label text) returns void language plpgsql as $$ begin if b is distinct from true then raise exception 'FAILED: %',label; end if; raise notice 'PASS: %',label; end $$;
create function pg_temp.denied(q text,code text,label text) returns void language plpgsql as $$ declare actual text; begin begin execute q; exception when others then get stacked diagnostics actual=returned_sqlstate; end; perform pg_temp.ok(actual=code,label); end $$;
-- Fixed private test clock: the real migration retains this helper and its ACL.
create or replace function rooted.gathering_now() returns timestamptz language sql volatile set search_path='' as $$ select '2026-11-13 20:00+00'::timestamptz $$;
insert into auth.users(id,email) values ('13000000-0000-4000-8000-000000000001','station-admin@example.invalid');
insert into rooted.leaders(user_id,display_name,role) values ('13000000-0000-4000-8000-000000000001','Fictional Admin','admin');
insert into rooted.checkin_pins values ('13000000-0000-4000-8000-000000000001',extensions.crypt('012345',extensions.gen_salt('bf',4)),now());
insert into rooted.seasons(id,name,starts_on,ends_on) values ('13000000-0000-4000-8000-000000000002','Fictional Season','2026-01-01','2026-12-31');
insert into rooted.events(id,season_id,name,date,reading_week) values
 ('13000000-0000-4000-8000-000000000003','13000000-0000-4000-8000-000000000002','Today','2026-11-13','2026-11-09'),
 ('13000000-0000-4000-8000-000000000004','13000000-0000-4000-8000-000000000002','Other','2026-11-13','2026-11-09');
insert into rooted.stations(id,event_id,label,token_hash,authorized_by,created_at,expires_at,revoked_at,revoked_by,failed_attempts,locked_until)
select ('13000000-0000-4000-8000-00000000000'||n)::uuid,'13000000-0000-4000-8000-000000000003','Fictional '||n,extensions.digest(repeat(n::text,64),'sha256'),'13000000-0000-4000-8000-000000000001','2026-09-01','2026-10-01',case when n=6 then '2026-09-20'::timestamptz end,case when n=6 then '13000000-0000-4000-8000-000000000001'::uuid end,case when n=7 then 5 else 0 end,case when n=7 then '2026-11-13 20:15+00'::timestamptz end from generate_series(5,7) n;
insert into rooted.devices(event_id,label,token_hash,issued_by,created_at,expires_at,station_id,revoked_at,revoked_by,system_revoked_at)
select '13000000-0000-4000-8000-000000000003','Old daily '||n,extensions.digest(repeat(n::text,64),'sha256'),'13000000-0000-4000-8000-000000000001','2026-09-29','2026-10-01','13000000-0000-4000-8000-000000000005',case when n=8 then '2026-09-30'::timestamptz end,case when n=8 then '13000000-0000-4000-8000-000000000001'::uuid end,case when n=9 then '2026-09-30'::timestamptz end from generate_series(8,9) n;
insert into rooted.devices(event_id,label,token_hash,issued_by,created_at,expires_at,station_id)
values ('13000000-0000-4000-8000-000000000003','Expired only',extensions.digest(repeat('c',64),'sha256'),'13000000-0000-4000-8000-000000000001','2026-09-29','2026-10-01','13000000-0000-4000-8000-000000000005');
create temporary table device_before as select * from rooted.devices;
create temporary table station_before as select * from rooted.stations;
create temporary table acl_before as select oid,proowner,proacl,prosecdef,proconfig from pg_proc where oid in ('public.rooted_station_manage(text,jsonb)'::regprocedure,'public.rooted_station_unlock(text,text)'::regprocedure,'rooted.require_device(text)'::regprocedure,'public.rooted_station_transfer(uuid,uuid,uuid,text)'::regprocedure);
-- Demonstrate the reported baseline failure before the fix.
select pg_temp.ok(public.rooted_station_unlock(repeat('5',64),'012345')->>'error'='invalid_station','baseline: expired remembered pairing rejected');
\ir ../../supabase/migrations/20261113000100_rooted_permanent_station_pairing.sql
select pg_temp.ok(not exists(select * from device_before except select * from rooted.devices) and (select count(*) from rooted.devices)=(select count(*) from device_before),'migration preserves every daily-device field');
select pg_temp.ok((select to_jsonb(s)=to_jsonb(b) from rooted.stations s join station_before b using(id) where s.revoked_at is not null),'revoked station completely unchanged');
select pg_temp.ok(not exists(select 1 from rooted.stations where revoked_at is null and expires_at is not null),'expired nonrevoked pairing restored without new secret');
select pg_temp.ok(not exists(select 1 from acl_before b join pg_proc p using(oid) where p.proowner<>b.proowner or p.proacl is distinct from b.proacl or p.prosecdef<>b.prosecdef or p.proconfig is distinct from b.proconfig),'all function ownership ACL definer and search paths preserved');
do $$
declare r jsonb; t text; did uuid; sid uuid; q uuid:=gen_random_uuid();
begin
 execute 'set role service_role';
 perform pg_temp.ok(public.rooted_station_unlock(repeat('5',64),null)->>'error'='invalid_pin','restored pairing still requires PIN');
 perform pg_temp.ok(public.rooted_station_unlock(repeat('6',64),'012345')->>'error'='invalid_station','revoked pairing still denied');
 perform pg_temp.ok(public.rooted_station_unlock(repeat('7',64),'012345')->>'error'='locked','preexisting PIN lockout preserved');
 perform pg_temp.ok(public.rooted_station_unlock(repeat('a',64),'012345')->>'error'='invalid_station','unknown pairing denied');
 perform pg_temp.denied(format('select public.rooted_kiosk(%L,''context'')',repeat('8',64)),'42501','old expired revoked device not resurrected');
 perform pg_temp.denied(format('select public.rooted_display(%L)',repeat('9',64)),'42501','old display session not resurrected');
 perform pg_temp.denied(format('select public.rooted_kiosk(%L,''context'')',repeat('c',64)),'42501','expired unrevoked daily session not resurrected');
 r:=public.rooted_station_unlock(repeat('5',64),'012345');t:=r->>'device_token';
 perform pg_temp.ok((r->>'ok')::boolean,'same remembered secret unlocks after migration');
 perform pg_temp.ok((r->>'expires_at')::timestamptz='2026-11-14 05:00+00','daily expiry still midnight Eastern');
 perform public.rooted_kiosk(t,'context'); perform public.rooted_display(t);
 perform pg_temp.ok(true,'kiosk and private display accept fresh daily session');
 execute 'reset role';
 select id into did from rooted.devices where token_hash=extensions.digest(t,'sha256');
 update rooted.devices set created_at='2026-11-12 20:00+00' where id=did;
 perform pg_temp.denied(format('select rooted.require_device(%L)',t),'42501','previous-day prolonged session denied');
 update rooted.devices set created_at='2026-11-13 20:00+00',system_revoked_at='2026-11-13 20:00+00' where id=did;
 perform pg_temp.denied(format('select rooted.require_device(%L)',t),'42501','system revocation remains enforced');
 update rooted.devices set system_revoked_at=null where id=did;
 update rooted.leaders set active=false where user_id='13000000-0000-4000-8000-000000000001';
 perform pg_temp.denied(format('select rooted.require_device(%L)',t),'42501','inactive issuing leader denied');
 update rooted.leaders set active=true where user_id='13000000-0000-4000-8000-000000000001';
 update rooted.events set open=false where id='13000000-0000-4000-8000-000000000003';
 perform pg_temp.denied(format('select rooted.require_device(%L)',t),'22023','closed gathering denied');
 update rooted.events set open=true where id='13000000-0000-4000-8000-000000000003';
 perform set_config('request.jwt.claim.sub','13000000-0000-4000-8000-000000000001',false);
 execute 'set role authenticated';
 r:=public.rooted_station_manage('station.enroll','{"event_id":"13000000-0000-4000-8000-000000000003","label":"New permanent"}');
 perform pg_temp.ok(r->'station'->'expires_at'='null'::jsonb,'new enrollment has no expiry');
 r:=public.rooted_station_manage('station.enroll','{"event_id":"13000000-0000-4000-8000-000000000003","label":"Cached client","ttl_days":1}');
 perform pg_temp.ok(r->'station'->'expires_at'='null'::jsonb,'cached TTL request cannot reintroduce expiry');
 r:=public.rooted_station_transfer(q,'13000000-0000-4000-8000-000000000005','13000000-0000-4000-8000-000000000004','Move permanent pairing');
 perform pg_temp.ok(r=public.rooted_station_transfer(q,'13000000-0000-4000-8000-000000000005','13000000-0000-4000-8000-000000000004','Move permanent pairing'),'permanent pairing transfer exact replay');
 execute 'set role service_role';
 perform pg_temp.denied(format('select public.rooted_kiosk(%L,''context'')',t),'42501','transfer revokes old daily access');
 perform pg_temp.denied(format('select public.rooted_kiosk(%L,''context'')',repeat('c',64)),'42501','expired unrevoked daily session not resurrected');
 r:=public.rooted_station_unlock(repeat('5',64),'012345');t:=r->>'device_token';
 perform pg_temp.ok(r->>'event_id'='13000000-0000-4000-8000-000000000004','transferred pairing requires PIN and uses target gathering');
 execute 'set role authenticated';
 perform public.rooted_station_manage('station.revoke','{"station_id":"13000000-0000-4000-8000-000000000005"}');
 execute 'set role service_role';
 perform pg_temp.ok(public.rooted_station_unlock(repeat('5',64),'012345')->>'error'='invalid_station','explicit revocation blocks fresh PIN');
 perform pg_temp.denied(format('select public.rooted_display(%L)',t),'42501','explicit station revocation denies existing display');
 execute 'reset role';
 update rooted.stations set failed_attempts=0,locked_until=null where id='13000000-0000-4000-8000-000000000007';
 execute 'set role service_role';
 for i in 1..5 loop r:=public.rooted_station_unlock(repeat('7',64),'999999'); end loop;
 perform pg_temp.ok(r->>'error'='locked','five wrong PINs still lock');
 perform pg_temp.ok(public.rooted_station_unlock(repeat('7',64),'012345')->>'error'='locked','correct PIN cannot bypass lockout');
 execute 'set role anon';
 perform pg_temp.denied('select public.rooted_station_unlock(repeat(''5'',64),''012345'')','42501','anonymous direct unlock denied');
 execute 'set role authenticated';
 perform pg_temp.denied('select public.rooted_station_unlock(repeat(''5'',64),''012345'')','42501','authenticated direct unlock denied');
 execute 'reset role';
end $$;
select 'Permanent pairing regression complete' as result;
