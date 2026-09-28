-- Forward-only chapter corrections; no fixture or hosted record writes.
begin;
alter table rooted.ledger drop constraint ledger_kind_check;
alter table rooted.ledger add constraint ledger_kind_check check(kind in ('attendance','bible','friend','reading','adjustment','reading_correction'));
alter table rooted.ledger drop constraint ledger_check;
alter table rooted.ledger add constraint ledger_check check(kind in ('adjustment','reading_correction') or points>=0);
alter table rooted.ledger add constraint reading_correction_actor check(kind<>'reading_correction' or (actor_id is not null and device_id is null and checkin_id is not null and points<>0));
create table rooted.chapter_corrections (
 id uuid primary key default gen_random_uuid(),
 sequence bigint generated always as identity unique,
 request_id uuid not null unique references rooted.requests(id) deferrable initially deferred,
 checkin_id uuid not null references rooted.checkins(id),
 previous_correction_id uuid references rooted.chapter_corrections(id),
 before_chapters integer not null check(before_chapters between 0 and 100000),
 after_chapters integer not null check(after_chapters between 0 and 100000),
 weekly_before_chapters integer not null check(weekly_before_chapters between 0 and 100000),
 weekly_after_chapters integer not null check(weekly_after_chapters between 0 and 100000),
 delta_points integer not null check(delta_points between -100000 and 100000),
 ledger_id uuid unique references rooted.ledger(id),
 actor_id uuid not null references rooted.leaders(user_id),
 reason text not null,
 created_at timestamptz not null default clock_timestamp(),
 check((delta_points=0)=(ledger_id is null))
);
create index chapter_corrections_checkin_idx on rooted.chapter_corrections(checkin_id,sequence desc);
alter table rooted.chapter_corrections enable row level security;
revoke all on rooted.chapter_corrections from public,anon,authenticated,service_role;
revoke all on sequence rooted.chapter_corrections_sequence_seq from public,anon,authenticated,service_role;
create trigger immutable_rows before update or delete on rooted.chapter_corrections for each row execute function rooted.immutable();
create trigger immutable_truncate before truncate on rooted.chapter_corrections for each statement execute function rooted.immutable();
create view rooted.effective_checkins as
 select c.id,c.participant_id,c.event_id,c.attended,c.bible,
 coalesce(x.after_chapters,c.chapters) as chapters,c.inviter_id,c.actor_id,c.device_id,c.created_at,
 c.chapters as original_chapters,x.id as correction_id
 from rooted.checkins c left join lateral (
 select h.id,h.after_chapters from rooted.chapter_corrections h where h.checkin_id=c.id order by h.sequence desc limit 1
 ) x on true;
revoke all on rooted.effective_checkins from public,anon,authenticated,service_role;

create function public.rooted_correct_chapters(p_request_id uuid,p_checkin_id uuid,p_expected_chapters integer,p_new_chapters integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; payload jsonb; replay jsonb; c rooted.effective_checkins%rowtype;
 week date; before_week integer; after_week integer; credited bigint; delta integer;
 correction uuid:=gen_random_uuid(); ledger uuid; reason text; result jsonb;
begin
 perform rooted.lock_app(); actor:=rooted.require_leader();
 payload:=jsonb_build_object('checkin_id',p_checkin_id,'expected_chapters',p_expected_chapters,'new_chapters',p_new_chapters);
 replay:=rooted.replay(p_request_id,actor,'leader','chapters.correct',payload);
 if replay is not null then return replay; end if;
 if p_checkin_id is null or p_expected_chapters is null or p_expected_chapters not between 0 and 100000
 or p_new_chapters is null or p_new_chapters not between 0 and 100000 then
 raise exception using errcode='22023',message='Valid check-in and chapter counts required'; end if;
 select x.* into c from rooted.effective_checkins x where x.id=p_checkin_id;
 if not found then raise exception using errcode='22023',message='Check-in not found'; end if;
 if c.chapters<>p_expected_chapters then raise exception using errcode='40001',message='Chapter count changed; refresh and confirm again'; end if;
 select e.reading_week into week from rooted.events e where e.id=c.event_id;
 select coalesce(max(x.chapters),0),coalesce(max(case when x.id=c.id then p_new_chapters else x.chapters end),0)
 into before_week,after_week from rooted.effective_checkins x join rooted.events e on e.id=x.event_id
 where x.participant_id=c.participant_id and e.reading_week=week;
 -- Actual chapter-only net, never gross historic awards or manual adjustments.
 select coalesce(sum(l.points),0) into credited from rooted.ledger l join rooted.events e on e.id=l.event_id
 where l.participant_id=c.participant_id and e.reading_week=week and l.kind in ('reading','reading_correction');
 if credited not between 0 and 100000 then raise exception using errcode='22023',message='Chapter ledger requires reconciliation'; end if;
 delta:=after_week-credited;
 reason:='Chapter correction: '||c.chapters||' to '||p_new_chapters||'; weekly maximum '||before_week||' to '||after_week||'; fixed 1 point/chapter';
 if delta<>0 then
 insert into rooted.ledger(participant_id,event_id,checkin_id,kind,points,source,reason,actor_id)
 values(c.participant_id,c.event_id,c.id,'reading_correction',delta,'chapters.correct:'||p_request_id,reason,actor) returning id into ledger;
 end if;
 insert into rooted.chapter_corrections(id,request_id,checkin_id,previous_correction_id,before_chapters,after_chapters,weekly_before_chapters,weekly_after_chapters,delta_points,ledger_id,actor_id,reason)
 values(correction,p_request_id,c.id,c.correction_id,c.chapters,p_new_chapters,before_week,after_week,delta,ledger,actor,reason);
 -- Existing check-in and kiosk paths consume this authoritative corrected maximum.
 insert into rooted.reading_totals(participant_id,week,chapters) values(c.participant_id,week,after_week)
 on conflict on constraint reading_totals_pkey do update set chapters=excluded.chapters;
 result:=jsonb_build_object('correction_id',correction,'checkin_id',c.id,'participant_id',c.participant_id,'event_id',c.event_id,'reading_week',week,
 'before_chapters',c.chapters,'after_chapters',p_new_chapters,'weekly_before_chapters',before_week,'weekly_after_chapters',after_week,
 'delta_points',delta,'ledger_id',ledger,'actor_id',actor,'reason',reason);
 return rooted.finish(p_request_id,actor,'leader','chapters.correct',payload,result);
end $$;
revoke all on function public.rooted_correct_chapters(uuid,uuid,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.rooted_correct_chapters(uuid,uuid,integer,integer) to authenticated;

create or replace function rooted.receipt(c uuid) returns jsonb language sql set search_path='' as $$
 select jsonb_build_object('checkin_id',c,'earned_points',coalesce(sum(x.points),0),
 'components',coalesce(jsonb_agg(jsonb_build_object('label',case x.kind when 'attendance' then 'Attendance' when 'bible' then 'Brought Bible' when 'reading_correction' then 'Bible reading correction' else 'Bible reading' end,'points',x.points) order by x.kind),'[]'::jsonb))
 from (select l.kind,sum(l.points) as points from rooted.ledger l where l.checkin_id=c and l.kind in ('attendance','bible','reading','reading_correction') group by l.kind) x;
$$;
-- Public projection wrapper preserves all existing collection ACL/pagination.
alter function public.rooted_leader_state(text,integer,integer) set schema rooted;
alter function rooted.rooted_leader_state(text,integer,integer) rename to leader_state_before_chapters;
revoke all on function rooted.leader_state_before_chapters(text,integer,integer) from public,anon,authenticated,service_role;
create function public.rooted_leader_state(p_collection text,p_limit integer default 100,p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; rows jsonb;
begin
 perform rooted.lock_app(); actor:=rooted.require_leader();
 if p_limit is null or p_limit not between 1 and 500 or p_offset is null or p_offset not between 0 and 1000000 then
 raise exception using errcode='22023',message='Invalid pagination'; end if;
 if p_collection='checkins' then
 select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into rows from (select x.* from rooted.effective_checkins x order by x.id limit p_limit offset p_offset) q;
 elsif p_collection='chapter_corrections' then
 select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into rows from (select x.* from rooted.chapter_corrections x order by x.sequence limit p_limit offset p_offset) q;
 else return rooted.leader_state_before_chapters(p_collection,p_limit,p_offset); end if;
 return jsonb_build_object('actor_id',actor,'collection',p_collection,'rows',rows,'limit',p_limit,'offset',p_offset);
end $$;
revoke all on function public.rooted_leader_state(text,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.rooted_leader_state(text,integer,integer) to authenticated;

-- Fresh duplicate commands compare effective chapters; exact request replay remains immutable.
create or replace function rooted.checkin(p jsonb,actor uuid,device uuid) returns jsonb language plpgsql set search_path='' as $$
declare
  pid uuid := rooted.uid(p,'participant_id'); eid uuid := rooted.uid(p,'event_id');
  attending boolean := rooted.flag(p,'attended'); bible boolean := rooted.flag(p,'bible');
  chapters integer := rooted.num(p,'chapters',0,100000); inviter uuid;
  person rooted.participants%rowtype; ev rooted.events%rowtype; old rooted.checkins%rowtype;
  config rooted.rates%rowtype; cid uuid; prior integer;
begin
  perform rooted.keys(p,array['participant_id','event_id','attended','bible','chapters'],array['inviter_id']);
  if p ? 'inviter_id' and p->'inviter_id'<>'null'::jsonb then inviter:=rooted.uid(p,'inviter_id'); end if;
  if inviter=pid or (bible and not attending) then raise exception using errcode='22023',message='Invalid attendance/Bible/inviter combination'; end if;
  select x.* into person from rooted.participants x where x.id=pid;
  if not found then raise exception using errcode='22023',message='Participant not found'; end if;
  if inviter is not null and not exists(select 1 from rooted.participants x where x.id=inviter) then raise exception using errcode='22023',message='Inviter not found'; end if;
  select c.* into old from rooted.checkins c where c.participant_id=pid and c.event_id=eid;
  if device is not null and ((old.id is not null and not old.attended) or
      (old.id is null and not person.previously_attended and not exists(select 1 from rooted.first_visits f where f.participant_id=pid))) then
    raise exception using errcode='42501',message='First-time visitor or reading-only correction needs a leader';
  end if;
  if old.id is not null then
    if row(old.attended,old.bible,(select x.chapters from rooted.effective_checkins x where x.id=old.id),old.inviter_id) is distinct from row(attending,bible,chapters,inviter) then
      raise exception using errcode='23505',message='Check-in is locked; use a leader chapter correction';
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
    if not exists(select 1 from rooted.first_visits f where f.participant_id=pid) then
      insert into rooted.first_visits(participant_id,event_id,inviter_id,checkin_id) values(pid,eid,inviter,cid);
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
commit;
