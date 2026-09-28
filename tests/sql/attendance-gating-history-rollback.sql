-- Local-only upgrade simulation: seed old-format absent evidence, restore gates.
\set ON_ERROR_STOP on
begin;
alter table rooted.checkins drop constraint checkins_attendance_chapters;
do $$
declare a uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); e uuid:=gen_random_uuid(); e2 uuid:=gen_random_uuid(); e3 uuid:=gen_random_uuid(); c uuid; c2 uuid; r jsonb; req uuid:=gen_random_uuid(); payload jsonb; historical jsonb; original jsonb;
begin
 insert into auth.users(id,email) values(a,'attendance-history@example.invalid');
 insert into rooted.leaders(user_id,display_name,role) values(a,'History leader','leader');
 insert into rooted.participants(id,name,previously_attended) values(p,'Historic absent',true);
 insert into rooted.seasons(id,name,starts_on,ends_on) values(s,'History','2026-01-01','2026-12-31');
 insert into rooted.events(id,season_id,name,date,reading_week) values(e,s,'History 1','2026-09-28','2026-09-28'),(e2,s,'History 2','2026-09-29','2026-09-28'),(e3,s,'History 3','2026-09-30','2026-09-28');
 perform set_config('request.jwt.claim.sub',a::text,true);
 r:=public.rooted_leader_mutate(gen_random_uuid(),'checkin',jsonb_build_object('participant_id',p,'event_id',e2,'attended',true,'bible',false,'chapters',12)); c2:=(r#>>'{result,receipt,checkin_id}')::uuid;
 -- Faithful legacy absent credit fixture. The original record is never rewritten.
 insert into rooted.checkins(participant_id,event_id,attended,bible,chapters,actor_id) values(p,e,false,false,40,a) returning id into c;
 insert into rooted.ledger(participant_id,event_id,checkin_id,kind,points,source,reason,actor_id) values(p,e,c,'reading',28,'history:'||req,'Legacy absent credit',a);
 update rooted.reading_totals set chapters=40 where participant_id=p;
 payload:=jsonb_build_object('participant_id',p,'event_id',e,'attended',false,'bible',false,'chapters',40);
 historical:=rooted.finish(req,a,'leader','checkin',payload,jsonb_build_object('duplicate',false,'receipt',rooted.receipt(c)));
 select to_jsonb(x) into original from rooted.checkins x where id=c;
 alter table rooted.checkins add constraint checkins_attendance_chapters check(attended or (not bible and chapters=0)) not valid;
 execute 'set local role authenticated';
 assert public.rooted_leader_mutate(req,'checkin',payload)=historical,'historical exact replay remains a receipt, not a new write';
 begin perform public.rooted_leader_mutate(gen_random_uuid(),'checkin',jsonb_build_object('participant_id',p,'event_id',e3,'attended',true,'bible',false,'chapters',13)); raise exception 'FAIL silently consumed historical absent high-water'; exception when object_not_in_prerequisite_state then null; end;
 execute 'reset role';
 assert (select chapters from rooted.reading_totals where participant_id=p)=40,'no implicit historical credit write';
 assert not exists(select 1 from rooted.checkins where participant_id=p and event_id=e3),'blocked create atomic';
 execute 'set local role authenticated';
 -- Explicit edit reconciles only this participant/week, filtering even OTHER
 -- legacy absent reports. This proves MAX has an attendance predicate.
 r:=public.rooted_correct_checkin(gen_random_uuid(),c2,null,p,true,false,10);
 execute 'reset role';
 assert (select chapters from rooted.reading_totals where participant_id=p)=10,'weekly maximum excludes other absent legacy report';
 assert (select sum(points) from rooted.ledger where participant_id=p and kind in ('reading','reading_correction'))=10;
 assert (select to_jsonb(x) from rooted.checkins x where id=c)=original;
 execute 'set local role authenticated';
 r:=public.rooted_correct_checkin(gen_random_uuid(),c,null,p,false,false,0);
 r:=public.rooted_leader_mutate(gen_random_uuid(),'checkin',jsonb_build_object('participant_id',p,'event_id',e3,'attended',true,'bible',false,'chapters',13));
 assert (r#>>'{result,receipt,earned_points}')::integer=8,'future present credit 5 attendance + 3 chapters';
 execute 'reset role';
 assert (select sum(points) from rooted.ledger where participant_id=p and kind in ('reading','reading_correction'))=13;
 assert (select to_jsonb(x) from rooted.checkins x where id=c)=original;
 begin insert into rooted.checkins(participant_id,event_id,attended,bible,chapters,actor_id) values(p,e,false,false,1,a); raise exception 'FAIL table gate'; exception when check_violation then null; end;
 raise notice 'PASS historical attendance: immutable absent evidence/receipts, no implicit create backfill, explicit week reconciliation filters all absent reports, future credit, table gate';
end $$;
set constraints all immediate;
rollback;
