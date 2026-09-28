-- Attendance-gated chapters. Forward-only definitions; no historical DML/backfill.
-- Existing immutable rows/receipts are retained. Explicit corrections reconcile only
-- the affected participants' week; see docs/attendance-gating-backend.md.
begin;
-- NOT VALID retains legacy evidence while enforcing the rule for future rows.
alter table rooted.checkins add constraint checkins_attendance_chapters
  check(attended or (not bible and chapters=0)) not valid;
alter table rooted.checkin_revisions add constraint revisions_attendance_chapters
  check(attended or (not bible and chapters=0)) not valid;
create or replace function public.rooted_correct_checkin(p_request_id uuid,p_checkin_id uuid,p_expected_revision uuid,p_participant_id uuid,p_attended boolean,p_bible boolean,p_chapters integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; payload jsonb; replay jsonb; c rooted.effective_checkins%rowtype;
 rev uuid:=gen_random_uuid(); week date; pid uuid; k text; target integer; credited bigint; delta integer;
 ar integer; br integer; before_state jsonb; after_state jsonb; deltas jsonb:='[]';
begin
 perform rooted.lock_app(); actor:=rooted.require_leader();
 payload:=jsonb_build_object('checkin_id',p_checkin_id,'expected_revision',p_expected_revision,'participant_id',p_participant_id,'attended',p_attended,'bible',p_bible,'chapters',p_chapters);
 replay:=rooted.replay(p_request_id,actor,'leader','checkin.correct',payload);
 if replay is not null then return replay; end if;
 if p_checkin_id is null or p_participant_id is null or p_attended is null or p_bible is null or p_chapters is null or p_chapters not between 0 and 100000 or (not p_attended and (p_bible or p_chapters<>0)) then
 raise exception using errcode='22023',message='Valid person, attendance, Bible and chapters (0..100000) required; Bible and chapters require attendance'; end if;
 select x.* into c from rooted.effective_checkins x where x.id=p_checkin_id;
 if not found then raise exception using errcode='22023',message='Check-in not found'; end if;
 if c.revision_id is distinct from p_expected_revision then raise exception using errcode='40001',message='Check-in changed; refresh and confirm again'; end if;
 if not exists(select 1 from rooted.participants where id=p_participant_id) then raise exception using errcode='22023',message='Participant not found'; end if;
 if exists(select 1 from rooted.effective_checkins x where x.id<>c.id and x.event_id=c.event_id and x.participant_id=p_participant_id) then
 raise exception using errcode='23505',message='Destination person already has a check-in for this event; edit that record or choose another person'; end if;
 if (c.participant_id<>p_participant_id or c.attended<>p_attended) and
 exists(select 1 from rooted.friend_claims f where f.participant_id in (c.participant_id,p_participant_id)) then
 raise exception using errcode='55000',message='Referral conflict: administrator must reconcile the first-visit/referral claim before changing person or attendance; no changes saved'; end if;
 select reading_week into week from rooted.events where id=c.event_id;
 -- Preserve original awarded rates; if a component was never awarded use current rate on first enable.
 select coalesce((select l.points from rooted.ledger l where l.checkin_id=c.id and l.kind in ('attendance','attendance_correction') and l.points>=0 order by l.created_at,l.id limit 1),(select v.attendance_rate from rooted.checkin_revisions v where v.checkin_id=c.id and v.attendance_rate is not null order by v.sequence limit 1),r.attendance),
 coalesce((select l.points from rooted.ledger l where l.checkin_id=c.id and l.kind in ('bible','bible_correction') and l.points>=0 order by l.created_at,l.id limit 1),(select v.bible_rate from rooted.checkin_revisions v where v.checkin_id=c.id and v.bible_rate is not null order by v.sequence limit 1),r.bible)
 into ar,br from rooted.rates r where r.id;
 before_state:=jsonb_build_object('participant_id',c.participant_id,'attended',c.attended,'bible',c.bible,'chapters',c.chapters);
 after_state:=jsonb_build_object('participant_id',p_participant_id,'attended',p_attended,'bible',p_bible,'chapters',p_chapters);
 insert into rooted.checkin_revisions(id,request_id,checkin_id,previous_revision_id,participant_id,attended,bible,chapters,before_state,actor_id,attendance_rate,bible_rate)
 values(rev,p_request_id,c.id,c.revision_id,p_participant_id,p_attended,p_bible,p_chapters,before_state,actor,case when p_attended then ar end,case when p_bible then br end);
 for pid in select distinct x from unnest(array[c.participant_id,p_participant_id]) x loop
  foreach k in array array['attendance','bible','reading'] loop
   if k='reading' then
    select coalesce(max(x.chapters),0) into target from rooted.effective_checkins x join rooted.events e on e.id=x.event_id where x.participant_id=pid and x.attended and e.reading_week=week;
    select coalesce(sum(l.points),0) into credited from rooted.ledger l join rooted.events e on e.id=l.event_id where l.participant_id=pid and e.reading_week=week and l.kind in ('reading','reading_correction');
    insert into rooted.reading_totals(participant_id,week,chapters) values(pid,week,target) on conflict on constraint reading_totals_pkey do update set chapters=excluded.chapters;
   else
    target:=case when pid=p_participant_id then case when k='attendance' and p_attended then ar when k='bible' and p_bible then br else 0 end else 0 end;
    select coalesce(sum(l.points),0) into credited from rooted.ledger l where l.participant_id=pid and l.checkin_id=c.id and l.kind in (k,k||'_correction');
   end if;
   delta:=target-credited;
   if delta<>0 then
    insert into rooted.ledger(participant_id,event_id,checkin_id,kind,points,source,reason,actor_id)
    values(pid,c.event_id,c.id,k||'_correction',delta,'checkin.correct:'||p_request_id||':'||pid||':'||k,'Full check-in correction; authoritative net reconciliation',actor);
    deltas:=deltas||jsonb_build_array(jsonb_build_object('participant_id',pid,'kind',k||'_correction','points',delta));
   end if;
  end loop;
 end loop;
 return rooted.finish(p_request_id,actor,'leader','checkin.correct',payload,jsonb_build_object('revision_id',rev,'correction_id',rev,'checkin_id',c.id,'participant_id',p_participant_id,'event_id',c.event_id,'attended',p_attended,'bible',p_bible,'chapters',p_chapters,'previous_revision_id',c.revision_id,'before',before_state,'after',after_state,'ledger_deltas',deltas));
end $$;
revoke all on function public.rooted_correct_checkin(uuid,uuid,uuid,uuid,boolean,boolean,integer) from public,anon,authenticated,service_role;
grant execute on function public.rooted_correct_checkin(uuid,uuid,uuid,uuid,boolean,boolean,integer) to authenticated;
create or replace function rooted.checkin(p jsonb,actor uuid,device uuid) returns jsonb language plpgsql set search_path='' as $$
declare
  pid uuid := rooted.uid(p,'participant_id'); eid uuid := rooted.uid(p,'event_id');
  attending boolean := rooted.flag(p,'attended'); bible boolean := rooted.flag(p,'bible');
  chapters integer := rooted.num(p,'chapters',0,100000); inviter uuid;
  person rooted.participants%rowtype; ev rooted.events%rowtype; old rooted.effective_checkins%rowtype;
  config rooted.rates%rowtype; cid uuid; prior integer;
begin
  perform rooted.keys(p,array['participant_id','event_id','attended','bible','chapters'],array['inviter_id']);
  if p ? 'inviter_id' and p->'inviter_id'<>'null'::jsonb then inviter:=rooted.uid(p,'inviter_id'); end if;
  if inviter=pid or (not attending and (bible or chapters<>0)) then raise exception using errcode='22023',message='Invalid attendance/Bible/chapters/inviter combination; absent requires Bible false and chapters zero'; end if;
  select x.* into person from rooted.participants x where x.id=pid;
  if not found then raise exception using errcode='22023',message='Participant not found'; end if;
  if inviter is not null and not exists(select 1 from rooted.participants x where x.id=inviter) then raise exception using errcode='22023',message='Inviter not found'; end if;
  select c.* into old from rooted.effective_checkins c where c.participant_id=pid and c.event_id=eid;
  if device is not null and ((old.id is not null and not old.attended) or
      (old.id is null and not person.previously_attended and not exists(select 1 from rooted.effective_first_visits f where f.participant_id=pid))) then
    raise exception using errcode='42501',message='First-time visitor or absent check-in correction needs a leader';
  end if;
  if old.id is not null then
    if row(old.attended,old.bible,(select x.chapters from rooted.effective_checkins x where x.id=old.id),old.inviter_id) is distinct from row(attending,bible,chapters,inviter) then
      raise exception using errcode='23505',message='Check-in is locked; use Edit check-in';
    end if;
    return jsonb_build_object('duplicate',true,'receipt',rooted.receipt(old.id));
  end if;
  ev:=rooted.require_open(eid);
  -- Do not silently revoke historical credit during an unrelated new check-in.
  -- A leader must explicitly correct the historical record first.
  if coalesce((select t.chapters from rooted.reading_totals t where t.participant_id=pid and t.week=ev.reading_week),0)
     <> (select coalesce(max(x.chapters),0) from rooted.effective_checkins x join rooted.events e on e.id=x.event_id
         where x.participant_id=pid and x.attended and e.reading_week=ev.reading_week) then
    raise exception using errcode='55000',message='Historical weekly reading credit needs explicit check-in reconciliation before a new check-in; no changes saved';
  end if;
  select x.* into config from rooted.rates x where x.id;
  insert into rooted.checkins(participant_id,event_id,attended,bible,chapters,inviter_id,actor_id,device_id)
    values(pid,eid,attending,bible,chapters,inviter,actor,device) returning id into cid;
  if attending then
    perform rooted.award(pid,eid,cid,'attendance',config.attendance,'attendance:'||cid,'Attended',actor,device);
    if bible then perform rooted.award(pid,eid,cid,'bible',config.bible,'bible:'||cid,'Brought Bible',actor,device); end if;
    if not exists(select 1 from rooted.effective_checkins f where f.participant_id=pid and f.attended and f.id<>cid) then
      insert into rooted.first_visits(participant_id,event_id,inviter_id,checkin_id) values(pid,eid,inviter,cid) on conflict do nothing;
      if inviter is not null and not person.previously_attended then
        perform rooted.friend_award(jsonb_build_object('participant_id',pid,'event_id',eid,'inviter_id',inviter),actor);
      end if;
    end if;
  end if;
  select x.chapters into prior from rooted.reading_totals x where x.participant_id=pid and x.week=ev.reading_week;
  prior:=coalesce(prior,0);
  if attending and chapters>prior then
    insert into rooted.reading_totals(participant_id,week,chapters) values(pid,ev.reading_week,chapters)
      on conflict on constraint reading_totals_pkey do update set chapters=excluded.chapters;
    perform rooted.award(pid,eid,cid,'reading',chapters-prior,'reading:'||cid,'Cumulative weekly chapters: '||prior||' to '||chapters||'; fixed 1 point/chapter',actor,device);
  end if;
  return jsonb_build_object('duplicate',false,'receipt',rooted.receipt(cid));
end;
$$;

-- CREATE OR REPLACE preserves existing ACLs; repeat the private helper boundary.
revoke all on function rooted.checkin(jsonb,uuid,uuid) from public,anon,authenticated,service_role;
commit;
