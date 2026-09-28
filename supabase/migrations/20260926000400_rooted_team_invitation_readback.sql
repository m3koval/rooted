-- Admin-only readback of held and provisioned invitations; no provisioning here.
begin;
create or replace function public.rooted_team_list(p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; members jsonb; invitations jsonb;
begin
 perform rooted.lock_app(); actor:=rooted.require_admin();
 if p_offset is null or p_offset<0 or p_offset>100000 then raise exception using errcode='22023',message='Invalid offset'; end if;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into members from (
  select l.user_id,l.display_name,l.role,l.active,l.created_at from rooted.leaders l order by l.created_at,l.user_id limit 100 offset p_offset
 ) x;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into invitations from (
  select i.id,i.email,i.display_name,i.role,i.status,i.created_at,i.auth_user_id,i.delivery_attempted_at from rooted.team_invitations i where i.status in ('held','provisioned') order by i.created_at,i.id limit 100 offset p_offset
 ) x;
 return jsonb_build_object('actor_id',actor,'members',members,'invitations',invitations,'delivery','held','has_more',
 exists(select 1 from rooted.leaders l offset p_offset+100) or exists(select 1 from rooted.team_invitations i where i.status in ('held','provisioned') offset p_offset+100));
end;
$$;
revoke all on function public.rooted_team_list(integer) from public,anon,authenticated,service_role;
grant execute on function public.rooted_team_list(integer) to authenticated;
commit;
