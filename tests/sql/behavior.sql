-- FICTIONAL ONLY. Run inside the rollback runner, never standalone on production.
create temporary table test_ctx(k text primary key,v jsonb);
create temporary table test_pass(label text primary key);
grant select,insert,update on test_ctx,test_pass to anon,authenticated,service_role;
create function pg_temp.ok(b boolean,label text) returns void language plpgsql as $$
begin
 if b is distinct from true then raise exception 'FAILED: %',label; end if;
 insert into test_pass values(label);
end $$;
create function pg_temp.denied(statement text,expected text,label text) returns void language plpgsql as $$
declare actual text;
begin
 begin execute statement; exception when others then get stacked diagnostics actual=returned_sqlstate; end;
 perform pg_temp.ok(actual=expected,label||' ['||expected||']');
end $$;
create function pg_temp.act(a text,p jsonb,r uuid default gen_random_uuid()) returns jsonb language sql as $$
 select public.rooted_leader_mutate(r,a,p);
$$;
insert into auth.users(id,email) values
 ('00000000-0000-4000-8000-000000000001','rooted-rollback-admin@example.invalid'),
 ('00000000-0000-4000-8000-000000000002','rooted-rollback-leader@example.invalid'),
 ('00000000-0000-4000-8000-000000000003','rooted-rollback-unassigned@example.invalid');
insert into rooted.leaders(user_id,display_name,role) values
 ('00000000-0000-4000-8000-000000000001','Fictional Admin','admin'),
 ('00000000-0000-4000-8000-000000000002','Fictional Leader','leader');
set local role anon;
select pg_temp.denied('select public.rooted_identity()','42501','anon identity denied');
select pg_temp.denied('select public.rooted_leader_state(''participants'')','42501','anon state denied');
select pg_temp.denied('select public.rooted_admin_profiles()','42501','anon profiles denied');
select pg_temp.denied('select public.rooted_leader_mutate(gen_random_uuid(),''participant.create'',''{}'')','42501','anon mutation denied');
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000003',true);
select pg_temp.denied('select public.rooted_identity()','42501','unassigned identity denied');
select pg_temp.denied('select public.rooted_leader_state(''participants'')','42501','unassigned state denied');
select pg_temp.denied('select public.rooted_admin_profiles()','42501','unassigned profiles denied');
select pg_temp.denied('select public.rooted_leader_mutate(gen_random_uuid(),''participant.create'',''{}'')','42501','unassigned mutation denied');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
select pg_temp.ok(public.rooted_identity()->>'role'='leader','leader identity');
select pg_temp.ok(public.rooted_admin_profiles() ? 'rows','leader profiles allowed');
select pg_temp.denied('select public.rooted_leader_mutate(gen_random_uuid(),''profile.update'',''{}'')','42501','leader profile mutation denied');
select pg_temp.denied('select * from rooted.participants','42501','direct directory denied');
select pg_temp.denied('select * from rooted.participant_profiles','42501','direct profiles denied');
select pg_temp.denied('select rooted.require_leader()','42501','private helper denied');
select pg_temp.denied('select public.rooted_kiosk(repeat(''a'',64),''context'')','42501','authenticated kiosk denied');
insert into test_ctx values('season1',pg_temp.act('season.create','{"name":"Fictional Older","starts_on":"2025-01-01","ends_on":"2025-12-31"}')->'result'->'id');
insert into test_ctx values('season2',pg_temp.act('season.create','{"name":"Fictional Current","starts_on":"2026-01-01","ends_on":"2026-12-31"}')->'result'->'id');
insert into test_ctx select 'event1',pg_temp.act('event.create',jsonb_build_object('season_id',v,'name','Fictional Old Event','date','2025-12-31','reading_week','2025-12-29'))->'result'->'id' from test_ctx where k='season1';
insert into test_ctx select 'event2',pg_temp.act('event.create',jsonb_build_object('season_id',v,'name','Fictional Current Event','date','2026-01-01','reading_week','2025-12-29'))->'result'->'id' from test_ctx where k='season2';
insert into test_ctx select 'event3',pg_temp.act('event.create',jsonb_build_object('season_id',v,'name','Fictional Followup','date','2026-01-02','reading_week','2025-12-29'))->'result'->'id' from test_ctx where k='season2';
insert into test_ctx values('guest',pg_temp.act('participant.create','{"name":"Fictional Guest","previously_attended":false}')->'result'->'id');
insert into test_ctx values('inviter',pg_temp.act('participant.create','{"name":"Fictional Inviter","previously_attended":true}')->'result'->'id');
insert into test_ctx values('other',pg_temp.act('participant.create','{"name":"Fictional Other","previously_attended":true}')->'result'->'id');
insert into test_ctx values('newguest',pg_temp.act('participant.create','{"name":"Fictional New Guest","previously_attended":false}')->'result'->'id');
insert into test_ctx values('profile',jsonb_build_object('participant_id',(select v from test_ctx where k='guest'),'date_of_birth','2011-01-01','parent_guardian_name','PRIVATE_SENTINEL','parent_guardian_email','private-sentinel@example.invalid','parent_guardian_phone','000-TEST','review_flags',jsonb_build_array('fictional-review')));
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
select pg_temp.ok(public.rooted_identity()->>'role'='admin','admin identity');
select pg_temp.act('profile.update',v) from test_ctx where k='profile';
select pg_temp.ok(public.rooted_admin_profiles()::text like '%PRIVATE_SENTINEL%','admin private read');
select pg_temp.act('profile.update',v||'{"parent_guardian_phone":null}') from test_ctx where k='profile';
select pg_temp.ok(exists(select 1 from jsonb_array_elements(public.rooted_admin_profiles()->'rows') x where x->>'parent_guardian_name'='PRIVATE_SENTINEL' and x->'parent_guardian_phone'='null'::jsonb),'admin update clear nullable');
select pg_temp.act('profile.update',v||'{"date_of_birth":null,"review_flags":[{"suggested_date_of_birth":"2011-01-01","status":"fictional-review"}]}','10000000-0000-4000-8000-000000000006') from test_ctx where k='profile';
select pg_temp.ok(exists(select 1 from jsonb_array_elements(public.rooted_admin_profiles()->'rows') x where x->>'parent_guardian_name'='PRIVATE_SENTINEL' and x->'date_of_birth'='null'::jsonb and x->'review_flags'='[{"suggested_date_of_birth":"2011-01-01","status":"fictional-review"}]'::jsonb),'nullable DOB and structured review JSON preserved');
select pg_temp.denied(format('select pg_temp.act(''profile.update'',%L::jsonb)',v||'{"date_of_birth":"2999-01-01"}'),'23514','future DOB rejected') from test_ctx where k='profile';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
do $$ declare collection text; begin
 foreach collection in array array['participants','seasons','events','checkins','ledger','draws','reading_totals','first_visits','friend_claims','rates','theme','audit','devices'] loop
  perform pg_temp.ok(public.rooted_leader_state(collection)::text not like '%PRIVATE_SENTINEL%' and public.rooted_leader_state(collection)::text not like '%private-sentinel%' and public.rooted_leader_state(collection)::text not like '%fictional-review%','private redaction: '||collection);
 end loop;
end $$;
select pg_temp.denied('select public.rooted_leader_state(''participant_profiles'')','22023','profile collection not exposed');
select pg_temp.denied('select public.rooted_leader_state(''participants'',0)','22023','pagination bounds');
insert into test_ctx values('check_payload',jsonb_build_object('participant_id',(select v from test_ctx where k='guest'),'event_id',(select v from test_ctx where k='event1'),'attended',true,'bible',true,'chapters',3));
insert into test_ctx select 'check_receipt',pg_temp.act('checkin',v,'10000000-0000-4000-8000-000000000001') from test_ctx where k='check_payload';
select pg_temp.ok((v#>>'{result,receipt,earned_points}')::integer=10,'checkin award 5+2+3') from test_ctx where k='check_receipt';
select pg_temp.ok(pg_temp.act('checkin',(select v from test_ctx where k='check_payload'),'10000000-0000-4000-8000-000000000001')=v,'exact checkin replay') from test_ctx where k='check_receipt';
select pg_temp.ok((pg_temp.act('checkin',v)#>>'{result,duplicate}')::boolean,'new key duplicate checkin') from test_ctx where k='check_payload';
select pg_temp.denied(format('select pg_temp.act(''checkin'',%L::jsonb)',v||'{"chapters":4}'),'23505','changed checkin denied') from test_ctx where k='check_payload';
select pg_temp.denied(format('select pg_temp.act(''checkin'',%L::jsonb,''10000000-0000-4000-8000-000000000001'')',v||'{"chapters":4}'),'23505','changed request payload denied') from test_ctx where k='check_payload';
select pg_temp.ok((pg_temp.act('checkin',v||jsonb_build_object('event_id',(select v from test_ctx where k='event2'),'chapters',7))#>>'{result,receipt,earned_points}')::integer=11,'cross-season cumulative reading delta four') from test_ctx where k='check_payload';
select pg_temp.ok((pg_temp.act('checkin',v||jsonb_build_object('event_id',(select v from test_ctx where k='event3'),'chapters',2))#>>'{result,receipt,earned_points}')::integer=7,'lower reading report no extra credit') from test_ctx where k='check_payload';
insert into test_ctx values('friend_payload',jsonb_build_object('participant_id',(select v from test_ctx where k='guest'),'event_id',(select v from test_ctx where k='event1'),'inviter_id',(select v from test_ctx where k='inviter')));
insert into test_ctx select 'friend_receipt',pg_temp.act('friend.award',v,'10000000-0000-4000-8000-000000000002') from test_ctx where k='friend_payload';
select pg_temp.ok((v#>>'{result,points}')::integer=10,'deferred friend award') from test_ctx where k='friend_receipt';
select pg_temp.ok(pg_temp.act('friend.award',(select v from test_ctx where k='friend_payload'),'10000000-0000-4000-8000-000000000002')=v,'friend exact replay') from test_ctx where k='friend_receipt';
select pg_temp.ok((pg_temp.act('friend.award',v)#>>'{result,duplicate}')::boolean,'friend new-key duplicate no double credit') from test_ctx where k='friend_payload';
select pg_temp.denied(format('select pg_temp.act(''friend.award'',%L::jsonb)',v||jsonb_build_object('inviter_id',(select v from test_ctx where k='other'))),'23505','other inviter denied') from test_ctx where k='friend_payload';
select pg_temp.denied(format('select pg_temp.act(''friend.award'',%L::jsonb)',v||jsonb_build_object('inviter_id',v->'participant_id')),'22023','self-referral denied') from test_ctx where k='friend_payload';
select pg_temp.denied(format('select pg_temp.act(''friend.award'',%L::jsonb)',v||jsonb_build_object('event_id',(select v from test_ctx where k='event2'))),'22023','nonfirst event referral denied') from test_ctx where k='friend_payload';
select pg_temp.denied(format('select pg_temp.act(''friend.award'',%L::jsonb)',v||jsonb_build_object('participant_id',(select v from test_ctx where k='newguest'))),'22023','unattended guest referral denied') from test_ctx where k='friend_payload';
select pg_temp.denied(format('select pg_temp.act(''friend.award'',%L::jsonb)',v||jsonb_build_object('participant_id',(select v from test_ctx where k='other'))),'22023','previous attendee referral denied') from test_ctx where k='friend_payload';
select pg_temp.ok((pg_temp.act('checkin',v)#>>'{result,receipt,earned_points}')::integer=10,'guest receipt unchanged after referral') from test_ctx where k='check_payload';
insert into test_ctx values('draw_payload',jsonb_build_object('event_id',(select v from test_ctx where k='event2'),'prize','Fictional Prize','present_only',false,'one_win',false));
insert into test_ctx select 'draw_receipt',pg_temp.act('draw',v,'10000000-0000-4000-8000-000000000003') from test_ctx where k='draw_payload';
select pg_temp.ok((v#>>'{result,total_weight}')::bigint=38,'draw includes lifetime older-season points') from test_ctx where k='draw_receipt';
select pg_temp.ok(pg_temp.act('draw',(select v from test_ctx where k='draw_payload'),'10000000-0000-4000-8000-000000000003')=v,'draw exact replay') from test_ctx where k='draw_receipt';
select pg_temp.ok((select sum((x->>'points')::bigint) from jsonb_array_elements(public.rooted_leader_state('participants')->'rows') x)=38,'draw does not spend points');
select pg_temp.ok((pg_temp.act('draw',v||'{"present_only":true}')#>>'{result,total_weight}')::bigint=28,'present-only filters attendees') from test_ctx where k='draw_payload';
-- Negative and zero balances remain in history but cannot enter raffle.
select pg_temp.act('adjustment',jsonb_build_object('participant_id',(select v from test_ctx where k='other'),'event_id',(select v from test_ctx where k='event2'),'points',-10,'reason','Fictional test adjustment'));
select pg_temp.ok((pg_temp.act('draw',v)#>>'{result,total_weight}')::bigint=38,'negative and zero excluded') from test_ctx where k='draw_payload';
select pg_temp.denied(format('select pg_temp.act(''draw'',%L::jsonb)',v||'{"present_only":true,"one_win":true}'),'22023','one-win excludes past present winner') from test_ctx where k='draw_payload';
-- Exercise settings and nonretroactive award receipts.
select pg_temp.denied('select pg_temp.act(''rates.update'',''{}'')','42501','leader rates denied');
select pg_temp.denied('select pg_temp.act(''theme.update'',''{}'')','42501','leader theme denied');
select pg_temp.denied('select pg_temp.act(''kiosk.issue'',''{}'')','42501','leader legacy issuance denied');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
select pg_temp.act('rates.update','{"attendance":6,"bible":3,"friend":11}');
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
select pg_temp.ok((pg_temp.act('checkin',v)#>>'{result,receipt,earned_points}')::integer=10,'rate edit nonretroactive') from test_ctx where k='check_payload';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
select pg_temp.act('theme.update','{"name":"REAL","study":"James","tagline":"Fictional testing","scripture":"","artwork":"tree","enabled":true}');
select pg_temp.ok((select sum((x->>'points')::bigint) from jsonb_array_elements(public.rooted_leader_state('participants')->'rows') x)=28,'theme no ledger changes');
insert into test_ctx select 'device',pg_temp.act('kiosk.issue',jsonb_build_object('event_id',v,'label','Fictional Device','ttl_minutes',10),'10000000-0000-4000-8000-000000000004') from test_ctx where k='event2';
select pg_temp.ok(not(pg_temp.act('kiosk.issue',jsonb_build_object('event_id',v,'label','Fictional Device','ttl_minutes',10),'10000000-0000-4000-8000-000000000004') ? 'device_token'),'kiosk replay omits bearer') from test_ctx where k='event2';
select pg_temp.ok(public.rooted_leader_state('devices')::text not like '%token_hash%' and public.rooted_leader_state('audit')::text not like '%'||(select v->>'device_token' from test_ctx where k='device')||'%','no bearer or hash in leader reads');
set local role service_role;
select pg_temp.denied('select public.rooted_leader_state(''participants'')','42501','service no leader RPC grant');
select pg_temp.denied('select * from rooted.participant_profiles','42501','service no direct private grant');
select pg_temp.ok(public.rooted_kiosk(v->>'device_token','context')->'event'->'id'=(select v from test_ctx where k='event2'),'kiosk fixed event scope') from test_ctx where k='device';
select pg_temp.ok(public.rooted_kiosk(v->>'device_token','search','{"query":"Fictional"}')::text not like '%PRIVATE_SENTINEL%','kiosk search no contacts') from test_ctx where k='device';
select pg_temp.ok(jsonb_array_length(public.rooted_kiosk(v->>'device_token','search','{"query":"%_"}')->'matches')=0,'kiosk search literal metacharacters') from test_ctx where k='device';
select pg_temp.ok((public.rooted_kiosk(v->>'device_token','person',jsonb_build_object('participant_id',(select v from test_ctx where k='newguest')))->>'needs_leader')::boolean,'kiosk first visit flagged') from test_ctx where k='device';
select pg_temp.denied(format('select public.rooted_kiosk(%L,''checkin'',%L::jsonb,gen_random_uuid())',v->>'device_token',jsonb_build_object('participant_id',(select v from test_ctx where k='newguest'),'bible',false,'chapters',0)),'42501','kiosk first visitor denied') from test_ctx where k='device';
select pg_temp.denied(format('select public.rooted_kiosk(%L,''checkin'',%L::jsonb,gen_random_uuid())',v->>'device_token',jsonb_build_object('participant_id',(select v from test_ctx where k='other'),'bible',false,'chapters',0,'event_id',(select v from test_ctx where k='event1'))),'22023','kiosk client event override denied') from test_ctx where k='device';
select pg_temp.denied(format('select public.rooted_kiosk(%L,''friend.award'',''{}'',gen_random_uuid())',v->>'device_token'),'22023','kiosk friend action denied') from test_ctx where k='device';
insert into test_ctx select 'kiosk_receipt',public.rooted_kiosk(v->>'device_token','checkin',jsonb_build_object('participant_id',(select v from test_ctx where k='other'),'bible',false,'chapters',1),'10000000-0000-4000-8000-000000000005') from test_ctx where k='device';
select pg_temp.ok((v#>>'{result,receipt,earned_points}')::integer=7,'kiosk successful scoped checkin') from test_ctx where k='kiosk_receipt';
select pg_temp.ok(public.rooted_kiosk((select v->>'device_token' from test_ctx where k='device'),'checkin',jsonb_build_object('participant_id',(select v from test_ctx where k='other'),'bible',false,'chapters',1),'10000000-0000-4000-8000-000000000005')=v,'kiosk exact replay') from test_ctx where k='kiosk_receipt';
reset role;
select pg_temp.ok((select count(*) from rooted.friend_claims)=1 and (select count(*) from rooted.ledger where kind='friend')=1,'single lifetime friend claim and ledger award');
select pg_temp.ok((select inviter_id is null from rooted.first_visits where participant_id=(select (v#>>'{}')::uuid from test_ctx where k='guest')),'original first visit preserved');
select pg_temp.ok((select sum(points) from rooted.ledger where kind='reading' and participant_id=(select (v#>>'{}')::uuid from test_ctx where k='guest'))=7,'reading lifetime high-water no duplication');
select pg_temp.ok(not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='rooted' and c.relkind='r' and not c.relrowsecurity),'all private tables RLS');
select pg_temp.ok(not exists(select 1 from pg_policies where schemaname='rooted'),'no permissive table policies');
select pg_temp.ok(not exists(select 1 from information_schema.role_table_grants where table_schema='rooted' and grantee in ('anon','authenticated','service_role','PUBLIC')),'no direct table grants');
select pg_temp.denied('update rooted.ledger set reason=''overwrite''','55000','ledger immutable owner update');
select pg_temp.denied('delete from rooted.first_visits','55000','first visits immutable owner delete');
select pg_temp.denied('truncate rooted.audit','55000','audit immutable truncate');
-- Expiry, issuer deactivation and revocation each fail closed with a valid token.
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',true);
update rooted.devices set expires_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '1 hour';
set local role service_role;
select pg_temp.denied(format('select public.rooted_kiosk(%L,''context'')',v->>'device_token'),'42501','expired kiosk denied') from test_ctx where k='device';
reset role;
update rooted.devices set expires_at=clock_timestamp()+interval '1 hour';
update rooted.leaders set active=false;
set local role authenticated;
select pg_temp.denied('select public.rooted_identity()','42501','inactive leader identity denied');
select pg_temp.denied(format('select pg_temp.act(''checkin'',%L::jsonb,''10000000-0000-4000-8000-000000000001'')',v),'42501','inactive leader replay denied') from test_ctx where k='check_payload';
set local role service_role;
select pg_temp.denied(format('select public.rooted_kiosk(%L,''context'')',v->>'device_token'),'42501','inactive issuer kiosk denied') from test_ctx where k='device';
reset role;
update rooted.leaders set active=true;
set local role authenticated;
select pg_temp.act('event.open',jsonb_build_object('event_id',v,'open',false)) from test_ctx where k='event2';
select pg_temp.ok(pg_temp.act('draw',(select v from test_ctx where k='draw_payload'),'10000000-0000-4000-8000-000000000003')=v,'leader draw replay after event closure') from test_ctx where k='draw_receipt';
set local role service_role;
select pg_temp.denied(format('select public.rooted_kiosk(%L,''context'')',v->>'device_token'),'22023','closed event kiosk denied') from test_ctx where k='device';
set local role authenticated;
select pg_temp.act('event.open',jsonb_build_object('event_id',v,'open',true)) from test_ctx where k='event2';
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
select pg_temp.act('kiosk.revoke',jsonb_build_object('device_id',v#>'{result,id}','reason','Fictional revoke')) from test_ctx where k='device';
set local role service_role;
select pg_temp.denied(format('select public.rooted_kiosk(%L,''context'')',v->>'device_token'),'42501','revoked kiosk denied') from test_ctx where k='device';
reset role;
-- Fail if a public definer uses an unsafe search_path or helper inherits EXECUTE.
select pg_temp.ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='rooted' and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE') or has_function_privilege('service_role',p.oid,'EXECUTE'))),'helpers ungranted');
select pg_temp.ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'rooted_%' and (not p.prosecdef or not ('search_path=""'=any(p.proconfig)))),'public RPC definer locked path');
-- Additional edge branches after core balance assertions.
set local role authenticated;
select pg_temp.denied(format('select pg_temp.act(''checkin'',%L::jsonb)',v||'{"attended":false,"bible":true}'),'22023','Bible requires attendance') from test_ctx where k='check_payload';
select pg_temp.denied(format('select pg_temp.act(''checkin'',%L::jsonb)',v||'{"chapters":1.5}'),'22023','fractional chapters denied') from test_ctx where k='check_payload';
select pg_temp.denied(format('select pg_temp.act(''checkin'',%L::jsonb)',v||'{"role":"admin"}'),'22023','forged role field denied') from test_ctx where k='check_payload';
select pg_temp.ok((pg_temp.act('checkin',jsonb_build_object('participant_id',(select v from test_ctx where k='newguest'),'event_id',(select v from test_ctx where k='event1'),'attended',false,'bible',false,'chapters',2))#>>'{result,receipt,earned_points}')::integer=2,'reading-only allowed');
select pg_temp.ok((pg_temp.act('checkin',jsonb_build_object('participant_id',(select v from test_ctx where k='newguest'),'event_id',(select v from test_ctx where k='event2'),'attended',true,'bible',false,'chapters',3,'inviter_id',(select v from test_ctx where k='inviter')))#>>'{result,receipt,earned_points}')::integer=7,'first attendance after reading-only');
select pg_temp.ok((pg_temp.act('friend.award',jsonb_build_object('participant_id',(select v from test_ctx where k='newguest'),'event_id',(select v from test_ctx where k='event2'),'inviter_id',(select v from test_ctx where k='inviter')))#>>'{result,duplicate}')::boolean,'immediate referral prevents deferred double credit');
reset role;
update rooted.leaders set role='leader' where user_id='00000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',true);
select pg_temp.ok(public.rooted_admin_profiles()::text like '%PRIVATE_SENTINEL%','demoted admin retains leader private read');
select pg_temp.denied(format('select pg_temp.act(''profile.update'',%L::jsonb,''10000000-0000-4000-8000-000000000006'')',v||'{"date_of_birth":null,"review_flags":[{"suggested_date_of_birth":"2011-01-01","status":"fictional-review"}]}'),'42501','demoted admin profile replay denied') from test_ctx where k='profile';
reset role;
select pg_temp.ok((select count(*) from rooted.friend_claims)=2 and (select count(*) from rooted.ledger where kind='friend')=2,'immediate and deferred claims share single source');
select pg_temp.ok(not exists(select 1 from rooted.draws d where d.ticket<0 or d.ticket>=d.total_weight or d.total_weight<>(select sum((x->>'weight')::bigint) from jsonb_array_elements(d.weights) x)),'draw snapshot total and ticket bounds');
select pg_temp.ok(not exists(select 1 from rooted.draws d where d.winner_id<>(select (q.x->>'participant_id')::uuid from (select x,sum((x->>'weight')::bigint) over(order by ord) as cumulative from jsonb_array_elements(d.weights) with ordinality a(x,ord)) q where q.cumulative>d.ticket order by q.cumulative limit 1)),'draw ticket maps to saved winner');
select count(*) as passed_assertions,jsonb_agg(label order by label) as passed from test_pass;
