-- Durable server-only provisioning saga; no network or production changes.
begin;
create table rooted.team_provision_requests (
 request_id uuid primary key, actor_id uuid not null references rooted.leaders(user_id),
 invitation_id uuid not null unique references rooted.team_invitations(id), mode text not null check(mode in ('held','verified_smtp')),
 phase text not null check(phase in ('create_claimed','identity_saved','bound','delivery_claimed','done')),
 user_id uuid references auth.users(id), receipt jsonb, created_at timestamptz not null default clock_timestamp(),
 check ((phase='done')=(receipt is not null))
);
alter table rooted.team_provision_requests enable row level security;
revoke all on rooted.team_provision_requests from public,anon,authenticated,service_role;
create function rooted.guard_provision_request() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op<>'UPDATE' then raise exception 'Provision requests cannot be removed'; end if;
 if old.receipt is not null or (old.request_id,old.actor_id,old.invitation_id,old.mode,old.created_at) is distinct from (new.request_id,new.actor_id,new.invitation_id,new.mode,new.created_at)
 or (old.user_id is not null and old.user_id is distinct from new.user_id) then raise exception 'Immutable provisioning evidence'; end if;
 return new;
end $$;
create trigger guard_provision_request before update or delete on rooted.team_provision_requests for each row execute function rooted.guard_provision_request();
create trigger guard_provision_truncate before truncate on rooted.team_provision_requests for each statement execute function rooted.immutable();
create function public.rooted_team_provision_request(p_actor uuid,p_request_id uuid,p_id uuid,p_mode text,p_step text,p_user_id uuid default null,p_delivery text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o rooted.team_provision_requests%rowtype; i rooted.team_invitations%rowtype; v jsonb; fresh boolean:=false;
begin
 perform rooted.lock_app();
 if not exists(select 1 from rooted.leaders where user_id=p_actor and active and role='admin') then raise exception using errcode='42501',message='Current admin required'; end if;
 if p_request_id is null or p_id is null or p_mode is null or p_mode not in ('held','verified_smtp') then raise exception using errcode='22023',message='Invalid request'; end if;
 select * into o from rooted.team_provision_requests where request_id=p_request_id for update;
 if found then
  if o.actor_id<>p_actor or o.invitation_id<>p_id or o.mode<>p_mode then raise exception using errcode='23505',message='Request conflict'; end if;
  if o.receipt is not null then return o.receipt; end if;
 elsif p_step='start' then
  if exists(select 1 from rooted.team_audit where request_id=p_request_id) then raise exception using errcode='23505',message='Request conflict'; end if;
  select * into i from rooted.team_invitations where id=p_id for update;
  if not found or i.status='cancelled' then raise exception using errcode='22023',message='Active invitation required'; end if;
  insert into rooted.team_provision_requests(request_id,actor_id,invitation_id,mode,phase,user_id)
   values(p_request_id,p_actor,p_id,p_mode,case when i.auth_user_id is null then 'create_claimed' else 'bound' end,i.auth_user_id) returning * into o;
  fresh:=true;
 else raise exception using errcode='22023',message='Start required'; end if;
 select * into i from rooted.team_invitations where id=p_id for update;
 if p_step in ('save_identity','reconcile_identity') then
  if o.user_id is not null and o.user_id is distinct from p_user_id then raise exception using errcode='23505',message='Identity immutable'; end if;
  if o.phase not in ('create_claimed','identity_saved') then raise exception using errcode='22023',message='Wrong phase'; end if;
  -- Reconciliation never attaches a user merely because an email matches. Require
  -- Auth's server-owned app_metadata marker from this exact creation attempt.
  if p_user_id is null or not exists(select 1 from auth.users u where u.id=p_user_id and lower(u.email)=i.email
    and u.raw_app_meta_data->>'rooted_provision_request'=p_request_id::text)
   or exists(select 1 from rooted.leaders where user_id=p_user_id)
   or exists(select 1 from rooted.team_invitations where auth_user_id=p_user_id and id<>p_id)
   or exists(select 1 from rooted.team_provision_requests where user_id=p_user_id and request_id<>p_request_id)
   then raise exception using errcode='23505',message='Verified identity required'; end if;
  update rooted.team_provision_requests set user_id=p_user_id,phase='identity_saved' where request_id=p_request_id returning * into o;
 elsif p_step='bind' then
  if o.phase='identity_saved' then
   perform public.rooted_team_provision(p_actor,p_id,'bind',o.user_id);
   update rooted.team_provision_requests set phase='bound' where request_id=p_request_id returning * into o;
  elsif o.phase<>'bound' then raise exception using errcode='22023',message='Identity required'; end if;
 elsif p_step='claim_delivery' then
  if o.phase<>'bound' or o.mode<>'verified_smtp' then raise exception using errcode='22023',message='Bound SMTP request required'; end if;
  v:=public.rooted_team_provision(p_actor,p_id,'claim_delivery');
  update rooted.team_provision_requests set phase='delivery_claimed' where request_id=p_request_id returning * into o;
  return jsonb_build_object('phase',o.phase,'send',coalesce((v->>'send')::boolean,false),'email',i.email);
 elsif p_step='finish' then
  if not ((o.phase='bound' and o.mode='held' and p_delivery='held') or (o.phase='delivery_claimed' and p_delivery in ('requested','attempted'))) then raise exception using errcode='22023',message='Invalid finish'; end if;
  v:=jsonb_build_object('request_id',p_request_id,'action','provision','result',jsonb_build_object('id',p_id,'user_id',o.user_id,'status','provisioned','delivery',p_delivery,'email_sent',false));
  update rooted.team_provision_requests set phase='done',receipt=v where request_id=p_request_id;
  insert into rooted.team_audit(request_id,actor_id,action,payload,response) values(p_request_id,p_actor,'provision',jsonb_build_object('id',p_id,'mode',p_mode),v);
  return v;
 elsif p_step<>'start' then raise exception using errcode='22023',message='Unknown step'; end if;
 return jsonb_build_object('phase',o.phase,'create',fresh and o.phase='create_claimed','email',i.email,'user_id',o.user_id);
end $$;
revoke all on function public.rooted_team_provision_request(uuid,uuid,uuid,text,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.rooted_team_provision_request(uuid,uuid,uuid,text,text,uuid,text) to service_role;
commit;
