-- Schema only: activation and pg_cron installation are explicitly separate.
begin;
-- Fixed server clock; no caller-controlled setting or argument. Tests replace
-- this ungranted function only inside a disposable transaction and roll it back.
create function rooted.gathering_now() returns timestamptz language sql volatile set search_path='' as $$ select clock_timestamp() $$;
revoke all on function rooted.gathering_now() from public,anon,authenticated,service_role;
create table rooted.weekly_schedule (
 season_id uuid primary key references rooted.seasons(id),
 enabled boolean not null default false,
 title text not null default 'Rooted Teens' check(length(btrim(title)) between 1 and 80)
);
create table rooted.weekly_exceptions (
 season_id uuid not null references rooted.weekly_schedule(season_id),
 date date not null,
 reason text not null check(length(btrim(reason)) between 1 and 500),
 primary key(season_id,date)
);
-- Separate attribution lane: never invent a leader actor for background work.
create table rooted.automation_audit (
 id uuid primary key default gen_random_uuid(),
 source text not null default 'system' check(source='system'),
 action text not null,
 details jsonb not null,
 created_at timestamptz not null default rooted.gathering_now()
);
create trigger immutable_rows before update or delete on rooted.automation_audit for each row execute function rooted.immutable();
create trigger immutable_truncate before truncate on rooted.automation_audit for each statement execute function rooted.immutable();
alter table rooted.weekly_schedule enable row level security;
alter table rooted.weekly_exceptions enable row level security;
alter table rooted.automation_audit enable row level security;
revoke all on rooted.weekly_schedule,rooted.weekly_exceptions,rooted.automation_audit from public,anon,authenticated,service_role;
alter table rooted.devices add column system_revoked_at timestamptz;
create index events_season_date_idx on rooted.events(season_id,date);

-- Private recurrence rule: adding seven days crosses a month only on its last Friday.
-- Existing historical rows and their corrections are never deleted or rewritten.
create function rooted.weekly_date_eligible(s uuid,d date) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from rooted.seasons se where se.id=s and d between se.starts_on and se.ends_on)
 and extract(isodow from d)=5 and date_trunc('month',d::timestamp)=date_trunc('month',(d+7)::timestamp)
 and not exists(select 1 from rooted.weekly_exceptions x where x.season_id=s and x.date=d)
$$;
revoke all on function rooted.weekly_date_eligible(uuid,date) from public,anon,authenticated,service_role;
create function rooted.meeting_today(e uuid,at_time timestamptz) returns boolean
language sql stable set search_path='' as $$
 select exists(select 1 from rooted.events ev where ev.id=e and ev.date=(at_time at time zone 'America/New_York')::date
 and (not exists(select 1 from rooted.weekly_schedule c where c.season_id=ev.season_id and c.enabled)
      or rooted.weekly_date_eligible(ev.season_id,ev.date)))
$$;
-- Ungranted time-parameterized core enables deterministic midnight/DST tests.
create function rooted.weekly_maintain_at(at_time timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare today date:=(at_time at time zone 'America/New_York')::date; added integer; closed integer; revoked integer;
begin
 if at_time is null then raise exception 'Maintenance time required'; end if;
 perform rooted.lock_app();
 -- Never update existing dates (including manually closed/cancelled rows).
 insert into rooted.events(season_id,name,date,reading_week,open)
 select s.id,c.title,d.day::date,date_trunc('week',d.day)::date,true
 from rooted.weekly_schedule c join rooted.seasons s on s.id=c.season_id and s.active
 cross join lateral generate_series(greatest(s.starts_on,today)::timestamp,s.ends_on::timestamp,interval '1 day') d(day)
 where c.enabled and rooted.weekly_date_eligible(s.id,d.day::date)
 and not exists(select 1 from rooted.events e where e.season_id=s.id and e.date=d.day::date)
 and not exists(select 1 from rooted.weekly_exceptions x where x.season_id=s.id and x.date=d.day::date);
 get diagnostics added=row_count;
 -- All elapsed events close, even if a season was disabled after its meeting.
 update rooted.events set open=false where open and date<today;
 get diagnostics closed=row_count;
 update rooted.devices d set system_revoked_at=at_time
 where d.system_revoked_at is null and d.revoked_at is null
 and exists(select 1 from rooted.events e where e.id=d.event_id and e.date<today);
 get diagnostics revoked=row_count;
 if added+closed+revoked>0 then
 insert into rooted.automation_audit(action,details) values('weekly.maintenance',jsonb_build_object('at',at_time,'timezone','America/New_York','created',added,'closed',closed,'revoked_sessions',revoked));
 end if;
 return jsonb_build_object('created',added,'closed',closed,'revoked_sessions',revoked);
end $$;
create function rooted.weekly_maintain() returns jsonb language sql security definer set search_path='' as $$
 select rooted.weekly_maintain_at(rooted.gathering_now())
$$;
-- No client can invoke maintenance with a forged clock or change configuration.
revoke all on function rooted.meeting_today(uuid,timestamptz),rooted.weekly_maintain_at(timestamptz),rooted.weekly_maintain() from public,anon,authenticated,service_role;
create or replace function public.rooted_station_unlock(p_station_token text,p_pin text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s rooted.stations%rowtype; actor uuid; token text; d rooted.devices%rowtype; t timestamptz; old_event rooted.events%rowtype; target uuid; candidates integer;
begin
  perform rooted.lock_app(); t:=rooted.gathering_now();
  if p_station_token is null or p_station_token !~ '^[0-9a-f]{64}$' then return '{"ok":false,"error":"invalid_station"}'; end if;
  select x.* into s from rooted.stations x where x.token_hash=extensions.digest(p_station_token,'sha256') and x.revoked_at is null and x.expires_at>t for update;
  if not found then return '{"ok":false,"error":"invalid_station"}'; end if;
  if s.locked_until>t then return jsonb_build_object('ok',false,'error','locked','retry_after_seconds',ceil(extract(epoch from s.locked_until-t))::integer); end if;
  if s.locked_until is not null then
    update rooted.stations set failed_attempts=0,locked_until=null where id=s.id; s.failed_attempts:=0;
  end if;
  if p_pin is not null and p_pin ~ '^[0-9]{6}$' then
    select p.user_id into actor from rooted.checkin_pins p join rooted.leaders l on l.user_id=p.user_id and l.active
      where extensions.crypt(p_pin,p.pin_hash)=p.pin_hash;
  end if;
  if actor is null then
    update rooted.stations set failed_attempts=s.failed_attempts+1,
      locked_until=case when s.failed_attempts+1>=5 then t+interval '15 minutes' end where id=s.id;
    if s.failed_attempts+1>=5 then return '{"ok":false,"error":"locked","retry_after_seconds":900}'; end if;
    return '{"ok":false,"error":"invalid_pin"}';
  end if;
  update rooted.stations set failed_attempts=0,locked_until=null where id=s.id;
  select * into old_event from rooted.events where id=s.event_id;
  if old_event.date < (t at time zone 'America/New_York')::date then
    select count(*),(array_agg(e.id))[1] into candidates,target
    from rooted.events e join rooted.seasons se on se.id=e.season_id and se.active
    join rooted.weekly_schedule c on c.season_id=se.id and c.enabled
    where e.season_id=old_event.season_id and e.date=(t at time zone 'America/New_York')::date and e.open
    and rooted.weekly_date_eligible(e.season_id,e.date)
    and not exists(select 1 from rooted.weekly_exceptions x where x.season_id=e.season_id and x.date=e.date);
    if candidates=0 then return '{"ok":false,"error":"no_current_gathering"}'; end if;
    if candidates<>1 then return '{"ok":false,"error":"ambiguous_current_gathering"}'; end if;
    update rooted.devices set revoked_at=t,revoked_by=actor where station_id=s.id and revoked_at is null;
    update rooted.stations set event_id=target where id=s.id;
    perform rooted.finish(gen_random_uuid(),actor,'leader','station.daily_rollover',jsonb_build_object('station_id',s.id),jsonb_build_object('previous_event_id',s.event_id,'event_id',target));
    s.event_id:=target;
  end if;
  if not rooted.meeting_today(s.event_id,rooted.gathering_now()) or not exists(select 1 from rooted.events e join rooted.seasons se on se.id=e.season_id where e.id=s.event_id and e.open and se.active) then
    return '{"ok":false,"error":"event_closed"}';
  end if;
  token:=encode(extensions.gen_random_bytes(32),'hex');
  -- Capture actual issuance time (not transaction-start now()) for the daily fence.
  t:=rooted.gathering_now();
  insert into rooted.devices(event_id,token_hash,label,issued_by,expires_at,station_id,created_at)
    values(s.event_id,extensions.digest(token,'sha256'),s.label,actor,least(((t at time zone 'America/New_York')::date + 1)::timestamp at time zone 'America/New_York',s.expires_at),s.id,t) returning * into d;
  perform rooted.finish(gen_random_uuid(),d.id,'device','station.unlock','{}',jsonb_build_object('station_id',s.id,'event_id',s.event_id,'expires_at',d.expires_at));
  return jsonb_build_object('ok',true,'device_token',token,'expires_at',d.expires_at,'event_id',d.event_id);
end $$;
create or replace function rooted.require_device(token text) returns rooted.devices language plpgsql set search_path='' as $$
declare d rooted.devices%rowtype;
begin
  if token is null or token !~ '^[0-9a-f]{64}$' then raise exception using errcode='42501',message='Invalid kiosk capability'; end if;
  select x.* into d from rooted.devices x join rooted.leaders l on l.user_id=x.issued_by and l.active
    where x.token_hash=extensions.digest(token,'sha256') and x.revoked_at is null and x.system_revoked_at is null and x.expires_at>rooted.gathering_now() for share of x,l;
  if not found then raise exception using errcode='42501',message='Invalid or expired kiosk capability'; end if;
  if d.station_id is not null then
    -- Defense in depth: even a legacy/manually prolonged session needs today's PIN.
    if (d.created_at at time zone 'America/New_York')::date
       is distinct from (rooted.gathering_now() at time zone 'America/New_York')::date then
      raise exception using errcode='42501',message='Daily station unlock required';
    end if;
    perform 1 from rooted.stations s where s.id=d.station_id and s.event_id=d.event_id and s.revoked_at is null and s.expires_at>rooted.gathering_now() for share;
    if not found then raise exception using errcode='42501',message='Station authorization expired or revoked'; end if;
  end if;
  if not rooted.meeting_today(d.event_id,rooted.gathering_now()) then raise exception using errcode='42501',message='Current gathering date required'; end if;
  perform rooted.require_open(d.event_id);
  return d;
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
  if not rooted.meeting_today(eid,rooted.gathering_now()) then raise exception using errcode='42501',message='Current gathering date required for new check-in'; end if;
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

-- Require the immutable gathering on every new kiosk submission. Older clients
-- without this fence fail closed until refreshed; never infer a queued date.
alter function public.rooted_kiosk(text,text,jsonb,uuid) set schema rooted;
alter function rooted.rooted_kiosk(text,text,jsonb,uuid) rename to kiosk_before_weekly;
revoke all on function rooted.kiosk_before_weekly(text,text,jsonb,uuid) from public,anon,authenticated,service_role;
create function public.rooted_kiosk(p_token text,p_action text,p_payload jsonb default '{}'::jsonb,p_request_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d rooted.devices%rowtype;
begin
 perform rooted.lock_app();
 d:=rooted.require_device(p_token);
 if p_action='checkin' then
  perform rooted.keys(p_payload,array['event_id','participant_id','bible','chapters']);
  if rooted.uid(p_payload,'event_id')<>d.event_id then
   raise exception using errcode='42501',message='Queued gathering does not match device authority';
  end if;
  return rooted.kiosk_before_weekly(p_token,p_action,p_payload-'event_id',p_request_id);
 end if;
 return rooted.kiosk_before_weekly(p_token,p_action,p_payload,p_request_id);
end $$;
revoke all on function public.rooted_kiosk(text,text,jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.rooted_kiosk(text,text,jsonb,uuid) to service_role;

commit;
