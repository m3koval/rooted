-- LOCAL DISPOSABLE DATABASE ONLY. Apply all migrations first, run as owner.
-- Fixture writes including auth.users are rolled back. Never run against hosted Rooted.
begin;
insert into auth.users(id,email) values
 ('91000000-0000-4000-8000-000000000001','team-admin-a@example.test'),
 ('91000000-0000-4000-8000-000000000002','team-admin-b@example.test'),
 ('91000000-0000-4000-8000-000000000003','team-leader@example.test'),
 ('91000000-0000-4000-8000-000000000004','team-inactive@example.test');
insert into rooted.leaders(user_id,display_name,role,active) values
 ('91000000-0000-4000-8000-000000000001','Admin A','admin',true),
 ('91000000-0000-4000-8000-000000000002','Admin B','admin',true),
 ('91000000-0000-4000-8000-000000000003','Leader','leader',true),
 ('91000000-0000-4000-8000-000000000004','Inactive','admin',false);
set local role authenticated;
select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000001',true);
do $$
declare r jsonb; i uuid; q uuid:='92000000-0000-4000-8000-000000000001';
begin
 r:=public.rooted_team_list();
 if r->>'actor_id'<>'91000000-0000-4000-8000-000000000001' then raise exception 'wrong actor'; end if;
 r:=public.rooted_team_mutate(q,'invite','{"email":"held@example.test","display_name":"Held"}');
 i:=(r->'result'->>'id')::uuid;
 if r->'result'->>'status'<>'held' or (r->'result'->>'email_sent')::boolean then raise exception 'delivery was not held'; end if;
 if r is distinct from public.rooted_team_mutate(q,'invite','{"email":"held@example.test","display_name":"Held"}') then raise exception 'replay differs'; end if;
 begin perform public.rooted_team_mutate(q,'invite','{"email":"other@example.test","display_name":"Held"}');raise exception 'changed replay accepted';exception when unique_violation then null;end;
 perform public.rooted_team_mutate(gen_random_uuid(),'cancel',jsonb_build_object('id',i));
 perform public.rooted_team_mutate(gen_random_uuid(),'deactivate','{"user_id":"91000000-0000-4000-8000-000000000003"}');
 perform public.rooted_team_mutate(gen_random_uuid(),'reactivate','{"user_id":"91000000-0000-4000-8000-000000000003"}');
 perform public.rooted_team_mutate(gen_random_uuid(),'role','{"user_id":"91000000-0000-4000-8000-000000000003","role":"admin"}');
 perform public.rooted_team_mutate(gen_random_uuid(),'role','{"user_id":"91000000-0000-4000-8000-000000000003","role":"leader"}');
 begin perform public.rooted_team_mutate(gen_random_uuid(),'deactivate','{"user_id":"91000000-0000-4000-8000-000000000001"}');raise exception 'self deactivation accepted';exception when insufficient_privilege then null;end;
 begin perform public.rooted_team_mutate(gen_random_uuid(),'role','{"user_id":"91000000-0000-4000-8000-000000000001","role":"leader"}');raise exception 'self demotion accepted';exception when insufficient_privilege then null;end;
 begin perform public.rooted_team_mutate(gen_random_uuid(),'invite','{"email":"x@example.test","display_name":"X","role":"owner"}');raise exception 'bad role accepted';exception when invalid_parameter_value then null;end;
 begin perform 1 from rooted.team_audit;raise exception 'direct read allowed';exception when insufficient_privilege then null;end;
 begin update rooted.leaders set active=false;raise exception 'direct write allowed';exception when insufficient_privilege then null;end;
end $$;
-- Every identity transition must revalidate active database authority.
select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000003',true);
do $$begin
 begin perform public.rooted_team_list();raise exception 'leader allowed';exception when insufficient_privilege then null;end;
 begin perform public.rooted_team_mutate(gen_random_uuid(),'invite','{"email":"no@example.test","display_name":"No"}');raise exception 'leader mutation allowed';exception when insufficient_privilege then null;end;
end $$;
select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000004',true);
do $$begin
 begin perform public.rooted_team_list();raise exception 'inactive admin allowed';exception when insufficient_privilege then null;end;
end $$;
select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000001',true);
select public.rooted_team_mutate('92000000-0000-4000-8000-000000000002','deactivate','{"user_id":"91000000-0000-4000-8000-000000000002"}');
select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000002',true);
do $$begin
 begin perform public.rooted_team_mutate(gen_random_uuid(),'role','{"user_id":"91000000-0000-4000-8000-000000000001","role":"leader"}');raise exception 'revoked admin allowed';exception when insufficient_privilege then null;end;
end $$;
set local role anon;
do $$begin
 begin perform public.rooted_team_list();raise exception 'anonymous allowed';exception when insufficient_privilege then null;end;
end $$;
reset role;
do $$begin
 if not exists(select 1 from rooted.team_audit where request_id='92000000-0000-4000-8000-000000000001' and actor_id='91000000-0000-4000-8000-000000000001') then raise exception 'audit actor mismatch';end if;
 if not exists(select 1 from rooted.team_invitations where email='held@example.test' and role='leader' and status='cancelled') then raise exception 'default role/cancel history lost';end if;
 if not exists(select 1 from rooted.leaders where user_id='91000000-0000-4000-8000-000000000002' and not active) then raise exception 'deactivation lost';end if;
 begin delete from rooted.team_audit;raise exception 'audit mutable';exception when sqlstate '55000' then null;end;
end $$;
rollback;
