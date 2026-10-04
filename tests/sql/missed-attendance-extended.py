"""Local disposable PG only. Run with python; requires psycopg. Never hosted."""
import json
import uuid
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import psycopg
from psycopg.types.json import Jsonb
DB = 'rooted_missed_verify6'
def connect():
    c = psycopg.connect(host='/tmp/rooted-pg', port=55439, user='helper', dbname=DB, autocommit=True)
    c.execute("set client_encoding='UTF8'")
    return c
c = connect()
assert c.execute("select to_regprocedure('public.rooted_record_missed_attendance(uuid,jsonb)')").fetchone()[0] is None, 'Fresh template required'
c.execute(Path(__file__).resolve().parents[2].joinpath('supabase/migrations/20261004000100_rooted_missed_attendance.sql').read_text())
def uid(): return str(uuid.uuid4())
def sql(q, args=()): return c.execute(q,args)
def scalar(q,args=()): return sql(q,args).fetchone()[0]
actor, season, season2, old, later = [uid() for _ in range(5)]
sql("create or replace function rooted.gathering_now() returns timestamptz language sql set search_path='' as $$select '2026-10-04T18:00:00Z'::timestamptz$$")
sql("insert into auth.users(id,email) values(%s,'extended@example.invalid')",(actor,))
sql("insert into rooted.leaders(user_id,display_name,role) values(%s,'Extended Fixture','leader')",(actor,))
for s in (season,season2): sql("insert into rooted.seasons(id,name,starts_on,ends_on) values(%s,'Extended','2026-01-01','2026-12-31')",(s,))
for e,s,d in ((old,season,'2026-09-29'),(later,season2,'2026-09-30')):
    sql("insert into rooted.events(id,season_id,name,date,reading_week,open) values(%s,%s,'Extended',%s,'2026-09-28',false)",(e,s,d))
def person(previous=True):
    p=uid();sql("insert into rooted.participants(id,name,previously_attended) values(%s,'Fictional Extended',%s)",(p,previous));return p
def rpc(name,args,conn=None):
    conn=conn or c
    with conn.transaction():
        conn.execute('set local role authenticated')
        conn.execute("select set_config('request.jwt.claim.sub',%s,true)",(actor,))
        return conn.execute('select public.'+name+'('+','.join(k+'=>%s' for k in args)+')',tuple(Jsonb(v) if isinstance(v,dict) else v for v in args.values())).fetchone()[0]
def missed(p,e=old,n=0,conn=None,rid=None):
    return rpc('rooted_record_missed_attendance',dict(p_request_id=rid or uid(),p_payload=dict(participant_id=p,event_id=e,event_date='2026-09-29' if e==old else '2026-09-30',attended=True,bible=True,chapters=n,reason='Extended synthetic verification')),conn)
def correct(cid,p,n,att=True):
    rev=scalar('select revision_id from rooted.effective_checkins where id=%s',(cid,))
    return rpc('rooted_correct_checkin',dict(p_request_id=uid(),p_checkin_id=cid,p_expected_revision=rev,p_participant_id=p,p_attended=att,p_bible=att,p_chapters=n))
def passed(s): print('PASS '+s,flush=True)
# Original zero component evidence must survive later config increases and edits.
p=person();sql('update rooted.rates set attendance=0,bible=0 where id')
r=missed(p);cid=r['result']['receipt']['checkin_id']
sql('update rooted.rates set attendance=19,bible=13 where id')
correct(cid,p,2);correct(cid,p,0,False);correct(cid,p,3)
assert scalar("select coalesce(sum(points),0) from rooted.ledger where participant_id=%s and kind in ('attendance','bible')",(p,))==0
passed('zero-rate later chapter edit and off/on preserve zero')
# Existing recorded visit and referral remain authoritative after earlier-event backfill.
guest,inviter=person(False),person()
missed(guest,later)
sql('select rooted.friend_award(%s,%s)',(Jsonb(dict(participant_id=guest,event_id=later,inviter_id=inviter)),actor))
def referral_snapshot():
    return scalar("select jsonb_build_object('first',(select to_jsonb(f) from rooted.first_visits f where participant_id=%s),'effective',(select to_jsonb(f) from rooted.effective_first_visits f where participant_id=%s),'claim',(select to_jsonb(f) from rooted.friend_claims f where participant_id=%s),'ledger',(select jsonb_agg(to_jsonb(l) order by id) from rooted.ledger l where kind='friend' and participant_id=%s))",(guest,guest,guest,inviter))
before=referral_snapshot();missed(guest,old);assert referral_snapshot()==before
passed('existing first visit, referral claim and friend ledger unchanged')
# Same reading week spans distinct seasons; maximum, not sum.
p=person();missed(p,later,7);missed(p,old,4)
assert scalar('select chapters from rooted.reading_totals where participant_id=%s',(p,))==7
assert scalar("select sum(points) from rooted.ledger where participant_id=%s and kind='reading'",(p,))==7
passed('cross-season same-week maximum preserved')
# Two independently connected simultaneous requests converge to one creation.
p=person();barrier=Barrier(2)
def contender(_):
    with connect() as other:
        barrier.wait()
        try: missed(p,conn=other);return 'created'
        except psycopg.Error as e:
            assert e.sqlstate=='23505' and 'already exists' in str(e);return 'duplicate'
with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(contender,range(2)))
assert sorted(results)==['created','duplicate']
assert scalar('select count(*) from rooted.effective_checkins where participant_id=%s and event_id=%s',(p,old))==1
assert scalar("select count(*) from rooted.requests where action='checkin.missed' and payload->>'participant_id'=%s",(p,))==1
passed('concurrent same pair: one creation, one 23505, one durable request')
# Fail final audit after all attendance/reading writes, verify whole transaction.
p=person(False);rid=uid()
def counts():
    return {t:scalar('select count(*) from rooted.'+t) for t in ('checkins','ledger','reading_totals','first_visits','requests','audit')}
before=counts()
sql("create function rooted.extended_fail_audit() returns trigger language plpgsql as $$begin raise exception 'EXTENDED_INJECTED_FAILURE';end$$")
sql('create trigger extended_failure before insert on rooted.audit for each row execute function rooted.extended_fail_audit()')
try:
    try: missed(p,n=9,rid=rid);raise AssertionError('Expected injected failure')
    except psycopg.Error as e: assert 'EXTENDED_INJECTED_FAILURE' in str(e)
    assert counts()==before
finally:
    sql('drop trigger extended_failure on rooted.audit');sql('drop function rooted.extended_fail_audit()')
assert scalar('select count(*) from rooted.requests where id=%s',(rid,))==0
passed('late audit failure rolls back checkin, awards, reading, first visit, request, audit')
print(json.dumps(dict(passed=5,db=DB,hostedWrites=0)))
c.close()
