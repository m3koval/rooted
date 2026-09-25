-- Fictional fixtures only; runner encloses migration and this file in ROLLBACK.
create temporary table display_pass(label text primary key);
grant select,insert on display_pass to service_role,anon,authenticated;
create function pg_temp.ok(b boolean,label text) returns void language plpgsql as $$
begin
 if b is distinct from true then raise exception 'FAILED: %',label; end if;
 insert into display_pass values(label);
end $$;
create function pg_temp.denied(statement text,expected text,label text) returns void language plpgsql as $$
declare actual text;
begin
 begin execute statement; exception when others then get stacked diagnostics actual=returned_sqlstate; end;
 perform pg_temp.ok(actual=expected,label);
end $$;
do $$
declare
 uid uuid:=gen_random_uuid(); sid uuid:=gen_random_uuid(); eid uuid:=gen_random_uuid(); old_eid uuid:=gen_random_uuid();
 season uuid:=gen_random_uuid(); old_season uuid:=gen_random_uuid(); a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); did uuid;
 station_token text:=encode(extensions.gen_random_bytes(32),'hex'); token text:=encode(extensions.gen_random_bytes(32),'hex');
 r jsonb; item jsonb; expiry timestamptz; created timestamptz;
begin
 insert into auth.users(id,email) values(uid,'display-rollback-'||uid||'@example.invalid');
 insert into rooted.leaders(user_id,display_name,role) values(uid,'Fictional Display Leader','leader');
 insert into rooted.seasons(id,name,starts_on,ends_on,active) values
 (season,'Fictional Display Season',current_date,current_date+10,true),
 (old_season,'Fictional Display Old Season',current_date-20,current_date-10,false);
 insert into rooted.events(id,season_id,name,date,reading_week,open) values
 (eid,season,'Fictional Display Event',current_date,date_trunc('week',current_date)::date,true),
 (old_eid,old_season,'Fictional Display Old Event',current_date-14,date_trunc('week',current_date-14)::date,false);
 insert into rooted.participants(id,name,previously_attended,breeze_id) values
 (a,'Fictional Display A',true,'private-display-'||a), (b,'Fictional Display B',false,null), (c,'Fictional Display C',true,null);
 insert into rooted.participant_profiles(participant_id,date_of_birth,parent_guardian_name,parent_guardian_email,parent_guardian_phone,review_flags)
 values(a,'2012-01-01','SECRET GUARDIAN','secret@example.invalid','SECRET PHONE','["SECRET FLAG"]');
 insert into rooted.stations(id,event_id,label,token_hash,authorized_by,expires_at)
 values(sid,eid,'Fictional Display Station',extensions.digest(station_token,'sha256'),uid,clock_timestamp()+interval '3 days');
 -- Equivalent station-issued session, without comparing a PIN to real leaders' hashes.
 insert into rooted.devices(event_id,token_hash,label,issued_by,expires_at,station_id,created_at)
 values(eid,extensions.digest(token,'sha256'),'Fictional Display Device',uid,clock_timestamp()+interval '1 hour',sid,clock_timestamp()) returning id,expires_at,created_at into did,expiry,created;
 insert into rooted.checkins(participant_id,event_id,attended,bible,chapters,actor_id) values
 (a,eid,true,false,0,uid),(b,eid,false,false,0,uid),(c,old_eid,true,false,0,uid);
 insert into rooted.ledger(participant_id,event_id,kind,points,source,reason,actor_id) values
 (a,old_eid,'adjustment',30,'display-'||gen_random_uuid(),'SECRET OLD REASON',uid),
 (a,eid,'adjustment',7,'display-'||gen_random_uuid(),'SECRET CURRENT REASON',uid),
 (a,eid,'adjustment',-2,'display-'||gen_random_uuid(),'SECRET NEGATIVE REASON',uid),
 (b,old_eid,'adjustment',-3,'display-'||gen_random_uuid(),'SECRET REASON',uid);
 execute 'set local role service_role';
 r:=public.rooted_display(token);
 perform pg_temp.ok(r->'event'=jsonb_build_object('id',eid,'name','Fictional Display Event','date',current_date),'event is token-scoped minimal projection');
 perform pg_temp.ok(r->>'attendance_count'='1','attendance counts only attended current-event rows');
 perform pg_temp.ok((select array_agg(k order by k)=array['attendance_count','event','participants','updated_at'] from jsonb_object_keys(r) k),'exact top-level field allowlist');
 perform pg_temp.ok((r->>'updated_at')::timestamptz is not null,'updated_at is timestamp');
 perform pg_temp.ok(not exists(select 1 from jsonb_array_elements(r->'participants') p where (select array_agg(k order by k) from jsonb_object_keys(p) k)<>array['id','name','points','present']),'exact participant field allowlist');
 select p into item from jsonb_array_elements(r->'participants') p where p->>'id'=a::text;
 perform pg_temp.ok(item=jsonb_build_object('id',a,'name','Fictional Display A','points',35,'present',true),'lifetime sums include closed season plus negative adjustment');
 select p into item from jsonb_array_elements(r->'participants') p where p->>'id'=b::text;
 perform pg_temp.ok(item=jsonb_build_object('id',b,'name','Fictional Display B','points',-3,'present',false),'negative totals preserved and nonattendance row absent');
 select p into item from jsonb_array_elements(r->'participants') p where p->>'id'=c::text;
 perform pg_temp.ok(item=jsonb_build_object('id',c,'name','Fictional Display C','points',0,'present',false),'zero-ledger participant included and past attendance not current');
 perform pg_temp.ok(r::text not like '%SECRET%' and r::text not like '%secret@example.invalid%' and r::text not like '%private-display-%','no DOB contact external IDs flags or ledger reasons exposed');
 perform pg_temp.ok(not exists(select 1 from (select (p->>'points')::bigint pts,lag((p->>'points')::bigint) over(order by ord) prev from jsonb_array_elements(r->'participants') with ordinality v(p,ord)) q where pts>prev),'leaderboard ordered by descending lifetime points');
 perform pg_temp.denied('select public.rooted_display(null)','42501','null token denied');
 perform pg_temp.denied('select public.rooted_display(''bad'')','42501','malformed token denied');
 perform pg_temp.denied(format('select public.rooted_display(%L)',encode(extensions.gen_random_bytes(32),'hex')),'42501','unknown token denied');
 execute 'reset role';
 execute 'set local role anon';
 perform pg_temp.denied(format('select public.rooted_display(%L)',token),'42501','anon cannot execute with valid token');
 execute 'reset role'; execute 'set local role authenticated';
 perform pg_temp.denied(format('select public.rooted_display(%L)',token),'42501','authenticated cannot execute with valid token');
 execute 'reset role';
 update rooted.devices set revoked_at=clock_timestamp(),revoked_by=uid where id=did;
 execute 'set local role service_role';
 perform pg_temp.denied(format('select public.rooted_display(%L)',token),'42501','revoked device denied on next read');
 execute 'reset role';
 update rooted.devices set revoked_at=null,revoked_by=null,created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' where id=did;
 execute 'set local role service_role';
 perform pg_temp.denied(format('select public.rooted_display(%L)',token),'42501','expired device denied on next read');
 execute 'reset role';
 update rooted.devices set created_at=clock_timestamp()-interval '2 days',expires_at=expiry where id=did;
 execute 'set local role service_role';
 perform pg_temp.denied(format('select public.rooted_display(%L)',token),'42501','old-day prolonged device denied');
 execute 'reset role';
 update rooted.devices set created_at=created,station_id=null where id=did;
 execute 'set local role service_role';
 perform pg_temp.denied(format('select public.rooted_display(%L)',token),'42501','non-PIN legacy device denied');
 execute 'reset role'; update rooted.devices set station_id=sid where id=did;
 update rooted.stations set revoked_at=clock_timestamp(),revoked_by=uid where id=sid;
 execute 'set local role service_role';
 perform pg_temp.denied(format('select public.rooted_display(%L)',token),'42501','revoked station denied');
 execute 'reset role';
 update rooted.stations set revoked_at=null,revoked_by=null,created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' where id=sid;
 execute 'set local role service_role';
 perform pg_temp.denied(format('select public.rooted_display(%L)',token),'42501','expired station denied');
 execute 'reset role'; update rooted.stations set expires_at=clock_timestamp()+interval '3 days' where id=sid;
 update rooted.events set open=false where id=eid;
 execute 'set local role service_role';
 perform pg_temp.denied(format('select public.rooted_display(%L)',token),'22023','closed event denied');
 execute 'reset role'; update rooted.events set open=true where id=eid;
 update rooted.seasons set active=false where id=season;
 execute 'set local role service_role';
 perform pg_temp.denied(format('select public.rooted_display(%L)',token),'22023','inactive season denied');
 execute 'reset role'; update rooted.seasons set active=true where id=season;
 update rooted.leaders set active=false where user_id=uid;
 execute 'set local role service_role';
 perform pg_temp.denied(format('select public.rooted_display(%L)',token),'42501','inactive issuing leader denied');
 execute 'reset role';
end $$;
select pg_temp.ok(has_function_privilege('service_role','public.rooted_display(text)','execute') and not has_function_privilege('anon','public.rooted_display(text)','execute') and not has_function_privilege('authenticated','public.rooted_display(text)','execute'),'service-only RPC ACL');
select count(*) as passed_assertions,jsonb_agg(label order by label) as passed from display_pass;
