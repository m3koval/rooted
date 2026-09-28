-- Explicit one-time administrator cleanup of an old manual check-in workaround.
-- Never infer intent from reason text; normal leader edits remain independent.
begin;
create table rooted.checkin_adjustment_repairs (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null unique references rooted.requests(id) deferrable initially deferred,
 adjustment_id uuid not null unique references rooted.ledger(id),
 reversal_id uuid not null unique references rooted.ledger(id),
 checkin_id uuid not null references rooted.checkins(id),
 participant_id uuid not null references rooted.participants(id),
 event_id uuid not null references rooted.events(id),
 correction_request_id uuid not null unique references rooted.requests(id),
 revision_id uuid not null unique references rooted.checkin_revisions(id),
 original_points integer not null check(original_points between -100000 and 100000 and original_points<>0),
 actor_id uuid not null references rooted.leaders(user_id),
 admin_reviewed boolean not null default true check(admin_reviewed),
 created_at timestamptz not null default clock_timestamp(),
 check(adjustment_id<>reversal_id), check(request_id<>correction_request_id)
);
alter table rooted.checkin_adjustment_repairs enable row level security;
revoke all on rooted.checkin_adjustment_repairs from public,anon,authenticated,service_role;
create trigger immutable_rows before update or delete on rooted.checkin_adjustment_repairs for each row execute function rooted.immutable();
create trigger immutable_truncate before truncate on rooted.checkin_adjustment_repairs for each statement execute function rooted.immutable();

create function public.rooted_reconcile_checkin_adjustment(p_request_id uuid,p_adjustment_id uuid,p_checkin_id uuid,p_expected_revision uuid,p_attended boolean,p_bible boolean,p_chapters integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; payload jsonb; replay jsonb; c rooted.effective_checkins%rowtype;
 selected rooted.ledger%rowtype; child uuid; corrected jsonb; repair uuid:=gen_random_uuid(); reversal uuid:=gen_random_uuid();
begin
 perform rooted.lock_app(); actor:=rooted.require_admin();
 payload:=jsonb_build_object('adjustment_id',p_adjustment_id,'checkin_id',p_checkin_id,'expected_revision',p_expected_revision,'attended',p_attended,'bible',p_bible,'chapters',p_chapters);
 replay:=rooted.replay(p_request_id,actor,'leader','checkin.reconcile_adjustment',payload);
 if replay is not null then return replay; end if;
 select x.* into c from rooted.effective_checkins x where x.id=p_checkin_id;
 if not found then raise exception using errcode='22023',message='Check-in not found'; end if;
 select x.* into selected from rooted.ledger x where x.id=p_adjustment_id;
 if not found then raise exception using errcode='22023',message='Select an original manual adjustment'; end if;
 if selected.kind<>'adjustment' or selected.participant_id<>c.participant_id or selected.event_id<>c.event_id
    or (selected.checkin_id is not null and selected.checkin_id<>c.id)
    or starts_with(selected.source,'checkin.reconcile_adjustment:')
    or exists(select 1 from rooted.checkin_adjustment_repairs x where x.reversal_id=selected.id) then
  raise exception using errcode='22023',message='Select an original manual adjustment for this check-in person and event, not a repair reversal';
 end if;
 if exists(select 1 from rooted.checkin_adjustment_repairs x where x.adjustment_id=selected.id) then
  raise exception using errcode='23505',message='This manual adjustment has already been reconciled';
 end if;
 -- Namespaced deterministic UUID; guarantee distinctness even for a hash fixed point.
 child:=md5('rooted:checkin.reconcile_adjustment:correction:'||p_request_id::text)::uuid;
 if child=p_request_id then child:=md5('rooted:checkin.reconcile_adjustment:fallback:'||p_request_id::text)::uuid; end if;
 if child=p_request_id or exists(select 1 from rooted.requests x where x.id=child) then
  raise exception using errcode='23505',message='Correction request key conflict; use a new repair request';
 end if;
 -- Same-person only. Child CAS and every reversal/audit write share this transaction.
 corrected:=public.rooted_correct_checkin(child,c.id,p_expected_revision,c.participant_id,p_attended,p_bible,p_chapters);
 insert into rooted.ledger(id,participant_id,event_id,checkin_id,kind,points,source,reason,actor_id)
 values(reversal,c.participant_id,c.event_id,c.id,'adjustment',-selected.points,
 'checkin.reconcile_adjustment:'||selected.id,'Administrator reviewed explicit old workaround adjustment '||selected.id||'; full reversal',actor);
 insert into rooted.checkin_adjustment_repairs(id,request_id,adjustment_id,reversal_id,checkin_id,participant_id,event_id,correction_request_id,revision_id,original_points,actor_id,admin_reviewed)
 values(repair,p_request_id,selected.id,reversal,c.id,c.participant_id,c.event_id,child,(corrected#>>'{result,revision_id}')::uuid,selected.points,actor,true);
 return rooted.finish(p_request_id,actor,'leader','checkin.reconcile_adjustment',payload,
 jsonb_build_object('repair_id',repair,'adjustment_id',selected.id,'reversal_id',reversal,'reversal_points',-selected.points,
 'checkin_id',c.id,'participant_id',c.participant_id,'event_id',c.event_id,'revision_id',corrected#>'{result,revision_id}',
 'correction_request_id',child,'correction',corrected->'result','admin_reviewed',true));
end $$;
revoke all on function public.rooted_reconcile_checkin_adjustment(uuid,uuid,uuid,uuid,boolean,boolean,integer) from public,anon,authenticated,service_role;
grant execute on function public.rooted_reconcile_checkin_adjustment(uuid,uuid,uuid,uuid,boolean,boolean,integer) to authenticated;

create function public.rooted_checkin_adjustment_repairs(p_limit integer default 100,p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path='' as $$
declare rows jsonb;
begin
 perform rooted.lock_app(); perform rooted.require_admin();
 if p_limit is null or p_limit not between 1 and 500 or p_offset is null or p_offset not between 0 and 1000000 then
  raise exception using errcode='22023',message='Invalid pagination';
 end if;
 select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into rows from
 (select x.* from rooted.checkin_adjustment_repairs x order by x.id limit p_limit offset p_offset) q;
 return jsonb_build_object('rows',rows,'limit',p_limit,'offset',p_offset);
end $$;
revoke all on function public.rooted_checkin_adjustment_repairs(integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.rooted_checkin_adjustment_repairs(integer,integer) to authenticated;
commit;
