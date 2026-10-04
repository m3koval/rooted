-- Leader-only missing historical entries. No lifecycle or historical data edits.
-- Ordinary check-in and kiosk guards remain unchanged.
begin;
create function public.rooted_record_missed_attendance(p_request_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 actor uuid; replay jsonb; pid uuid; eid uuid; attending boolean; bible boolean; chapters integer;
 reason text; ev rooted.events%rowtype; person rooted.participants%rowtype;
 config rooted.rates%rowtype; cid uuid; prior integer;
begin
 perform rooted.lock_app(); actor:=rooted.require_leader();
 replay:=rooted.replay(p_request_id,actor,'leader','checkin.missed',p_payload);
 if replay is not null then return replay; end if;
 perform rooted.keys(p_payload,array['participant_id','event_id','event_date','attended','bible','chapters','reason']);
 pid:=rooted.uid(p_payload,'participant_id'); eid:=rooted.uid(p_payload,'event_id');
 attending:=rooted.flag(p_payload,'attended'); bible:=rooted.flag(p_payload,'bible');
 chapters:=rooted.num(p_payload,'chapters',0,100000); reason:=rooted.txt(p_payload,'reason',500);
 if not attending and (bible or chapters<>0) then
  raise exception using errcode='22023',message='Absent requires Bible false and chapters zero';
 end if;
 select x.* into ev from rooted.events x where x.id=eid;
 if not found then raise exception using errcode='22023',message='Gathering not found'; end if;
 -- Past dates only, including inactive seasons. Same-day closed and future dates
 -- are deliberately excluded. Never reopen an event or grant device authority.
 if ev.date>= (rooted.gathering_now() at time zone 'America/New_York')::date then
  raise exception using errcode='22023',message='Record missed attendance is only for past gathering dates';
 end if;
 if rooted.day(p_payload,'event_date')<>ev.date then
  raise exception using errcode='40001',message='Gathering date changed; review it again';
 end if;
 select x.* into person from rooted.participants x where x.id=pid;
 if not found then raise exception using errcode='22023',message='Participant not found'; end if;
 -- Effective identity, not the immutable original: absent entries also occupy
 -- a pair, while transferred-away originals must not block a genuine entry.
 if exists(select 1 from rooted.effective_checkins x where x.participant_id=pid and x.event_id=eid) then
  raise exception using errcode='23505',message='A check-in already exists; use Edit check-in';
 end if;
 prior:=coalesce((select t.chapters from rooted.reading_totals t where t.participant_id=pid and t.week=ev.reading_week),0);
 if prior<>(select coalesce(max(x.chapters),0) from rooted.effective_checkins x join rooted.events e on e.id=x.event_id
             where x.participant_id=pid and x.attended and e.reading_week=ev.reading_week) then
  raise exception using errcode='55000',message='Historical weekly reading credit needs explicit check-in reconciliation; no changes saved';
 end if;
 select x.* into config from rooted.rates x where x.id;
 insert into rooted.checkins(participant_id,event_id,attended,bible,chapters,actor_id)
  values(pid,eid,attending,bible,chapters,actor) returning id into cid;
 if attending then
  -- Current configured rates, with zero awards retained as correction evidence.
  perform rooted.award(pid,eid,cid,'attendance',config.attendance,'attendance:'||cid,'Attended',actor,null);
  if bible then perform rooted.award(pid,eid,cid,'bible',config.bible,'bible:'||cid,'Brought Bible',actor,null); end if;
  -- Preserve existing first-visit/referral authority. Never backdate created_at,
  -- move a claim, or accept an inviter through this bounded recovery path.
  if not exists(select 1 from rooted.effective_checkins f where f.participant_id=pid and f.attended and f.id<>cid) then
   insert into rooted.first_visits(participant_id,event_id,inviter_id,checkin_id) values(pid,eid,null,cid) on conflict do nothing;
  end if;
  if chapters>prior then
   insert into rooted.reading_totals(participant_id,week,chapters) values(pid,ev.reading_week,chapters)
    on conflict on constraint reading_totals_pkey do update set chapters=excluded.chapters;
   perform rooted.award(pid,eid,cid,'reading',chapters-prior,'reading:'||cid,'Cumulative weekly chapters: '||prior||' to '||chapters||'; fixed 1 point/chapter',actor,null);
  end if;
 end if;
 return rooted.finish(p_request_id,actor,'leader','checkin.missed',p_payload,
  jsonb_build_object('duplicate',false,'receipt',rooted.receipt(cid)));
end $$;
revoke all on function public.rooted_record_missed_attendance(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.rooted_record_missed_attendance(uuid,jsonb) to authenticated;
commit;
