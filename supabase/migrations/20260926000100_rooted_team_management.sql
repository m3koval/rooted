-- LOCAL REVIEW ONLY. Invitations are held: no Auth mutation or email delivery.
begin;
create table rooted.team_invitations (
 id uuid primary key default gen_random_uuid(),
 email text not null check(length(email) between 3 and 254 and email=lower(btrim(email)) and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
 display_name text not null check(length(btrim(display_name)) between 1 and 80),
 role text not null default 'leader' check(role in ('leader','admin')),
 status text not null default 'held' check(status in ('held','cancelled')),
 created_by uuid not null references rooted.leaders(user_id),
 created_at timestamptz not null default now(),
 cancelled_by uuid references rooted.leaders(user_id), cancelled_at timestamptz,
 check((status='cancelled')=(cancelled_at is not null)),
 check((cancelled_at is null)=(cancelled_by is null))
);
create unique index team_invitation_pending_email on rooted.team_invitations(email) where status='held';
-- Deliberately separate from operational audit: leader history RPC must not expose invitation email.
create table rooted.team_audit (
 request_id uuid primary key,
 actor_id uuid not null references rooted.leaders(user_id),
 action text not null, payload jsonb not null, response jsonb not null,
 created_at timestamptz not null default now()
);
alter table rooted.team_invitations enable row level security;
alter table rooted.team_audit enable row level security;
revoke all on rooted.team_invitations,rooted.team_audit from public,anon,authenticated,service_role;
create trigger immutable_rows before update or delete on rooted.team_audit for each row execute function rooted.immutable();
create trigger immutable_truncate before truncate on rooted.team_audit for each statement execute function rooted.immutable();

create function public.rooted_team_list(p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; members jsonb; invitations jsonb;
begin
 perform rooted.lock_app(); actor:=rooted.require_admin();
 if p_offset is null or p_offset<0 or p_offset>100000 then raise exception using errcode='22023',message='Invalid offset'; end if;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into members from (
  select l.user_id,l.display_name,l.role,l.active,l.created_at from rooted.leaders l order by l.created_at,l.user_id limit 100 offset p_offset
 ) x;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into invitations from (
  select i.id,i.email,i.display_name,i.role,i.status,i.created_at from rooted.team_invitations i where i.status='held' order by i.created_at,i.id limit 100 offset p_offset
 ) x;
 return jsonb_build_object('actor_id',actor,'members',members,'invitations',invitations,'delivery','held','has_more',
 exists(select 1 from rooted.leaders l offset p_offset+100) or exists(select 1 from rooted.team_invitations i where i.status='held' offset p_offset+100));
end;
$$;
create function public.rooted_team_mutate(p_request_id uuid,p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; old rooted.team_audit%rowtype; target rooted.leaders%rowtype; invitation rooted.team_invitations%rowtype;
 result jsonb; response jsonb; target_id uuid; desired_role text; v_email text; name text;
begin
 -- Same lock as every existing operational RPC. Validate current authority BEFORE replay.
 perform rooted.lock_app(); actor:=rooted.require_admin();
 if p_request_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>4096 then
  raise exception using errcode='22023',message='Invalid request'; end if;
 select a.* into old from rooted.team_audit a where a.request_id=p_request_id;
 if found then
  if old.actor_id<>actor or old.action is distinct from p_action or old.payload is distinct from p_payload then raise exception using errcode='23505',message='Request conflict'; end if;
  return old.response;
 end if;
 if p_action='invite' then
  if p_payload - array['email','display_name','role'] <> '{}'::jsonb then raise exception using errcode='22023',message='Invalid fields'; end if;
  v_email:=lower(rooted.txt(p_payload,'email',254)); name:=rooted.txt(p_payload,'display_name',80);
  desired_role:=coalesce(p_payload->>'role','leader');
  if desired_role not in ('leader','admin') or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception using errcode='22023',message='Invalid invitation'; end if;
  if exists(select 1 from auth.users u join rooted.leaders l on l.user_id=u.id where lower(u.email)=v_email) then raise exception using errcode='23505',message='Member already exists'; end if;
  insert into rooted.team_invitations(email,display_name,role,created_by) values(v_email,name,desired_role,actor) returning * into invitation;
  result:=jsonb_build_object('id',invitation.id,'status','held','email_sent',false);
 elsif p_action='cancel' then
  if p_payload - 'id' <> '{}'::jsonb then raise exception using errcode='22023',message='Invalid fields'; end if;
  target_id:=rooted.uid(p_payload,'id');
  select i.* into invitation from rooted.team_invitations i where i.id=target_id for update;
  if not found or invitation.status<>'held' then raise exception using errcode='22023',message='Pending invitation required'; end if;
  update rooted.team_invitations set status='cancelled',cancelled_at=now(),cancelled_by=actor where id=target_id;
  result:=jsonb_build_object('id',target_id,'status','cancelled','auth_revoked',false);
 elsif p_action in ('deactivate','reactivate','role') then
  if (p_payload - (case when p_action='role' then array['user_id','role'] else array['user_id'] end)) <> '{}'::jsonb then raise exception using errcode='22023',message='Invalid fields'; end if;
  target_id:=rooted.uid(p_payload,'user_id');
  select l.* into target from rooted.leaders l where l.user_id=target_id for update;
  if not found then raise exception using errcode='22023',message='Member required'; end if;
  desired_role:=case when p_action='role' then rooted.txt(p_payload,'role',10) else target.role end;
  if desired_role not in ('leader','admin') then raise exception using errcode='22023',message='Invalid role'; end if;
  if target_id=actor and (p_action='deactivate' or desired_role<>'admin') then raise exception using errcode='42501',message='Self lockout prohibited'; end if;
  if target.active and target.role='admin' and (p_action='deactivate' or desired_role<>'admin') and
    (select count(*) from rooted.leaders l where l.active and l.role='admin')<=1 then
    raise exception using errcode='42501',message='Last admin must remain'; end if;
  update rooted.leaders set role=desired_role,active=case when p_action='deactivate' then false when p_action='reactivate' then true else active end where user_id=target_id;
  if p_action='deactivate' then
   update rooted.devices set revoked_at=now(),revoked_by=actor where issued_by=target_id and revoked_at is null;
  end if;
  result:=jsonb_build_object('user_id',target_id,'role',desired_role,'active',case when p_action='deactivate' then false when p_action='reactivate' then true else target.active end,'previous_role',target.role,'previous_active',target.active);
 else raise exception using errcode='22023',message='Unknown team action'; end if;
 response:=jsonb_build_object('request_id',p_request_id,'action',p_action,'result',result);
 insert into rooted.team_audit(request_id,actor_id,action,payload,response) values(p_request_id,actor,p_action,p_payload,response);
 return response;
end;
$$;
revoke all on function public.rooted_team_list(integer),public.rooted_team_mutate(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.rooted_team_list(integer),public.rooted_team_mutate(uuid,text,jsonb) to authenticated;
commit;
