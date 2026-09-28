-- Forward-only authority repair. No hosted fixtures or Auth mutations.
begin;
create or replace function public.rooted_leader_mutate(p_request_id uuid,p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; prior jsonb; result jsonb;
begin
 perform rooted.lock_app(); actor:=rooted.require_leader();
 if p_action in ('profile.update','rates.update','theme.update','kiosk.issue','kiosk.revoke','season.create','season.active','event.create','event.open') then
  perform rooted.require_admin();
 end if;
 -- Replay cannot repeat a lifecycle revocation against newly issued authority.
 prior:=rooted.replay(p_request_id,actor,'leader',p_action,p_payload);
 if prior is not null then return prior; end if;
 result:=rooted.foundation_mutate(p_request_id,p_action,p_payload);
 if p_action='event.open' and not rooted.flag(p_payload,'open') then
  update rooted.devices set revoked_at=clock_timestamp(),revoked_by=actor where event_id=rooted.uid(p_payload,'event_id') and revoked_at is null;
 elsif p_action='season.active' and not rooted.flag(p_payload,'active') then
  update rooted.devices d set revoked_at=clock_timestamp(),revoked_by=actor where d.revoked_at is null and exists(select 1 from rooted.events e where e.id=d.event_id and e.season_id=rooted.uid(p_payload,'season_id'));
 end if;
 return result;
end $$;
create function public.rooted_station_transfer(p_request_id uuid,p_station_id uuid,p_event_id uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; s rooted.stations%rowtype; payload jsonb; prior jsonb; n integer;
begin
 perform rooted.lock_app(); actor:=rooted.require_admin();
 payload:=jsonb_build_object('station_id',p_station_id,'event_id',p_event_id,'reason',p_reason);
 perform rooted.txt(payload,'reason',500);
 prior:=rooted.replay(p_request_id,actor,'leader','station.transfer',payload);
 if prior is not null then return prior; end if;
 perform rooted.require_open(p_event_id);
 select x.* into s from rooted.stations x where x.id=p_station_id and x.revoked_at is null and x.expires_at>clock_timestamp() for update;
 if not found then raise exception using errcode='22023',message='Active station required'; end if;
 if s.event_id=p_event_id then raise exception using errcode='22023',message='Different target gathering required'; end if;
 update rooted.devices set revoked_at=clock_timestamp(),revoked_by=actor where station_id=s.id and revoked_at is null;
 get diagnostics n=row_count;
 update rooted.stations set event_id=p_event_id where id=s.id;
 return rooted.finish(p_request_id,actor,'leader','station.transfer',payload,jsonb_build_object('id',s.id,'event_id',p_event_id,'previous_event_id',s.event_id,'revoked_sessions',n));
end $$;
revoke all on function public.rooted_station_transfer(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.rooted_station_transfer(uuid,uuid,uuid,text) to authenticated;
commit;
