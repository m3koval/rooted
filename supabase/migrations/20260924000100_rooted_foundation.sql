-- Rooted foundation: local/reviewable migration, no accounts or real participant seed.
-- PostgreSQL 15+ / Supabase. Apply as the migration owner, not a browser role.
begin;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema rooted;
revoke all on schema rooted from public, anon, authenticated, service_role;
alter default privileges in schema rooted revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema rooted revoke execute on functions from public, anon, authenticated, service_role;

create table rooted.leaders (
  user_id uuid primary key references auth.users(id),
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  role text not null check (role in ('admin','leader')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table rooted.seasons (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 100),
  starts_on date not null, ends_on date not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create table rooted.participants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  previously_attended boolean not null,
  breeze_id text unique check (length(breeze_id) between 1 and 80),
  created_at timestamptz not null default now()
);
create table rooted.events (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references rooted.seasons(id),
  name text not null check (length(btrim(name)) between 1 and 100),
  date date not null,
  reading_week date not null check (extract(isodow from reading_week) = 1),
  open boolean not null default true,
  created_at timestamptz not null default now()
);
-- Admin-only child/contact details. Never include in ordinary state or kiosk.
create table rooted.participant_profiles (
  participant_id uuid primary key references rooted.participants(id),
  date_of_birth date check (date_of_birth >= date '1900-01-01' and date_of_birth <= current_date),
  parent_guardian_name text check (length(parent_guardian_name) <= 160),
  parent_guardian_email text check (length(parent_guardian_email) <= 254),
  parent_guardian_phone text check (length(parent_guardian_phone) <= 80),
  review_flags jsonb not null default '[]'::jsonb check (jsonb_typeof(review_flags)='array' and octet_length(review_flags::text)<=4000),
  updated_at timestamptz not null default now()
);
create index events_season_idx on rooted.events(season_id);
create table rooted.rates (
  id boolean primary key default true check (id),
  attendance integer not null default 5 check (attendance between 0 and 1000),
  bible integer not null default 2 check (bible between 0 and 1000),
  friend integer not null default 10 check (friend between 0 and 1000)
);
insert into rooted.rates(id) values(true);
-- Theme deliberately has no season FK and no scoring fields.
create table rooted.theme (
  id boolean primary key default true check (id),
  name text not null check (length(btrim(name)) between 1 and 60),
  study text not null check (length(btrim(study)) between 1 and 80),
  tagline text not null check (length(btrim(tagline)) between 1 and 160),
  scripture text not null check (length(scripture) <= 80),
  artwork text not null check (artwork in ('tree','badge','wide')),
  enabled boolean not null
);
insert into rooted.theme values(true,'REAL','James','Real Faith. Real Life. Real Fruit.','James 1:22','tree',true);
create table rooted.devices (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references rooted.events(id),
  token_hash bytea not null unique check (octet_length(token_hash)=32),
  label text not null check (length(btrim(label)) between 1 and 80),
  issued_by uuid not null references rooted.leaders(user_id),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references rooted.leaders(user_id),
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check ((revoked_at is null) = (revoked_by is null))
);
create table rooted.checkins (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references rooted.participants(id),
  event_id uuid not null references rooted.events(id),
  attended boolean not null, bible boolean not null,
  chapters integer not null check (chapters between 0 and 100000),
  inviter_id uuid references rooted.participants(id),
  actor_id uuid references rooted.leaders(user_id),
  device_id uuid references rooted.devices(id),
  created_at timestamptz not null default now(),
  unique (participant_id,event_id),
  check (not bible or attended), check (inviter_id <> participant_id),
  check ((actor_id is null) <> (device_id is null))
);
create index checkins_event_idx on rooted.checkins(event_id);
-- A participant/week high-water mark is global, even across season boundaries.
create table rooted.reading_totals (
  participant_id uuid not null references rooted.participants(id),
  week date not null check (extract(isodow from week)=1),
  chapters integer not null check (chapters between 0 and 100000),
  primary key (participant_id,week)
);
create table rooted.first_visits (
  participant_id uuid primary key references rooted.participants(id),
  event_id uuid not null references rooted.events(id),
  inviter_id uuid references rooted.participants(id),
  checkin_id uuid not null unique references rooted.checkins(id),
  check (inviter_id <> participant_id)
);
create table rooted.ledger (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references rooted.participants(id),
  event_id uuid not null references rooted.events(id),
  checkin_id uuid references rooted.checkins(id),
  kind text not null check (kind in ('attendance','bible','friend','reading','adjustment')),
  points integer not null check (points between -100000 and 100000),
  source text not null unique,
  reason text not null check (length(btrim(reason)) between 1 and 500),
  actor_id uuid references rooted.leaders(user_id),
  device_id uuid references rooted.devices(id),
  created_at timestamptz not null default now(),
  check (kind='adjustment' or points >= 0),
  check (kind<>'adjustment' or (actor_id is not null and device_id is null and points<>0)),
  check ((actor_id is null) <> (device_id is null))
);
-- Separate immutable referral claim preserves the original first-visit record.
create table rooted.friend_claims (
  participant_id uuid primary key references rooted.first_visits(participant_id),
  inviter_id uuid not null references rooted.participants(id),
  event_id uuid not null references rooted.events(id),
  checkin_id uuid not null references rooted.checkins(id),
  actor_id uuid not null references rooted.leaders(user_id),
  points integer not null check (points between 0 and 1000),
  created_at timestamptz not null default now(),
  check (participant_id <> inviter_id)
);
create index ledger_participant_idx on rooted.ledger(participant_id);
create index ledger_event_idx on rooted.ledger(event_id);
create index ledger_checkin_idx on rooted.ledger(checkin_id);
create table rooted.draws (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  event_id uuid not null references rooted.events(id),
  prize text not null check (length(btrim(prize)) between 1 and 120),
  present_only boolean not null, one_win boolean not null,
  winner_id uuid not null references rooted.participants(id),
  winner_name text not null,
  weights jsonb not null check (jsonb_typeof(weights)='array'),
  total_weight bigint not null check (total_weight>0),
  ticket bigint not null check (ticket>=0 and ticket<total_weight),
  actor_id uuid not null references rooted.leaders(user_id),
  created_at timestamptz not null default now()
);
create index draws_event_idx on rooted.draws(event_id);
create table rooted.requests (
  id uuid primary key,
  subject_id uuid not null,
  subject_kind text not null check (subject_kind in ('leader','device')),
  action text not null,
  payload jsonb not null,
  response jsonb not null,
  created_at timestamptz not null default now()
);
create table rooted.audit (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references rooted.requests(id),
  actor_id uuid references rooted.leaders(user_id),
  device_id uuid references rooted.devices(id),
  action text not null, details jsonb not null,
  created_at timestamptz not null default now(),
  check ((actor_id is null) <> (device_id is null))
);

create function rooted.immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception using errcode='55000',message='Append-only Rooted history'; end;
$$;
do $$
declare t text;
begin
  foreach t in array array['leaders','seasons','participants','participant_profiles','events','rates','theme','devices','checkins','reading_totals','first_visits','friend_claims','ledger','draws','requests','audit'] loop
    execute format('alter table rooted.%I enable row level security',t);
  end loop;
  foreach t in array array['checkins','first_visits','friend_claims','ledger','draws','requests','audit'] loop
    execute format('create trigger immutable_rows before update or delete on rooted.%I for each row execute function rooted.immutable()',t);
    execute format('create trigger immutable_truncate before truncate on rooted.%I for each statement execute function rooted.immutable()',t);
  end loop;
end;
$$;
-- No policies: browser roles cannot select/write private relations. Definers own
-- their tables; FORCE RLS would defeat these deliberately narrow entry points.
revoke all on all tables in schema rooted from public, anon, authenticated, service_role;
revoke all on all sequences in schema rooted from public, anon, authenticated, service_role;

create function rooted.lock_app() returns void language sql set search_path='' as $$
  select pg_catalog.pg_advisory_xact_lock(724019260924::bigint);
$$;
create function rooted.require_leader() returns uuid language plpgsql set search_path='' as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception using errcode='42501',message='Leader sign-in required'; end if;
  perform 1 from rooted.leaders l where l.user_id=u and l.active for share;
  if not found then raise exception using errcode='42501',message='Active leader assignment required'; end if;
  return u;
end;
$$;
create function rooted.require_admin() returns uuid language plpgsql set search_path='' as $$
declare u uuid := rooted.require_leader();
begin
  if not exists(select 1 from rooted.leaders l where l.user_id=u and l.role='admin') then
    raise exception using errcode='42501',message='Administrator assignment required';
  end if;
  return u;
end;
$$;
create function public.rooted_identity() returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid; result jsonb;
begin
  perform rooted.lock_app(); u:=rooted.require_leader();
  select jsonb_build_object('actor_id',l.user_id,'role',l.role,'display_name',l.display_name) into result from rooted.leaders l where l.user_id=u;
  return result;
end;
$$;
create function public.rooted_admin_profiles(p_limit integer default 100,p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform rooted.lock_app(); perform rooted.require_admin();
  if p_limit is null or p_limit not between 1 and 500 or p_offset is null or p_offset not between 0 and 1000000 then
    raise exception using errcode='22023',message='Invalid pagination';
  end if;
  select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into result from (
    select p.id as participant_id,x.date_of_birth,x.parent_guardian_name,x.parent_guardian_email,x.parent_guardian_phone,coalesce(x.review_flags,'[]'::jsonb) as review_flags
    from rooted.participants p left join rooted.participant_profiles x on x.participant_id=p.id order by p.id limit p_limit offset p_offset
  ) q;
  return jsonb_build_object('rows',result,'limit',p_limit,'offset',p_offset);
end;
$$;
create function rooted.keys(p jsonb, required text[], optional text[] default '{}'::text[]) returns void language plpgsql set search_path='' as $$
begin
  if p is null or jsonb_typeof(p)<>'object' or not (p ?& required)
    or exists(select 1 from jsonb_object_keys(p) k where not(k=any(required||optional))) then
    raise exception using errcode='22023',message='Unexpected or missing payload fields';
  end if;
end;
$$;
create function rooted.txt(p jsonb,k text,n integer,blank boolean default false) returns text language plpgsql set search_path='' as $$
declare v text := regexp_replace(p->>k,'^[[:space:]]+|[[:space:]]+$','','g');
begin
  if jsonb_typeof(p->k) is distinct from 'string' or length(p->>k)>n or (not blank and length(v)=0) then
    raise exception using errcode='22023',message='Invalid text field: '||k;
  end if;
  return v;
end;
$$;
create function rooted.num(p jsonb,k text,lo integer,hi integer) returns integer language plpgsql set search_path='' as $$
declare v numeric;
begin
  if jsonb_typeof(p->k) is distinct from 'number' then raise exception using errcode='22023',message='Integer required: '||k; end if;
  v := (p->>k)::numeric;
  if v<>trunc(v) or v<lo or v>hi then raise exception using errcode='22023',message='Integer out of bounds: '||k; end if;
  return v::integer;
end;
$$;
create function rooted.flag(p jsonb,k text) returns boolean language plpgsql set search_path='' as $$
begin
  if jsonb_typeof(p->k) is distinct from 'boolean' then raise exception using errcode='22023',message='Boolean required: '||k; end if;
  return (p->>k)::boolean;
end;
$$;
create function rooted.uid(p jsonb,k text) returns uuid language plpgsql set search_path='' as $$
begin return rooted.txt(p,k,36)::uuid; end;
$$;
create function rooted.day(p jsonb,k text) returns date language plpgsql set search_path='' as $$
declare v text := rooted.txt(p,k,10); d date;
begin
  if v !~ '^\d{4}-\d{2}-\d{2}$' then raise exception using errcode='22023',message='ISO date required'; end if;
  d:=v::date; return d;
end;
$$;
create function rooted.replay(r uuid,s uuid,sk text,a text,p jsonb) returns jsonb language plpgsql set search_path='' as $$
declare old rooted.requests%rowtype;
begin
  if r is null then raise exception using errcode='22023',message='request_id UUID required'; end if;
  select q.* into old from rooted.requests q where q.id=r;
  if found then
    if old.subject_id is distinct from s or old.subject_kind is distinct from sk or old.action is distinct from a or old.payload is distinct from p then
      raise exception using errcode='23505',message='Idempotency key payload/actor conflict';
    end if;
    return old.response;
  end if;
  return null;
end;
$$;
create function rooted.finish(r uuid,s uuid,sk text,a text,p jsonb,result jsonb) returns jsonb language plpgsql set search_path='' as $$
declare response jsonb := jsonb_build_object('request_id',r,'action',a,'result',result);
begin
  insert into rooted.requests(id,subject_id,subject_kind,action,payload,response) values(r,s,sk,a,p,response);
  insert into rooted.audit(request_id,actor_id,device_id,action,details)
    values(r,case when sk='leader' then s end,case when sk='device' then s end,a,jsonb_build_object('payload',p,'result',result));
  return response;
end;
$$;
create function rooted.require_open(e uuid) returns rooted.events language plpgsql set search_path='' as $$
declare v rooted.events%rowtype;
begin
  select x.* into v from rooted.events x join rooted.seasons s on s.id=x.season_id where x.id=e and x.open and s.active;
  if not found then raise exception using errcode='22023',message='Open event in active season required'; end if;
  return v;
end;
$$;
create function rooted.receipt(c uuid) returns jsonb language sql set search_path='' as $$
  select jsonb_build_object('checkin_id',c,'earned_points',coalesce(sum(x.points),0),
    'components',coalesce(jsonb_agg(jsonb_build_object('label',case x.kind when 'attendance' then 'Attendance' when 'bible' then 'Brought Bible' else 'Bible reading' end,'points',x.points) order by x.kind),'[]'::jsonb))
  from rooted.ledger x where x.checkin_id=c and x.kind in ('attendance','bible','reading');
$$;
create function rooted.award(pid uuid,eid uuid,cid uuid,k text,n integer,src text,note text,actor uuid,device uuid) returns void language sql set search_path='' as $$
  insert into rooted.ledger(participant_id,event_id,checkin_id,kind,points,source,reason,actor_id,device_id)
    values(pid,eid,cid,k,n,src,note,actor,device);
$$;
create function rooted.friend_award(p jsonb,actor uuid) returns jsonb language plpgsql set search_path='' as $$
declare pid uuid; eid uuid; inviter uuid; visit rooted.first_visits%rowtype; old rooted.friend_claims%rowtype; n integer;
begin
  perform rooted.keys(p,array['participant_id','event_id','inviter_id']);
  pid:=rooted.uid(p,'participant_id'); eid:=rooted.uid(p,'event_id'); inviter:=rooted.uid(p,'inviter_id');
  if pid=inviter then raise exception using errcode='22023',message='Self-referral is not allowed'; end if;
  if not exists(select 1 from rooted.participants x where x.id=pid and not x.previously_attended) then
    raise exception using errcode='22023',message='First-time guest required';
  end if;
  select f.* into visit from rooted.first_visits f where f.participant_id=pid and f.event_id=eid;
  if not found then raise exception using errcode='22023',message='Recorded first attendance in this event required'; end if;
  select f.* into old from rooted.friend_claims f where f.participant_id=pid;
  if found then
    if old.inviter_id<>inviter then raise exception using errcode='23505',message='Referral already claimed by another inviter'; end if;
    return jsonb_build_object('participant_id',pid,'event_id',eid,'inviter_id',inviter,'points',old.points,'duplicate',true);
  end if;
  select r.friend into n from rooted.rates r where r.id;
  insert into rooted.friend_claims(participant_id,event_id,inviter_id,checkin_id,actor_id,points) values(pid,eid,inviter,visit.checkin_id,actor,n);
  perform rooted.award(inviter,eid,visit.checkin_id,'friend',n,'friend:'||pid,'First attended visit referral',actor,null);
  return jsonb_build_object('participant_id',pid,'event_id',eid,'inviter_id',inviter,'points',n,'duplicate',false);
end;
$$;
create function rooted.checkin(p jsonb,actor uuid,device uuid) returns jsonb language plpgsql set search_path='' as $$
declare
  pid uuid := rooted.uid(p,'participant_id'); eid uuid := rooted.uid(p,'event_id');
  attending boolean := rooted.flag(p,'attended'); bible boolean := rooted.flag(p,'bible');
  chapters integer := rooted.num(p,'chapters',0,100000); inviter uuid;
  person rooted.participants%rowtype; ev rooted.events%rowtype; old rooted.checkins%rowtype;
  config rooted.rates%rowtype; cid uuid; prior integer;
begin
  perform rooted.keys(p,array['participant_id','event_id','attended','bible','chapters'],array['inviter_id']);
  if p ? 'inviter_id' and p->'inviter_id'<>'null'::jsonb then inviter:=rooted.uid(p,'inviter_id'); end if;
  if inviter=pid or (bible and not attending) then raise exception using errcode='22023',message='Invalid attendance/Bible/inviter combination'; end if;
  select x.* into person from rooted.participants x where x.id=pid;
  if not found then raise exception using errcode='22023',message='Participant not found'; end if;
  if inviter is not null and not exists(select 1 from rooted.participants x where x.id=inviter) then raise exception using errcode='22023',message='Inviter not found'; end if;
  select c.* into old from rooted.checkins c where c.participant_id=pid and c.event_id=eid;
  if device is not null and ((old.id is not null and not old.attended) or
      (old.id is null and not person.previously_attended and not exists(select 1 from rooted.first_visits f where f.participant_id=pid))) then
    raise exception using errcode='42501',message='First-time visitor or reading-only correction needs a leader';
  end if;
  if old.id is not null then
    if row(old.attended,old.bible,old.chapters,old.inviter_id) is distinct from row(attending,bible,chapters,inviter) then
      raise exception using errcode='23505',message='Check-in is locked; use an audited adjustment';
    end if;
    return jsonb_build_object('duplicate',true,'receipt',rooted.receipt(old.id));
  end if;
  ev:=rooted.require_open(eid);
  select x.* into config from rooted.rates x where x.id;
  insert into rooted.checkins(participant_id,event_id,attended,bible,chapters,inviter_id,actor_id,device_id)
    values(pid,eid,attending,bible,chapters,inviter,actor,device) returning id into cid;
  if attending then
    perform rooted.award(pid,eid,cid,'attendance',config.attendance,'attendance:'||cid,'Attended',actor,device);
    if bible then perform rooted.award(pid,eid,cid,'bible',config.bible,'bible:'||cid,'Brought Bible',actor,device); end if;
    if not exists(select 1 from rooted.first_visits f where f.participant_id=pid) then
      insert into rooted.first_visits(participant_id,event_id,inviter_id,checkin_id) values(pid,eid,inviter,cid);
      if inviter is not null and not person.previously_attended then
        perform rooted.friend_award(jsonb_build_object('participant_id',pid,'event_id',eid,'inviter_id',inviter),actor);
      end if;
    end if;
  end if;
  select x.chapters into prior from rooted.reading_totals x where x.participant_id=pid and x.week=ev.reading_week;
  prior:=coalesce(prior,0);
  if chapters>prior then
    insert into rooted.reading_totals(participant_id,week,chapters) values(pid,ev.reading_week,chapters)
      on conflict on constraint reading_totals_pkey do update set chapters=excluded.chapters;
    perform rooted.award(pid,eid,cid,'reading',chapters-prior,'reading:'||cid,'Cumulative weekly chapters: '||prior||' to '||chapters||'; fixed 1 point/chapter',actor,device);
  end if;
  return jsonb_build_object('duplicate',false,'receipt',rooted.receipt(cid));
end;
$$;
-- Exact rejection sampling over a cryptographic 64-bit integer, not random(),
-- floating-point multiplication, or modulo without a rejection threshold.
create function rooted.randbelow(n bigint) returns bigint language plpgsql set search_path='' as $$
declare b bytea; v numeric; ceiling numeric; i integer;
begin
  if n is null or n<=0 then raise exception 'Positive random bound required'; end if;
  ceiling:=18446744073709551616::numeric-mod(18446744073709551616::numeric,n::numeric);
  loop
    b:=extensions.gen_random_bytes(8); v:=0;
    for i in 0..7 loop v:=v*256+get_byte(b,i); end loop;
    if v<ceiling then return mod(v,n::numeric)::bigint; end if;
  end loop;
end;
$$;
create function rooted.draw(r uuid,p jsonb,actor uuid) returns jsonb language plpgsql set search_path='' as $$
declare
  eid uuid := rooted.uid(p,'event_id'); prize text := rooted.txt(p,'prize',120);
  present boolean := rooted.flag(p,'present_only'); one_win boolean := rooted.flag(p,'one_win');
  ev rooted.events%rowtype; pool jsonb; total bigint; ticket bigint; cumulative bigint:=0;
  item jsonb; winner jsonb; saved rooted.draws%rowtype;
begin
  perform rooted.keys(p,array['event_id','prize','present_only','one_win']);
  ev:=rooted.require_open(eid);
  select jsonb_agg(jsonb_build_object('participant_id',q.id,'name',q.name,'weight',q.weight) order by q.id),sum(q.weight)::bigint
    into pool,total
  from (
    select person.id,person.name,sum(l.points)::bigint as weight
    from rooted.participants person join rooted.ledger l on l.participant_id=person.id
    where (not present or exists(select 1 from rooted.checkins c where c.event_id=eid and c.participant_id=person.id and c.attended))
      and (not one_win or not exists(select 1 from rooted.draws d where d.event_id=eid and d.winner_id=person.id))
    group by person.id,person.name having sum(l.points)>0
  ) q;
  if total is null or total<=0 then raise exception using errcode='22023',message='No eligible positive-point entries'; end if;
  ticket:=rooted.randbelow(total);
  for item in select value from jsonb_array_elements(pool) loop
    cumulative:=cumulative+(item->>'weight')::bigint;
    if ticket<cumulative then winner:=item; exit; end if;
  end loop;
  insert into rooted.draws(request_id,event_id,prize,present_only,one_win,winner_id,winner_name,weights,total_weight,ticket,actor_id)
    values(r,eid,prize,present,one_win,(winner->>'participant_id')::uuid,winner->>'name',pool,total,ticket,actor) returning * into saved;
  return to_jsonb(saved);
end;
$$;

-- Authenticated leader command bus; assignments themselves are NEVER commands.
create function public.rooted_leader_mutate(p_request_id uuid,p_action text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor uuid; replay jsonb; result jsonb; target uuid; sid uuid; eid uuid; pid uuid;
  d date; start_day date; end_day date; n integer; token text; ttl integer;
  ev rooted.events%rowtype; device rooted.devices%rowtype;
begin
  perform rooted.lock_app(); actor:=rooted.require_leader();
  if p_action is null or p_payload is null then raise exception using errcode='22023',message='Action and payload required'; end if;
  if p_action='profile.update' then perform rooted.require_admin(); end if;
  replay:=rooted.replay(p_request_id,actor,'leader',p_action,p_payload);
  if replay is not null then return replay; end if;
  case p_action
  when 'participant.create' then
    perform rooted.keys(p_payload,array['name','previously_attended'],array['breeze_id']);
    insert into rooted.participants(name,previously_attended,breeze_id)
      values(rooted.txt(p_payload,'name',80),rooted.flag(p_payload,'previously_attended'),
        case when p_payload ? 'breeze_id' and p_payload->'breeze_id'<>'null'::jsonb then rooted.txt(p_payload,'breeze_id',80) end)
      returning id into target;
    result:=jsonb_build_object('id',target);
  when 'season.create' then
    perform rooted.keys(p_payload,array['name','starts_on','ends_on']);
    insert into rooted.seasons(name,starts_on,ends_on) values(rooted.txt(p_payload,'name',100),rooted.day(p_payload,'starts_on'),rooted.day(p_payload,'ends_on')) returning id into target;
    result:=jsonb_build_object('id',target);
  when 'season.active' then
    perform rooted.keys(p_payload,array['season_id','active']);
    target:=rooted.uid(p_payload,'season_id');
    update rooted.seasons s set active=rooted.flag(p_payload,'active') where s.id=target;
    if not found then raise exception using errcode='22023',message='Season not found'; end if;
    result:=jsonb_build_object('id',target,'active',p_payload->'active');
  when 'event.create' then
    perform rooted.keys(p_payload,array['season_id','name','date','reading_week']);
    sid:=rooted.uid(p_payload,'season_id'); d:=rooted.day(p_payload,'date');
    select s.starts_on,s.ends_on into start_day,end_day from rooted.seasons s where s.id=sid and s.active;
    if not found or d<start_day or d>end_day then raise exception using errcode='22023',message='Event must fall within an active season'; end if;
    insert into rooted.events(season_id,name,date,reading_week)
      values(sid,rooted.txt(p_payload,'name',100),d,rooted.day(p_payload,'reading_week')) returning id into target;
    result:=jsonb_build_object('id',target);
  when 'event.open' then
    perform rooted.keys(p_payload,array['event_id','open']); target:=rooted.uid(p_payload,'event_id');
    update rooted.events e set open=rooted.flag(p_payload,'open') where e.id=target;
    if not found then raise exception using errcode='22023',message='Event not found'; end if;
    result:=jsonb_build_object('id',target,'open',p_payload->'open');
  when 'rates.update' then
    perform rooted.keys(p_payload,array['attendance','bible','friend']);
    update rooted.rates set attendance=rooted.num(p_payload,'attendance',0,1000),bible=rooted.num(p_payload,'bible',0,1000),friend=rooted.num(p_payload,'friend',0,1000) where id;
    select to_jsonb(x)-'id' into result from rooted.rates x where x.id;
  when 'theme.update' then
    perform rooted.keys(p_payload,array['name','study','tagline','scripture','artwork','enabled']);
    if p_payload->>'artwork' not in ('tree','badge','wide') then raise exception using errcode='22023',message='Invalid artwork'; end if;
    update rooted.theme set name=rooted.txt(p_payload,'name',60),study=rooted.txt(p_payload,'study',80),tagline=rooted.txt(p_payload,'tagline',160),
      scripture=rooted.txt(p_payload,'scripture',80,true),artwork=rooted.txt(p_payload,'artwork',5),enabled=rooted.flag(p_payload,'enabled') where id;
    select to_jsonb(x)-'id' into result from rooted.theme x where x.id;
  when 'profile.update' then
    perform rooted.keys(p_payload,array['participant_id','date_of_birth','parent_guardian_name','parent_guardian_email','parent_guardian_phone','review_flags']);
    pid:=rooted.uid(p_payload,'participant_id');
    if jsonb_typeof(p_payload->'review_flags') is distinct from 'array' or octet_length((p_payload->'review_flags')::text)>4000 then
      raise exception using errcode='22023',message='Review flags must be a bounded JSON array';
    end if;
    insert into rooted.participant_profiles(participant_id,date_of_birth,parent_guardian_name,parent_guardian_email,parent_guardian_phone,review_flags)
    values(pid,case when p_payload->'date_of_birth'<>'null'::jsonb then rooted.day(p_payload,'date_of_birth') end,
      case when p_payload->'parent_guardian_name'<>'null'::jsonb then rooted.txt(p_payload,'parent_guardian_name',160,true) end,
      case when p_payload->'parent_guardian_email'<>'null'::jsonb then rooted.txt(p_payload,'parent_guardian_email',254,true) end,
      case when p_payload->'parent_guardian_phone'<>'null'::jsonb then rooted.txt(p_payload,'parent_guardian_phone',80,true) end,p_payload->'review_flags')
    on conflict on constraint participant_profiles_pkey do update set date_of_birth=excluded.date_of_birth,parent_guardian_name=excluded.parent_guardian_name,
      parent_guardian_email=excluded.parent_guardian_email,parent_guardian_phone=excluded.parent_guardian_phone,review_flags=excluded.review_flags,updated_at=now();
    result:=jsonb_build_object('participant_id',pid);
  when 'friend.award' then result:=rooted.friend_award(p_payload,actor);
  when 'checkin' then result:=rooted.checkin(p_payload,actor,null);
  when 'adjustment' then
    perform rooted.keys(p_payload,array['participant_id','event_id','points','reason']);
    pid:=rooted.uid(p_payload,'participant_id'); eid:=rooted.uid(p_payload,'event_id'); n:=rooted.num(p_payload,'points',-100000,100000);
    if n=0 then raise exception using errcode='22023',message='Nonzero adjustment required'; end if;
    -- Deliberate exception: a reasoned correction may target a closed event.
    insert into rooted.ledger(participant_id,event_id,kind,points,source,reason,actor_id)
      values(pid,eid,'adjustment',n,'adjustment:'||p_request_id,rooted.txt(p_payload,'reason',500),actor) returning id into target;
    result:=jsonb_build_object('id',target,'points',n);
  when 'draw' then result:=rooted.draw(p_request_id,p_payload,actor);
  when 'kiosk.issue' then
    perform rooted.keys(p_payload,array['event_id','label','ttl_minutes']);
    eid:=rooted.uid(p_payload,'event_id'); ev:=rooted.require_open(eid); ttl:=rooted.num(p_payload,'ttl_minutes',1,720);
    token:=encode(extensions.gen_random_bytes(32),'hex');
    insert into rooted.devices(event_id,token_hash,label,issued_by,expires_at)
      values(eid,extensions.digest(token,'sha256'),rooted.txt(p_payload,'label',80),actor,now()+make_interval(mins=>ttl)) returning * into device;
    result:=jsonb_build_object('id',device.id,'event_id',eid,'expires_at',device.expires_at);
  when 'kiosk.revoke' then
    perform rooted.keys(p_payload,array['device_id','reason']); target:=rooted.uid(p_payload,'device_id');
    perform rooted.txt(p_payload,'reason',500);
    update rooted.devices x set revoked_at=coalesce(x.revoked_at,now()),revoked_by=coalesce(x.revoked_by,actor) where x.id=target;
    if not found then raise exception using errcode='22023',message='Device not found'; end if;
    result:=jsonb_build_object('id',target,'revoked',true);
  else raise exception using errcode='22023',message='Unknown leader action';
  end case;
  replay:=rooted.finish(p_request_id,actor,'leader',p_action,p_payload,result);
  -- Never persist the bearer token in requests/audit. Issue response ONLY.
  if token is not null then replay:=replay||jsonb_build_object('device_token',token); end if;
  return replay;
end;
$$;

-- Bounded, private collection reads. UUID ordering + offset is not an export
-- snapshot: callers refresh after writes, or export through a future server job.
create function public.rooted_leader_state(p_collection text,p_limit integer default 100,p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid; rows jsonb; source text;
begin
  perform rooted.lock_app(); actor:=rooted.require_leader();
  if p_limit is null or p_limit not between 1 and 500 or p_offset is null or p_offset not between 0 and 1000000 then
    raise exception using errcode='22023',message='Invalid pagination';
  end if;
  case p_collection
  when 'participants' then source:='select p.*,coalesce((select sum(l.points) from rooted.ledger l where l.participant_id=p.id),0) as points from rooted.participants p order by p.id';
  when 'seasons' then source:='select x.* from rooted.seasons x order by x.id';
  when 'events' then source:='select x.* from rooted.events x order by x.id';
  when 'checkins' then source:='select x.* from rooted.checkins x order by x.id';
  when 'ledger' then source:='select x.* from rooted.ledger x order by x.id';
  when 'draws' then source:='select x.* from rooted.draws x order by x.id';
  when 'reading_totals' then source:='select x.* from rooted.reading_totals x order by x.participant_id,x.week';
  when 'first_visits' then source:='select x.* from rooted.first_visits x order by x.participant_id';
  when 'rates' then source:='select x.attendance,x.bible,x.friend from rooted.rates x';
  when 'theme' then source:='select x.name,x.study,x.tagline,x.scripture,x.artwork,x.enabled from rooted.theme x';
  when 'friend_claims' then source:='select x.* from rooted.friend_claims x order by x.participant_id';
  -- Profile payloads are private even in historical audit. Ordinary leaders
  -- receive attribution/receipt metadata only, never contact values.
  when 'audit' then source:='select x.id,x.request_id,x.actor_id,x.device_id,x.action,case when x.action=''profile.update'' then jsonb_build_object(''result'',x.details->''result'') else x.details end as details,x.created_at from rooted.audit x order by x.created_at,x.id';
  when 'devices' then source:='select x.id,x.event_id,x.label,x.issued_by,x.expires_at,x.revoked_at,x.revoked_by,x.created_at from rooted.devices x order by x.id';
  else raise exception using errcode='22023',message='Unknown private collection';
  end case;
  execute 'select coalesce(jsonb_agg(to_jsonb(q)),''[]''::jsonb) from ('||source||' limit $1 offset $2) q' into rows using p_limit,p_offset;
  return jsonb_build_object('actor_id',actor,'collection',p_collection,'rows',rows,'limit',p_limit,'offset',p_offset);
end;
$$;

create function rooted.require_device(token text) returns rooted.devices language plpgsql set search_path='' as $$
declare d rooted.devices%rowtype;
begin
  if token is null or token !~ '^[0-9a-f]{64}$' then raise exception using errcode='42501',message='Invalid kiosk capability'; end if;
  select x.* into d from rooted.devices x join rooted.leaders l on l.user_id=x.issued_by and l.active
    where x.token_hash=extensions.digest(token,'sha256') and x.revoked_at is null and x.expires_at>clock_timestamp() for share of x,l;
  if not found then raise exception using errcode='42501',message='Invalid or expired kiosk capability'; end if;
  perform rooted.require_open(d.event_id);
  return d;
end;
$$;
-- ACL is intentionally service_role ONLY; token is not a Supabase JWT.
create function public.rooted_kiosk(p_token text,p_action text,p_payload jsonb default '{}'::jsonb,p_request_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  device rooted.devices%rowtype; ev rooted.events%rowtype; result jsonb; replay jsonb;
  q text; matches jsonb; pid uuid; person rooted.participants%rowtype;
  old rooted.checkins%rowtype; prior integer; needs_leader boolean;
begin
  perform rooted.lock_app(); device:=rooted.require_device(p_token);
  if p_action is null then raise exception using errcode='22023',message='Kiosk action required'; end if;
  case p_action
  when 'context' then
    perform rooted.keys(p_payload,'{}'::text[]); ev:=rooted.require_open(device.event_id);
    select jsonb_build_object('event',jsonb_build_object('id',ev.id,'name',ev.name,'date',ev.date,'reading_week',ev.reading_week),'rates',to_jsonb(x)-'id') into result from rooted.rates x where x.id;
  when 'search' then
    perform rooted.keys(p_payload,array['query']); q:=rooted.txt(p_payload,'query',80,true);
    if length(q)<2 then return jsonb_build_object('matches','[]'::jsonb,'truncated',false); end if;
    -- strpos is literal: %, _, and backslash never expand into wildcards.
    select coalesce(jsonb_agg(to_jsonb(x) order by lower(x.name),x.id),'[]'::jsonb) into matches
      from (select p.id,p.name from rooted.participants p where strpos(lower(p.name),lower(q))>0 order by lower(p.name),p.id limit 9) x;
    select coalesce(jsonb_agg(x.value order by x.ordinality),'[]'::jsonb) into result from jsonb_array_elements(matches) with ordinality x where x.ordinality<=8;
    result:=jsonb_build_object('matches',result,'truncated',jsonb_array_length(matches)>8);
  when 'person' then
    perform rooted.keys(p_payload,array['participant_id']); pid:=rooted.uid(p_payload,'participant_id');
    select p.* into person from rooted.participants p where p.id=pid;
    if not found then raise exception using errcode='22023',message='Participant not found'; end if;
    select c.* into old from rooted.checkins c where c.event_id=device.event_id and c.participant_id=pid;
    needs_leader:=case when old.id is not null then not old.attended else not person.previously_attended and not exists(select 1 from rooted.first_visits f where f.participant_id=pid) end;
    select t.chapters into prior from rooted.reading_totals t join rooted.events e on e.reading_week=t.week where e.id=device.event_id and t.participant_id=pid;
    result:=jsonb_build_object('person',jsonb_build_object('id',pid,'name',person.name),'already_checked_in',coalesce(old.attended,false),'needs_leader',needs_leader,'prior_chapters',coalesce(prior,0),'receipt',case when old.id is not null then rooted.receipt(old.id) end);
  when 'checkin' then
    perform rooted.keys(p_payload,array['participant_id','bible','chapters']);
    replay:=rooted.replay(p_request_id,device.id,'device','kiosk.checkin',p_payload);
    if replay is not null then return replay; end if;
    result:=rooted.checkin(p_payload||jsonb_build_object('event_id',device.event_id,'attended',true),null,device.id);
    return rooted.finish(p_request_id,device.id,'device','kiosk.checkin',p_payload,result);
  else raise exception using errcode='22023',message='Unknown kiosk action';
  end case;
  return result;
end;
$$;

revoke all on all functions in schema rooted from public, anon, authenticated, service_role;
revoke all on function public.rooted_identity() from public, anon, authenticated, service_role;
revoke all on function public.rooted_admin_profiles(integer,integer) from public, anon, authenticated, service_role;
grant execute on function public.rooted_identity() to authenticated;
grant execute on function public.rooted_admin_profiles(integer,integer) to authenticated;
revoke all on function public.rooted_leader_mutate(uuid,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.rooted_leader_state(text,integer,integer) from public, anon, authenticated, service_role;
revoke all on function public.rooted_kiosk(text,text,jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.rooted_leader_mutate(uuid,text,jsonb) to authenticated;
grant execute on function public.rooted_leader_state(text,integer,integer) to authenticated;
grant execute on function public.rooted_kiosk(text,text,jsonb,uuid) to service_role;
comment on schema rooted is 'Private Rooted authority. No browser table access, no teen Auth accounts, no PIN authorization.';
comment on function public.rooted_kiosk(text,text,jsonb,uuid) is 'Server proxy only. Never grant to anon/authenticated; never expose service_role credentials to a kiosk.';
commit;
