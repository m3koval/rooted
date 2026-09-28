-- Prior chapter history remains a revision token; old exact receipts still replay.
\set ON_ERROR_STOP on
begin;
do $$
declare a uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); q uuid:=gen_random_uuid(); s uuid:=gen_random_uuid(); e uuid:=gen_random_uuid();
 c uuid; h uuid:=gen_random_uuid(); req uuid:=gen_random_uuid(); lid uuid; r jsonb; old_receipt jsonb; next_rev uuid;
begin
 insert into auth.users(id,email) values(a,'upgrade@example.invalid');
 insert into rooted.leaders(user_id,display_name,role) values(a,'Upgrade admin','admin');
 insert into rooted.participants(id,name,previously_attended) values(p,'Upgrade source',false),(q,'Upgrade destination',false);
 insert into rooted.seasons(id,name,starts_on,ends_on) values(s,'Upgrade','2026-01-01','2026-12-31');
 insert into rooted.events(id,season_id,name,date,reading_week) values(e,s,'Upgrade','2026-09-28','2026-09-28');
 perform set_config('request.jwt.claim.sub',a::text,true);
 r:=public.rooted_leader_mutate(gen_random_uuid(),'checkin',jsonb_build_object('participant_id',p,'event_id',e,'attended',true,'bible',false,'chapters',20)); c:=(r#>>'{result,receipt,checkin_id}')::uuid;
 -- Faithful old-format history fixture (the immutable pre-006 baseline stays untouched).
 insert into rooted.ledger(participant_id,event_id,checkin_id,kind,points,source,reason,actor_id) values(p,e,c,'reading_correction',-8,'chapters.correct:'||req,'Historic chapter reduction',a) returning id into lid;
 insert into rooted.chapter_corrections(id,request_id,checkin_id,before_chapters,after_chapters,weekly_before_chapters,weekly_after_chapters,delta_points,ledger_id,actor_id,reason)
 values(h,req,c,20,12,20,12,-8,lid,a,'Historic chapter reduction');
 update rooted.reading_totals set chapters=12 where participant_id=p;
 old_receipt:=rooted.finish(req,a,'leader','chapters.correct',jsonb_build_object('checkin_id',c,'expected_chapters',20,'new_chapters',12),jsonb_build_object('correction_id',h));
 assert (select revision_id from rooted.effective_checkins where id=c)=h;
 execute 'set local role authenticated';
 begin perform public.rooted_correct_checkin(gen_random_uuid(),c,null,q,true,false,12); raise exception 'ignored old chapter revision'; exception when serialization_failure then null; end;
 r:=public.rooted_correct_checkin(gen_random_uuid(),c,h,q,true,false,12); next_rev:=(r#>>'{result,revision_id}')::uuid;
 assert public.rooted_correct_chapters(req,c,20,12)=old_receipt,'historical exact replay retained';
 -- First attendance is transferred even for truly new visitors without a friend claim.
 r:=public.rooted_leader_state('first_visits');
 assert exists(select 1 from jsonb_array_elements(r->'rows') x where x->>'participant_id'=q::text);
 assert not exists(select 1 from jsonb_array_elements(r->'rows') x where x->>'participant_id'=p::text);
 begin perform public.rooted_leader_mutate(gen_random_uuid(),'friend.award',jsonb_build_object('participant_id',q,'event_id',e,'inviter_id',p)); raise exception 'unsafe corrected referral'; exception when object_not_in_prerequisite_state then null; end;
 r:=public.rooted_leader_mutate(gen_random_uuid(),'checkin',jsonb_build_object('participant_id',p,'event_id',e,'attended',true,'bible',false,'chapters',3));
 assert not (r#>>'{result,duplicate}')::boolean,'new visitor may later genuinely check in';
 execute 'reset role';
 update rooted.events set open=false where id=e;
 execute 'set local role authenticated';
 r:=public.rooted_correct_checkin(gen_random_uuid(),c,next_rev,q,false,false,0);
 execute 'reset role';
 assert (select sum(points) from rooted.ledger where participant_id=q)=0,'admin closed-event removes all corrected credit';
 assert (select count(*) from rooted.chapter_corrections where id=h)=1;
 assert (select count(*) from rooted.first_visits where participant_id=p)=1,'original first-visit audit retained';
 raise notice 'PASS chapter upgrade revision, historical replay, new visitor transfer/later visit, referral safe guard, admin closed-event';
end $$;
set constraints all immediate;
rollback;
