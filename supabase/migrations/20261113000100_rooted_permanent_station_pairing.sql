-- Permanent pairing, not permanent daily access. Forward-only.
-- Preserve all device rows, revoked stations, PIN lockouts, bindings and ACLs.
begin;
select rooted.lock_app();
alter table rooted.stations alter column expires_at drop not null;
update rooted.stations set expires_at=null where revoked_at is null;
comment on column rooted.stations.expires_at is 'Legacy enrollment deadline; ignored for pairing. NULL for permanent nonrevoked stations. Daily device expiry remains enforced.';
create or replace function public.rooted_station_manage(p_action text,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; eid uuid; sid uuid; token text; s rooted.stations%rowtype; result jsonb;
begin
  perform rooted.lock_app(); actor:=rooted.require_admin();
  case p_action
  when 'station.enroll' then
    perform rooted.keys(p_payload,array['event_id','label'],array['ttl_days']);
    eid:=rooted.uid(p_payload,'event_id'); perform rooted.require_open(eid);
    -- Compatibility for cached clients: validate but ignore the former TTL.
    if p_payload ? 'ttl_days' then perform rooted.num(p_payload,'ttl_days',1,90); end if;
    token:=encode(extensions.gen_random_bytes(32),'hex');
    insert into rooted.stations(event_id,label,token_hash,authorized_by,expires_at)
      values(eid,rooted.txt(p_payload,'label',80),extensions.digest(token,'sha256'),actor,null) returning * into s;
    result:=jsonb_build_object('id',s.id,'event_id',s.event_id,'label',s.label,'expires_at',s.expires_at);
    perform rooted.finish(gen_random_uuid(),actor,'leader',p_action,p_payload,result);
    return jsonb_build_object('ok',true,'station',result||jsonb_build_object('token',token));
  when 'station.revoke' then
    perform rooted.keys(p_payload,array['station_id']); sid:=rooted.uid(p_payload,'station_id');
    update rooted.stations set revoked_at=coalesce(revoked_at,clock_timestamp()),revoked_by=coalesce(revoked_by,actor) where id=sid;
    if not found then raise exception using errcode='22023',message='Station not found'; end if;
    result:=jsonb_build_object('id',sid,'revoked',true);
    perform rooted.finish(gen_random_uuid(),actor,'leader',p_action,p_payload,result);
    return jsonb_build_object('ok',true,'station',result);
  when 'station.list' then
    perform rooted.keys(p_payload,'{}'::text[]);
    select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into result from
      (select id,event_id,label,expires_at,revoked_at,created_at from rooted.stations order by created_at desc limit 500) q;
    return jsonb_build_object('ok',true,'stations',result);
  else raise exception using errcode='22023',message='Unknown station action';
  end case;
end $$;
create or replace function public.rooted_station_unlock(p_station_token text,p_pin text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s rooted.stations%rowtype; actor uuid; token text; d rooted.devices%rowtype; t timestamptz; old_event rooted.events%rowtype; target uuid; candidates integer;
begin
  perform rooted.lock_app(); t:=rooted.gathering_now();
  if p_station_token is null or p_station_token !~ '^[0-9a-f]{64}$' then return '{"ok":false,"error":"invalid_station"}'; end if;
  select x.* into s from rooted.stations x where x.token_hash=extensions.digest(p_station_token,'sha256') and x.revoked_at is null for update;
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
    values(s.event_id,extensions.digest(token,'sha256'),s.label,actor,((t at time zone 'America/New_York')::date + 1)::timestamp at time zone 'America/New_York',s.id,t) returning * into d;
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
    perform 1 from rooted.stations s where s.id=d.station_id and s.event_id=d.event_id and s.revoked_at is null for share;
    if not found then raise exception using errcode='42501',message='Station authorization missing or revoked'; end if;
  end if;
  if not rooted.meeting_today(d.event_id,rooted.gathering_now()) then raise exception using errcode='42501',message='Current gathering date required'; end if;
  perform rooted.require_open(d.event_id);
  return d;
end $$;
create or replace function public.rooted_station_transfer(p_request_id uuid,p_station_id uuid,p_event_id uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; s rooted.stations%rowtype; payload jsonb; prior jsonb; n integer;
begin
 perform rooted.lock_app(); actor:=rooted.require_admin();
 payload:=jsonb_build_object('station_id',p_station_id,'event_id',p_event_id,'reason',p_reason);
 perform rooted.txt(payload,'reason',500);
 prior:=rooted.replay(p_request_id,actor,'leader','station.transfer',payload);
 if prior is not null then return prior; end if;
 perform rooted.require_open(p_event_id);
 select x.* into s from rooted.stations x where x.id=p_station_id and x.revoked_at is null for update;
 if not found then raise exception using errcode='22023',message='Active station required'; end if;
 if s.event_id=p_event_id then raise exception using errcode='22023',message='Different target gathering required'; end if;
 update rooted.devices set revoked_at=clock_timestamp(),revoked_by=actor where station_id=s.id and revoked_at is null;
 get diagnostics n=row_count;
 update rooted.stations set event_id=p_event_id where id=s.id;
 return rooted.finish(p_request_id,actor,'leader','station.transfer',payload,jsonb_build_object('id',s.id,'event_id',p_event_id,'previous_event_id',s.event_id,'revoked_sessions',n));
end $$;
commit;
