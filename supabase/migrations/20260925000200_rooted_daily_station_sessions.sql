-- North Carolina ministry assumption: calendar day = America/New_York.
-- Forward-only; existing device expiry values are NOT extended.
-- CREATE OR REPLACE preserves function ownership and existing ACLs.
begin;
create or replace function public.rooted_station_unlock(p_station_token text,p_pin text) returns jsonb
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
  -- Capture actual issuance time (not transaction-start now()) for the daily fence.
  t:=clock_timestamp();
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
    where x.token_hash=extensions.digest(token,'sha256') and x.revoked_at is null and x.expires_at>clock_timestamp() for share of x,l;
  if not found then raise exception using errcode='42501',message='Invalid or expired kiosk capability'; end if;
  if d.station_id is not null then
    -- Defense in depth: even a legacy/manually prolonged session needs today's PIN.
    if (d.created_at at time zone 'America/New_York')::date
       is distinct from (clock_timestamp() at time zone 'America/New_York')::date then
      raise exception using errcode='42501',message='Daily station unlock required';
    end if;
    perform 1 from rooted.stations s where s.id=d.station_id and s.event_id=d.event_id and s.revoked_at is null and s.expires_at>clock_timestamp() for share;
    if not found then raise exception using errcode='42501',message='Station authorization expired or revoked'; end if;
  end if;
  perform rooted.require_open(d.event_id);
  return d;
end $$;
commit;
