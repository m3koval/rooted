-- Disposable local database, real public RPC regression: zero is a saved rate.
\set ON_ERROR_STOP on
begin;
do $$
declare a uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); q uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); e uuid:=gen_random_uuid(); c uuid; rev uuid; r jsonb;
begin
 insert into auth.users(id,email) values(a,'zero-rate@example.invalid');
 insert into rooted.leaders(user_id,display_name,role) values(a,'Zero rate leader','leader');
 insert into rooted.participants(id,name,previously_attended) values(p,'Zero source',true),(q,'Zero destination',true);
 insert into rooted.seasons(id,name,starts_on,ends_on) values(s,'Zero test','2026-01-01','2026-12-31');
 insert into rooted.events(id,season_id,name,date,reading_week) values(e,s,'Zero rates','2026-09-28','2026-09-28');
 perform set_config('request.jwt.claim.sub',a::text,true);
 execute 'set local role authenticated';
 r:=public.rooted_leader_mutate(gen_random_uuid(),'checkin',jsonb_build_object('participant_id',p,'event_id',e,'attended',false,'bible',false,'chapters',0));
 c:=(r#>>'{result,receipt,checkin_id}')::uuid;
 execute 'reset role'; update rooted.rates set attendance=0,bible=0;
 execute 'set local role authenticated';
 r:=public.rooted_correct_checkin(gen_random_uuid(),c,null,p,true,true,0); rev:=(r#>>'{result,revision_id}')::uuid;
 execute 'reset role'; update rooted.rates set attendance=19,bible=13;
 execute 'set local role authenticated';
 r:=public.rooted_correct_checkin(gen_random_uuid(),c,rev,p,true,true,4); rev:=(r#>>'{result,revision_id}')::uuid;
 execute 'reset role';
 assert (select coalesce(sum(points),0) from rooted.ledger where participant_id=p and kind in ('attendance','bible','attendance_correction','bible_correction'))=0,'chapters-only edit must preserve zero first-enabled rates';
 execute 'set local role authenticated';
 r:=public.rooted_correct_checkin(gen_random_uuid(),c,rev,p,false,false,0); rev:=(r#>>'{result,revision_id}')::uuid;
 r:=public.rooted_correct_checkin(gen_random_uuid(),c,rev,p,true,true,4); rev:=(r#>>'{result,revision_id}')::uuid;
 r:=public.rooted_correct_checkin(gen_random_uuid(),c,rev,q,true,true,4); rev:=(r#>>'{result,revision_id}')::uuid;
 r:=public.rooted_correct_checkin(gen_random_uuid(),c,rev,p,true,true,4);
 execute 'reset role';
 assert (select coalesce(sum(points),0) from rooted.ledger where participant_id in(p,q) and kind in ('attendance','bible','attendance_correction','bible_correction'))=0,'zero remains zero after off/on and transfer/back';
 assert (select sum(points) from rooted.ledger where participant_id=p)=4;
 raise notice 'PASS zero first-enabled attendance/Bible rates survive rate changes, chapters edit, off/on and transfer/back';
end $$;
set constraints all immediate;
rollback;
