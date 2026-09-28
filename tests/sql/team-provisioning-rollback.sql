begin;
insert into auth.users(id,email) values ('94000000-0000-4000-8000-000000000001','prov-admin@example.test'),('94000000-0000-4000-8000-000000000002','prov-new@example.test');
insert into rooted.leaders(user_id,display_name,role) values ('94000000-0000-4000-8000-000000000001','Admin','admin');
do $$
declare i uuid; r jsonb;
begin
 perform set_config('request.jwt.claim.sub','94000000-0000-4000-8000-000000000001',true);perform set_config('role','authenticated',true);
 r:=public.rooted_team_mutate(gen_random_uuid(),'invite','{"email":"prov-new@example.test","display_name":"New"}');i:=(r->'result'->>'id')::uuid;
 perform set_config('role','service_role',true);
 r:=public.rooted_team_provision('94000000-0000-4000-8000-000000000001',i,'get');
 if r->>'email'<>'prov-new@example.test' then raise exception 'wrong invitation';end if;
 r:=public.rooted_team_provision('94000000-0000-4000-8000-000000000001',i,'bind','94000000-0000-4000-8000-000000000002');
 if r->>'user_id'<>'94000000-0000-4000-8000-000000000002' then raise exception 'bind failed';end if;
 perform public.rooted_team_provision('94000000-0000-4000-8000-000000000001',i,'bind','94000000-0000-4000-8000-000000000002');
 r:=public.rooted_team_provision('94000000-0000-4000-8000-000000000001',i,'claim_delivery');
 if not (r->>'send')::boolean then raise exception 'first claim failed';end if;
 r:=public.rooted_team_provision('94000000-0000-4000-8000-000000000001',i,'claim_delivery');
 if (r->>'send')::boolean then raise exception 'duplicate delivery allowed';end if;
 perform set_config('role','authenticated',true);
 begin perform public.rooted_team_mutate(gen_random_uuid(),'cancel',jsonb_build_object('id',i));raise exception 'provisioned cancellation allowed';exception when invalid_parameter_value then null;end;
 perform set_config('role','none',true);
 if (select count(*) from rooted.team_audit where action='provision.bind')<>1 then raise exception 'duplicate bind audit';end if;
 if not exists(select 1 from rooted.leaders where user_id='94000000-0000-4000-8000-000000000002' and role='leader' and active) then raise exception 'assignment missing';end if;
 update rooted.leaders set active=false where user_id='94000000-0000-4000-8000-000000000001';
 perform set_config('role','service_role',true);
 begin perform public.rooted_team_provision('94000000-0000-4000-8000-000000000001',i,'get');raise exception 'revoked admin allowed';exception when insufficient_privilege then null;end;
 perform set_config('role','none',true);
end $$;
rollback;
