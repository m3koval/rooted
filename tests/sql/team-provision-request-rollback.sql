begin;
insert into auth.users(id,email,raw_app_meta_data) values
 ('95000000-0000-4000-8000-000000000001','saga-admin@example.test','{}'),
 ('95000000-0000-4000-8000-000000000002','saga-new@example.test','{"rooted_provision_request":"95000000-0000-4000-8000-000000000004"}'),
 ('95000000-0000-4000-8000-000000000003','wrong@example.test','{}');
insert into rooted.leaders(user_id,display_name,role) values('95000000-0000-4000-8000-000000000001','Saga admin','admin');
insert into rooted.team_invitations(id,email,display_name,created_by) values('95000000-0000-4000-8000-000000000005','saga-new@example.test','Saga new','95000000-0000-4000-8000-000000000001');
do $$
declare a uuid:='95000000-0000-4000-8000-000000000001'; u uuid:='95000000-0000-4000-8000-000000000002'; q uuid:='95000000-0000-4000-8000-000000000004'; i uuid:='95000000-0000-4000-8000-000000000005'; r jsonb; receipt jsonb;
begin
 perform set_config('role','authenticated',true);
 begin perform public.rooted_team_provision_request(a,q,i,'held','start');raise exception 'client allowed';exception when insufficient_privilege then null;end;
 perform set_config('role','service_role',true);
 r:=public.rooted_team_provision_request(a,q,i,'held','start');
 if r->>'create'<>'true' then raise exception 'initial claim missing';end if;
 r:=public.rooted_team_provision_request(a,q,i,'held','start');
 if r->>'create'<>'false' or r->>'phase'<>'create_claimed' then raise exception 'duplicate create';end if;
 begin perform public.rooted_team_provision_request(a,q,i,'verified_smtp','start');raise exception 'mode changed';exception when unique_violation then null;end;
 begin perform public.rooted_team_provision_request(a,q,gen_random_uuid(),'held','start');raise exception 'invite changed';exception when unique_violation then null;end;
 begin perform public.rooted_team_provision_request(a,gen_random_uuid(),i,'held','start');raise exception 'second request claimed';exception when unique_violation then null;end;
 begin perform public.rooted_team_provision_request(a,q,i,'held','reconcile_identity','95000000-0000-4000-8000-000000000003');raise exception 'blind attach';exception when unique_violation then null;end;
 perform public.rooted_team_provision_request(a,q,i,'held','reconcile_identity',u);
 r:=public.rooted_team_provision_request(a,q,i,'held','start');
 if r->>'phase'<>'identity_saved' or r->>'user_id'<>u::text then raise exception 'identity not durable';end if;
 perform public.rooted_team_provision_request(a,q,i,'held','bind');
 receipt:=public.rooted_team_provision_request(a,q,i,'held','finish',null,'held');
 r:=public.rooted_team_provision_request(a,q,i,'held','start');
 if r is distinct from receipt or r->>'request_id'<>q::text then raise exception 'receipt drift';end if;
 perform set_config('role','none',true);
 begin update rooted.team_provision_requests set user_id=a where request_id=q;raise exception 'guard failed';exception when raise_exception then if sqlerrm='guard failed' then raise;end if;end;
 begin delete from rooted.team_provision_requests where request_id=q;raise exception 'guard failed';exception when raise_exception then if sqlerrm='guard failed' then raise;end if;end;
 update rooted.leaders set active=false where user_id=a;
 perform set_config('role','service_role',true);
 begin perform public.rooted_team_provision_request(a,q,i,'held','start');raise exception 'revoked replay';exception when insufficient_privilege then null;end;
 perform set_config('role','none',true);
end $$;
rollback;
