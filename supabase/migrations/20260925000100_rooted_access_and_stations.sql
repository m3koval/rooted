-- Reviewable forward migration; never installs accounts or participant fixtures.
begin;
create table rooted.checkin_pins (
  user_id uuid primary key references rooted.leaders(user_id),
  pin_hash text not null,
  updated_at timestamptz not null default now()
);
create table rooted.stations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references rooted.events(id),
  label text not null check(length(btrim(label)) between 1 and 80),
  token_hash bytea not null unique check(octet_length(token_hash)=32),
  authorized_by uuid not null references rooted.leaders(user_id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references rooted.leaders(user_id),
  failed_attempts integer not null default 0 check(failed_attempts between 0 and 5),
  locked_until timestamptz,
  check(expires_at>created_at),
  check((revoked_at is null)=(revoked_by is null))
);
alter table rooted.checkin_pins enable row level security;
alter table rooted.stations enable row level security;
revoke all on rooted.checkin_pins,rooted.stations from public,anon,authenticated,service_role;
alter table rooted.devices add column station_id uuid references rooted.stations(id);
create index devices_station_idx on rooted.devices(station_id);

-- Keep the reviewed foundation command implementation private. Guard privileged
-- commands BEFORE it can resolve a receipt; demotion must invalidate replay.
alter function public.rooted_leader_mutate(uuid,text,jsonb) set schema rooted;
alter function rooted.rooted_leader_mutate(uuid,text,jsonb) rename to foundation_mutate;
revoke all on function rooted.foundation_mutate(uuid,text,jsonb) from public,anon,authenticated,service_role;
create function public.rooted_leader_mutate(p_request_id uuid,p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform rooted.lock_app(); perform rooted.require_leader();
  if p_action in ('profile.update','rates.update','theme.update','kiosk.issue','kiosk.revoke') then
    perform rooted.require_admin();
  end if;
  return rooted.foundation_mutate(p_request_id,p_action,p_payload);
end $$;
create or replace function public.rooted_admin_profiles(p_limit integer default 100,p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform rooted.lock_app(); perform rooted.require_leader();
  if p_limit is null or p_limit not between 1 and 500 or p_offset is null or p_offset not between 0 and 1000000 then
    raise exception using errcode='22023',message='Invalid pagination';
  end if;
  select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into result from (
    select p.id as participant_id,x.date_of_birth,x.parent_guardian_name,x.parent_guardian_email,x.parent_guardian_phone,coalesce(x.review_flags,'[]'::jsonb) as review_flags
    from rooted.participants p left join rooted.participant_profiles x on x.participant_id=p.id order by p.id limit p_limit offset p_offset
  ) q;
  return jsonb_build_object('rows',result,'limit',p_limit,'offset',p_offset);
end $$;
create function public.rooted_set_checkin_pin(p_pin text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid;
begin
  perform rooted.lock_app(); actor:=rooted.require_leader();
  if p_pin is null or p_pin !~ '^[0-9]{6}$' then
    raise exception using errcode='22023',message='Six digit PIN required';
  end if;
  -- Serialize both uniqueness checking and rotation, including inactive leaders.
  if exists(select 1 from rooted.checkin_pins p where p.user_id<>actor and extensions.crypt(p_pin,p.pin_hash)=p.pin_hash) then
    raise exception using errcode='23505',message='PIN unavailable; choose another';
  end if;
  insert into rooted.checkin_pins(user_id,pin_hash) values(actor,extensions.crypt(p_pin,extensions.gen_salt('bf',10)))
    on conflict(user_id) do update set pin_hash=excluded.pin_hash,updated_at=now();
  perform rooted.finish(gen_random_uuid(),actor,'leader','station.pin.set','{}','{"ok":true}');
  return '{"ok":true}'::jsonb;
end $$;
create function public.rooted_station_manage(p_action text,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; eid uuid; sid uuid; token text; ttl integer:=30; s rooted.stations%rowtype; result jsonb;
begin
  perform rooted.lock_app(); actor:=rooted.require_admin();
  case p_action
  when 'station.enroll' then
    perform rooted.keys(p_payload,array['event_id','label'],array['ttl_days']);
    eid:=rooted.uid(p_payload,'event_id'); perform rooted.require_open(eid);
    if p_payload ? 'ttl_days' then ttl:=rooted.num(p_payload,'ttl_days',1,90); end if;
    token:=encode(extensions.gen_random_bytes(32),'hex');
    insert into rooted.stations(event_id,label,token_hash,authorized_by,expires_at)
      values(eid,rooted.txt(p_payload,'label',80),extensions.digest(token,'sha256'),actor,clock_timestamp()+make_interval(days=>ttl)) returning * into s;
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
create function public.rooted_station_unlock(p_station_token text,p_pin text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s rooted.stations%rowtype; actor uuid; token text; d rooted.devices%rowtype; t timestamptz;
begin
  perform rooted.lock_app(); t:=clock_timestamp();
  if p_station_token is null or p_station_token !~ '^[0-9a-f]{64}$' then return '{"ok":false,"error":"invalid_station"}'; end if;
  select x.* into s from rooted.stations x where x.token_hash=extensions.digest(p_station_token,'sha256') and x.revoked_at is null and x.expires_at>t for update;
  if not found then return '{"ok":false,"error":"invalid_station"}'; end if;
  if s.locked_until>t then return jsonb_build_object('ok',false,'error','locked','retry_after_seconds',ceil(extract(epoch from s.locked_until-t))::integer); end if;
  if s.locked_until is not null then
    update rooted.stations set failed_attempts=0,locked_until=null where id=s.id; s.failed_attempts:=0;
  end if;
  if not exists(select 1 from rooted.events e join rooted.seasons se on se.id=e.season_id where e.id=s.event_id and e.open and se.active) then
    return '{"ok":false,"error":"event_closed"}';
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
  token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into rooted.devices(event_id,token_hash,label,issued_by,expires_at,station_id)
    values(s.event_id,extensions.digest(token,'sha256'),s.label,actor,least(clock_timestamp()+interval '4 hours',s.expires_at),s.id) returning * into d;
  perform rooted.finish(gen_random_uuid(),d.id,'device','station.unlock','{}',jsonb_build_object('station_id',s.id,'event_id',s.event_id,'expires_at',d.expires_at));
  return jsonb_build_object('ok',true,'device_token',token,'expires_at',d.expires_at,'event_id',d.event_id);
end $$;
create or replace function rooted.require_device(token text) returns rooted.devices language plpgsql set search_path='' as $$
declare d rooted.devices%rowtype;
begin
  if token is null or token !~ '^[0-9a-f]{64}$' then raise exception using errcode='42501',message='Invalid kiosk capability'; end if;
  select x.* into d from rooted.devices x join rooted.leaders l on l.user_id=x.issued_by and l.active
    where x.token_hash=extensions.digest(token,'sha256') and x.revoked_at is null and x.expires_at>clock_timestamp() for share of x,l;
  if not found then raise exception using errcode='42501',message='Invalid or expired kiosk capability'; end if;
  if d.station_id is not null then
    perform 1 from rooted.stations s where s.id=d.station_id and s.event_id=d.event_id and s.revoked_at is null and s.expires_at>clock_timestamp() for share;
    if not found then raise exception using errcode='42501',message='Station authorization expired or revoked'; end if;
  end if;
  perform rooted.require_open(d.event_id);
  return d;
end $$;
create function public.rooted_station_lock(p_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d rooted.devices%rowtype;
begin
  perform rooted.lock_app();
  -- Lock remains possible after expiry/event closure/parent revocation.
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception using errcode='42501',message='Invalid kiosk capability'; end if;
  select x.* into d from rooted.devices x where x.token_hash=extensions.digest(p_token,'sha256') for update;
  if not found then raise exception using errcode='42501',message='Invalid kiosk capability'; end if;
  if d.revoked_at is null then
    update rooted.devices set revoked_at=clock_timestamp(),revoked_by=d.issued_by where id=d.id;
    perform rooted.finish(gen_random_uuid(),d.id,'device','station.lock','{}',jsonb_build_object('id',d.id,'revoked',true,'source','device_self_lock','revoked_by_semantics','session_issuer_provenance'));
  end if;
  return '{"ok":true}'::jsonb;
end $$;
revoke all on all functions in schema rooted from public,anon,authenticated,service_role;
revoke all on function public.rooted_leader_mutate(uuid,text,jsonb),public.rooted_set_checkin_pin(text),public.rooted_station_manage(text,jsonb),public.rooted_station_unlock(text,text),public.rooted_station_lock(text) from public,anon,authenticated,service_role;
grant execute on function public.rooted_leader_mutate(uuid,text,jsonb),public.rooted_set_checkin_pin(text),public.rooted_station_manage(text,jsonb) to authenticated;
grant execute on function public.rooted_station_unlock(text,text),public.rooted_station_lock(text) to service_role;
comment on schema rooted is 'Private leader authority; accountless participants; enrolled stations plus PIN grant check-in-only sessions, never leader/admin Auth.';
commit;
