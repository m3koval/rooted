-- Private, PIN-unlocked TV projection; no public roster grant.
-- Canonical installed helper is rooted.require_device(text), NOT rooted_private.kiosk_context.
begin;
create function public.rooted_display(p_token text) returns jsonb
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
    'attendance_count',(select count(*) from rooted.checkins c where c.event_id=d.event_id and c.attended),
    'participants',coalesce((select jsonb_agg(jsonb_build_object(
      'id',p.id,'name',p.name,'points',coalesce(l.points,0),
      'present',exists(select 1 from rooted.checkins c where c.event_id=d.event_id and c.participant_id=p.id and c.attended)
    ) order by coalesce(l.points,0) desc,p.name,p.id)
      from rooted.participants p left join
        (select participant_id,sum(points)::bigint as points from rooted.ledger group by participant_id) l
        on l.participant_id=p.id),'[]'::jsonb),
    'updated_at',clock_timestamp()) into result
  from rooted.events e where e.id=d.event_id;
  return result;
end $$;
revoke all on function public.rooted_display(text) from public,anon,authenticated,service_role;
grant execute on function public.rooted_display(text) to service_role;
commit;
