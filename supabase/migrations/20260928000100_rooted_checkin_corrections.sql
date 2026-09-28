-- Full immutable revisions; all authority remains private. Forward only.
begin;
alter table rooted.checkins drop constraint checkins_participant_id_event_id_key;
alter table rooted.ledger drop constraint ledger_kind_check;
alter table rooted.ledger add constraint ledger_kind_check check(kind in ('attendance','bible','friend','reading','adjustment','reading_correction','attendance_correction','bible_correction'));
alter table rooted.ledger drop constraint ledger_check;
alter table rooted.ledger add constraint ledger_check check(kind in ('adjustment','reading_correction','attendance_correction','bible_correction') or points>=0);
alter table rooted.ledger add constraint checkin_correction_actor check(kind not in ('attendance_correction','bible_correction') or (actor_id is not null and device_id is null and checkin_id is not null and points<>0));
create table rooted.checkin_revisions (
 id uuid primary key default gen_random_uuid(), sequence bigint generated always as identity unique,
 request_id uuid not null unique references rooted.requests(id) deferrable initially deferred,
 checkin_id uuid not null references rooted.checkins(id), previous_revision_id uuid,
 participant_id uuid not null references rooted.participants(id), attended boolean not null, bible boolean not null,
 chapters integer not null check(chapters between 0 and 100000),
 before_state jsonb not null, actor_id uuid not null references rooted.leaders(user_id),
 attendance_rate integer check(attendance_rate between 0 and 1000), bible_rate integer check(bible_rate between 0 and 1000),
 created_at timestamptz not null default clock_timestamp(), check(not bible or attended)
);
create index checkin_revisions_latest on rooted.checkin_revisions(checkin_id,sequence desc);
alter table rooted.checkin_revisions enable row level security;
revoke all on rooted.checkin_revisions from public,anon,authenticated,service_role;
revoke all on sequence rooted.checkin_revisions_sequence_seq from public,anon,authenticated,service_role;
create trigger immutable_rows before update or delete on rooted.checkin_revisions for each row execute function rooted.immutable();
create trigger immutable_truncate before truncate on rooted.checkin_revisions for each statement execute function rooted.immutable();
create or replace view rooted.effective_checkins as
 select c.id,coalesce(r.participant_id,c.participant_id) participant_id,c.event_id,
 coalesce(r.attended,c.attended) attended,coalesce(r.bible,c.bible) bible,
 coalesce(r.chapters,h.after_chapters,c.chapters) chapters,case when coalesce(r.participant_id,c.participant_id)=c.participant_id then c.inviter_id end inviter_id,c.actor_id,c.device_id,c.created_at,
 c.chapters original_chapters,coalesce(r.id,h.id) correction_id,coalesce(r.id,h.id) revision_id,
 c.participant_id original_participant_id,c.attended original_attended,c.bible original_bible
 from rooted.checkins c
 left join lateral(select x.* from rooted.checkin_revisions x where x.checkin_id=c.id order by sequence desc limit 1) r on true
 left join lateral(select x.* from rooted.chapter_corrections x where x.checkin_id=c.id order by sequence desc limit 1) h on true;
-- First attendance is a projection; immutable original first_visits remains evidence.
create view rooted.effective_first_visits as
 select distinct on (c.participant_id) c.participant_id,c.event_id,c.inviter_id,c.id checkin_id
 from rooted.effective_checkins c where c.attended order by c.participant_id,c.created_at,c.id;
revoke all on rooted.effective_first_visits from public,anon,authenticated,service_role;

create function public.rooted_correct_checkin(p_request_id uuid,p_checkin_id uuid,p_expected_revision uuid,p_participant_id uuid,p_attended boolean,p_bible boolean,p_chapters integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; payload jsonb; replay jsonb; c rooted.effective_checkins%rowtype;
 rev uuid:=gen_random_uuid(); week date; pid uuid; k text; target integer; credited bigint; delta integer;
 ar integer; br integer; before_state jsonb; after_state jsonb; deltas jsonb:='[]';
begin
 perform rooted.lock_app(); actor:=rooted.require_leader();
 payload:=jsonb_build_object('checkin_id',p_checkin_id,'expected_revision',p_expected_revision,'participant_id',p_participant_id,'attended',p_attended,'bible',p_bible,'chapters',p_chapters);
 replay:=rooted.replay(p_request_id,actor,'leader','checkin.correct',payload);
 if replay is not null then return replay; end if;
 if p_checkin_id is null or p_participant_id is null or p_attended is null or p_bible is null or p_chapters is null or p_chapters not between 0 and 100000 or (p_bible and not p_attended) then
 raise exception using errcode='22023',message='Valid person, attendance, Bible and chapters (0..100000) required; Bible requires attendance'; end if;
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
    select coalesce(max(x.chapters),0) into target from rooted.effective_checkins x join rooted.events e on e.id=x.event_id where x.participant_id=pid and e.reading_week=week;
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
-- Old API lacks a revision token and cannot safely express a full-record CAS.
create or replace function public.rooted_correct_chapters(p_request_id uuid,p_checkin_id uuid,p_expected_chapters integer,p_new_chapters integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; replay jsonb;
begin
 perform rooted.lock_app(); actor:=rooted.require_leader();
 replay:=rooted.replay(p_request_id,actor,'leader','chapters.correct',jsonb_build_object('checkin_id',p_checkin_id,'expected_chapters',p_expected_chapters,'new_chapters',p_new_chapters));
 if replay is not null then return replay; end if;
 raise exception using errcode='55000',message='Use Edit check-in (rooted_correct_checkin) with the current revision; legacy chapter edits are disabled';
end $$;
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
  if inviter=pid or (bible and not attending) then raise exception using errcode='22023',message='Invalid attendance/Bible/inviter combination'; end if;
  select x.* into person from rooted.participants x where x.id=pid;
  if not found then raise exception using errcode='22023',message='Participant not found'; end if;
  if inviter is not null and not exists(select 1 from rooted.participants x where x.id=inviter) then raise exception using errcode='22023',message='Inviter not found'; end if;
  select c.* into old from rooted.effective_checkins c where c.participant_id=pid and c.event_id=eid;
  if device is not null and ((old.id is not null and not old.attended) or
      (old.id is null and not person.previously_attended and not exists(select 1 from rooted.effective_first_visits f where f.participant_id=pid))) then
    raise exception using errcode='42501',message='First-time visitor or reading-only correction needs a leader';
  end if;
  if old.id is not null then
    if row(old.attended,old.bible,(select x.chapters from rooted.effective_checkins x where x.id=old.id),old.inviter_id) is distinct from row(attending,bible,chapters,inviter) then
      raise exception using errcode='23505',message='Check-in is locked; use Edit check-in';
    end if;
    return jsonb_build_object('duplicate',true,'receipt',rooted.receipt(old.id));
  end if;
  ev:=rooted.require_open(eid);
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
  if chapters>prior then
    insert into rooted.reading_totals(participant_id,week,chapters) values(pid,ev.reading_week,chapters)
      on conflict on constraint reading_totals_pkey do update set chapters=excluded.chapters;
    perform rooted.award(pid,eid,cid,'reading',chapters-prior,'reading:'||cid,'Cumulative weekly chapters: '||prior||' to '||chapters||'; fixed 1 point/chapter',actor,device);
  end if;
  return jsonb_build_object('duplicate',false,'receipt',rooted.receipt(cid));
end;
$$;

create or replace function rooted.draw(r uuid,p jsonb,actor uuid) returns jsonb language plpgsql set search_path='' as $$
declare
  eid uuid := rooted.uid(p,'event_id'); prize text := rooted.txt(p,'prize',120);
  present boolean := rooted.flag(p,'present_only'); one_win boolean := rooted.flag(p,'one_win');
  ev rooted.events%rowtype; pool jsonb; total bigint; ticket bigint; cumulative bigint:=0;
  item jsonb; winner jsonb; saved rooted.draws%rowtype;
begin
  perform rooted.keys(p,array['event_id','prize','present_only','one_win']);
  ev:=rooted.require_open(eid);
  select jsonb_agg(jsonb_build_object('participant_id',q.id,'name',q.name,'weight',q.weight) order by q.id),sum(q.weight)::bigint
    into pool,total
  from (
    select person.id,person.name,sum(l.points)::bigint as weight
    from rooted.participants person join rooted.ledger l on l.participant_id=person.id
    where (not present or exists(select 1 from rooted.effective_checkins c where c.event_id=eid and c.participant_id=person.id and c.attended))
      and (not one_win or not exists(select 1 from rooted.draws d where d.event_id=eid and d.winner_id=person.id))
    group by person.id,person.name having sum(l.points)>0
  ) q;
  if total is null or total<=0 then raise exception using errcode='22023',message='No eligible positive-point entries'; end if;
  ticket:=rooted.randbelow(total);
  for item in select value from jsonb_array_elements(pool) loop
    cumulative:=cumulative+(item->>'weight')::bigint;
    if ticket<cumulative then winner:=item; exit; end if;
  end loop;
  insert into rooted.draws(request_id,event_id,prize,present_only,one_win,winner_id,winner_name,weights,total_weight,ticket,actor_id)
    values(r,eid,prize,present,one_win,(winner->>'participant_id')::uuid,winner->>'name',pool,total,ticket,actor) returning * into saved;
  return to_jsonb(saved);
end;
$$;

create or replace function public.rooted_kiosk(p_token text,p_action text,p_payload jsonb default '{}'::jsonb,p_request_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  device rooted.devices%rowtype; ev rooted.events%rowtype; result jsonb; replay jsonb;
  q text; matches jsonb; pid uuid; person rooted.participants%rowtype;
  old rooted.effective_checkins%rowtype; prior integer; needs_leader boolean;
begin
  perform rooted.lock_app(); device:=rooted.require_device(p_token);
  if p_action is null then raise exception using errcode='22023',message='Kiosk action required'; end if;
  case p_action
  when 'context' then
    perform rooted.keys(p_payload,'{}'::text[]); ev:=rooted.require_open(device.event_id);
    select jsonb_build_object('event',jsonb_build_object('id',ev.id,'name',ev.name,'date',ev.date,'reading_week',ev.reading_week),'rates',to_jsonb(x)-'id') into result from rooted.rates x where x.id;
  when 'search' then
    perform rooted.keys(p_payload,array['query']); q:=rooted.txt(p_payload,'query',80,true);
    if length(q)<2 then return jsonb_build_object('matches','[]'::jsonb,'truncated',false); end if;
    -- strpos is literal: %, _, and backslash never expand into wildcards.
    select coalesce(jsonb_agg(to_jsonb(x) order by lower(x.name),x.id),'[]'::jsonb) into matches
      from (select p.id,p.name from rooted.participants p where strpos(lower(p.name),lower(q))>0 order by lower(p.name),p.id limit 9) x;
    select coalesce(jsonb_agg(x.value order by x.ordinality),'[]'::jsonb) into result from jsonb_array_elements(matches) with ordinality x where x.ordinality<=8;
    result:=jsonb_build_object('matches',result,'truncated',jsonb_array_length(matches)>8);
  when 'person' then
    perform rooted.keys(p_payload,array['participant_id']); pid:=rooted.uid(p_payload,'participant_id');
    select p.* into person from rooted.participants p where p.id=pid;
    if not found then raise exception using errcode='22023',message='Participant not found'; end if;
    select c.* into old from rooted.effective_checkins c where c.event_id=device.event_id and c.participant_id=pid;
    needs_leader:=case when old.id is not null then not old.attended else not person.previously_attended and not exists(select 1 from rooted.effective_first_visits f where f.participant_id=pid) end;
    select t.chapters into prior from rooted.reading_totals t join rooted.events e on e.reading_week=t.week where e.id=device.event_id and t.participant_id=pid;
    result:=jsonb_build_object('person',jsonb_build_object('id',pid,'name',person.name),'already_checked_in',coalesce(old.attended,false),'needs_leader',needs_leader,'prior_chapters',coalesce(prior,0),'receipt',case when old.id is not null then rooted.receipt(old.id) end);
  when 'checkin' then
    perform rooted.keys(p_payload,array['participant_id','bible','chapters']);
    replay:=rooted.replay(p_request_id,device.id,'device','kiosk.checkin',p_payload);
    if replay is not null then return replay; end if;
    result:=rooted.checkin(p_payload||jsonb_build_object('event_id',device.event_id,'attended',true),null,device.id);
    return rooted.finish(p_request_id,device.id,'device','kiosk.checkin',p_payload,result);
  else raise exception using errcode='22023',message='Unknown kiosk action';
  end case;
  return result;
end;
$$;

create or replace function rooted.friend_award(p jsonb,actor uuid) returns jsonb language plpgsql set search_path='' as $$
declare pid uuid; eid uuid; inviter uuid; visit rooted.effective_first_visits%rowtype; old rooted.friend_claims%rowtype; n integer;
begin
  perform rooted.keys(p,array['participant_id','event_id','inviter_id']);
  pid:=rooted.uid(p,'participant_id'); eid:=rooted.uid(p,'event_id'); inviter:=rooted.uid(p,'inviter_id');
  if pid=inviter then raise exception using errcode='22023',message='Self-referral is not allowed'; end if;
  if not exists(select 1 from rooted.participants x where x.id=pid and not x.previously_attended) then
    raise exception using errcode='22023',message='First-time guest required';
  end if;
  select f.* into visit from rooted.effective_first_visits f where f.participant_id=pid and f.event_id=eid;
  if not found then raise exception using errcode='22023',message='Recorded first attendance in this event required'; end if;
  if not exists(select 1 from rooted.first_visits h where h.participant_id=pid and h.checkin_id=visit.checkin_id) then raise exception using errcode='55000',message='Referral conflict: corrected first visit requires administrator reconciliation; no referral awarded'; end if;
  select f.* into old from rooted.friend_claims f where f.participant_id=pid;
  if found then
    if old.inviter_id<>inviter then raise exception using errcode='23505',message='Referral already claimed by another inviter'; end if;
    return jsonb_build_object('participant_id',pid,'event_id',eid,'inviter_id',inviter,'points',old.points,'duplicate',true);
  end if;
  select r.friend into n from rooted.rates r where r.id;
  insert into rooted.friend_claims(participant_id,event_id,inviter_id,checkin_id,actor_id,points) values(pid,eid,inviter,visit.checkin_id,actor,n);
  perform rooted.award(inviter,eid,visit.checkin_id,'friend',n,'friend:'||pid,'First attended visit referral',actor,null);
  return jsonb_build_object('participant_id',pid,'event_id',eid,'inviter_id',inviter,'points',n,'duplicate',false);
end;
$$;

create or replace function public.rooted_display(p_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d rooted.devices%rowtype; result jsonb;
begin
  -- Match mutation lock order, so closure/revocation cannot race this read.
  perform rooted.lock_app();
  d:=rooted.require_device(p_token);
  -- Display requires PIN-backed station authority, not legacy leader-issued kiosks.
  if d.station_id is null then
    raise exception using errcode='42501',message='Station PIN unlock required';
  end if;
  if (select count(*) from rooted.participants)>2000 then
    raise exception using errcode='54000',message='Display roster exceeds safe bound';
  end if;
  select jsonb_build_object(
    'event',jsonb_build_object('id',e.id,'name',e.name,'date',e.date),
    'attendance_count',(select count(*) from rooted.effective_checkins c where c.event_id=d.event_id and c.attended),
    'participants',coalesce((select jsonb_agg(jsonb_build_object(
      'id',p.id,'name',p.name,'points',coalesce(l.points,0),
      'present',exists(select 1 from rooted.effective_checkins c where c.event_id=d.event_id and c.participant_id=p.id and c.attended)
    ) order by coalesce(l.points,0) desc,p.name,p.id)
      from rooted.participants p left join
        (select participant_id,sum(points)::bigint as points from rooted.ledger group by participant_id) l
        on l.participant_id=p.id),'[]'::jsonb),
    'updated_at',clock_timestamp()) into result
  from rooted.events e where e.id=d.event_id;
  return result;
end $$;

create or replace function public.rooted_leader_state(p_collection text,p_limit integer default 100,p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; rows jsonb;
begin
 perform rooted.lock_app(); actor:=rooted.require_leader();
 if p_limit is null or p_limit not between 1 and 500 or p_offset is null or p_offset not between 0 and 1000000 then
 raise exception using errcode='22023',message='Invalid pagination'; end if;
 if p_collection='checkins' then
 select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into rows from (select x.* from rooted.effective_checkins x order by x.id limit p_limit offset p_offset) q;
 elsif p_collection='first_visits' then
 select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into rows from (select x.* from rooted.effective_first_visits x order by x.participant_id limit p_limit offset p_offset) q;
 elsif p_collection='checkin_revisions' then
 select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into rows from (select x.* from rooted.checkin_revisions x order by x.sequence limit p_limit offset p_offset) q;
 elsif p_collection='chapter_corrections' then
 select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into rows from (select x.* from rooted.chapter_corrections x order by x.sequence limit p_limit offset p_offset) q;
 else return rooted.leader_state_before_chapters(p_collection,p_limit,p_offset); end if;
 return jsonb_build_object('actor_id',actor,'collection',p_collection,'rows',rows,'limit',p_limit,'offset',p_offset);
end $$;

create or replace function rooted.receipt(c uuid) returns jsonb language sql set search_path='' as $$
select jsonb_build_object('checkin_id',c,'earned_points',coalesce(sum(x.points),0),'components',coalesce(jsonb_agg(jsonb_build_object('label',case x.kind when 'attendance' then 'Attendance' when 'bible' then 'Brought Bible' else 'Bible reading' end,'points',x.points) order by x.kind),'[]'::jsonb))
from (select replace(l.kind,'_correction','') kind,sum(l.points) points from rooted.ledger l join rooted.effective_checkins e on e.id=c and e.participant_id=l.participant_id where l.checkin_id=c and l.kind in ('attendance','attendance_correction','bible','bible_correction','reading','reading_correction') group by replace(l.kind,'_correction','')) x;
$$;
revoke all on all functions in schema rooted from public,anon,authenticated,service_role;
commit;
