-- Server-only provisioning gate. No identities created by this migration.
begin;
alter table rooted.team_invitations drop constraint team_invitations_status_check;
alter table rooted.team_invitations add constraint team_invitations_status_check check(status in ('held','cancelled','provisioned'));
alter table rooted.team_invitations add column auth_user_id uuid references auth.users(id), add column delivery_attempted_at timestamptz;
create function public.rooted_team_provision(p_actor uuid,p_id uuid,p_step text,p_user_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i rooted.team_invitations%rowtype; result jsonb;
begin
 perform rooted.lock_app();
 if not exists(select 1 from rooted.leaders l where l.user_id=p_actor and l.active and l.role='admin') then raise exception using errcode='42501',message='Current admin required'; end if;
 select x.* into i from rooted.team_invitations x where x.id=p_id for update;
 if not found or i.status='cancelled' then raise exception using errcode='22023',message='Active invitation required'; end if;
 if p_step='bind' and i.auth_user_id is null then
  if not exists(select 1 from auth.users u where u.id=p_user_id and lower(u.email)=i.email) or exists(select 1 from rooted.leaders l where l.user_id=p_user_id) then raise exception using errcode='23505',message='Identity conflict'; end if;
  insert into rooted.leaders(user_id,display_name,role,active) values(p_user_id,i.display_name,i.role,true);
  update rooted.team_invitations set auth_user_id=p_user_id,status='provisioned' where id=i.id returning * into i;
  result:=jsonb_build_object('id',i.id,'user_id',p_user_id,'delivery','held');
 elsif p_step='claim_delivery' then
  if i.auth_user_id is null then raise exception using errcode='22023',message='Provision first'; end if;
  if i.delivery_attempted_at is not null then return jsonb_build_object('send',false); end if;
  if not exists(select 1 from rooted.leaders l where l.user_id=i.auth_user_id and l.active) then raise exception using errcode='42501',message='Membership inactive'; end if;
  update rooted.team_invitations set delivery_attempted_at=clock_timestamp() where id=i.id;
  result:=jsonb_build_object('id',i.id,'send',true);
 elsif p_step not in ('get','bind') then raise exception using errcode='22023',message='Unknown provisioning step';
 end if;
 if result is not null then
  insert into rooted.team_audit(request_id,actor_id,action,payload,response) values(gen_random_uuid(),p_actor,'provision.'||p_step,jsonb_build_object('id',p_id),result);
 end if;
 return jsonb_build_object('id',i.id,'email',i.email,'user_id',i.auth_user_id,'send',coalesce((result->>'send')::boolean,false));
end $$;
revoke all on function public.rooted_team_provision(uuid,uuid,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.rooted_team_provision(uuid,uuid,text,uuid) to service_role;
commit;
