"""Disposable local PostgreSQL only. Real commits, dropped replies and lock races."""
import concurrent.futures
import threading
import uuid
import psycopg
from psycopg.types.json import Jsonb
DSN = 'host=/tmp/rooted-pg port=55439 dbname=postgres user=helper'
a, u, i, q, other = [uuid.uuid4() for _ in range(5)]
email = f'{u}@example.test'
def call(c, request=q, step='start', user=None, delivery=None):
    return c.execute('select public.rooted_team_provision_request(%s,%s,%s,%s,%s,%s,%s)', (a, request, i, 'held', step, user, delivery)).fetchone()[0]
with psycopg.connect(DSN) as c:
    c.execute('insert into auth.users(id,email) values(%s,%s)', (a, f'{a}@example.test'))
    c.execute("insert into rooted.leaders(user_id,display_name,role) values(%s,'Concurrency admin','admin')", (a,))
    c.execute("insert into rooted.team_invitations(id,email,display_name,created_by) values(%s,%s,'Concurrency new',%s)", (i,email,a))
locked = threading.Event()
release = threading.Event()
def first():
    with psycopg.connect(DSN) as c:
        c.execute('set local role service_role')
        r = call(c)
        assert r['create'] is True
        locked.set()
        assert release.wait(5)
    # The committed reply is intentionally discarded by the caller.
def second():
    assert locked.wait(5)
    with psycopg.connect(DSN) as c:
        c.execute('set local role service_role')
        return call(c)
try:
    with concurrent.futures.ThreadPoolExecutor() as pool:
        f1=pool.submit(first); f2=pool.submit(second)
        assert locked.wait(5)
        release.set()
        f1.result(); r=f2.result()
        assert r['create'] is False and r['phase']=='create_claimed'
    with psycopg.connect(DSN) as c:
        c.execute('set local role service_role')
        try:
            with c.transaction(): call(c,request=other)
            raise AssertionError('different request created twice')
        except psycopg.errors.UniqueViolation: pass
    # Simulate Auth committed successfully but its network response was lost.
    with psycopg.connect(DSN) as c:
        c.execute('insert into auth.users(id,email,raw_app_meta_data) values(%s,%s,%s)', (u,email,Jsonb({'rooted_provision_request':str(q)})))
    with psycopg.connect(DSN) as c:
        c.execute('set local role service_role')
        assert call(c)['create'] is False
        call(c,step='reconcile_identity',user=u)
    # Identity save response lost: a fresh connection still resumes saved identity.
    with psycopg.connect(DSN) as c:
        c.execute('set local role service_role')
        assert call(c)['user_id']==str(u)
        call(c,step='bind')
    with psycopg.connect(DSN) as c:
        c.execute('set local role service_role')
        receipt=call(c,step='finish',delivery='held')
    # Final receipt commit/drop/reconnect yields exact JSON, not reconstructed data.
    with psycopg.connect(DSN) as c:
        c.execute('set local role service_role')
        assert call(c)==receipt
    print('PASS: concurrent committed claim, competing UUID denial, Auth commit/drop reconciliation, identity commit/drop, immutable receipt replay')
finally:
    release.set()
    # Only disposable fixtures; temporarily bypass immutable-delete triggers as
    # local test superuser, all cleanup and trigger restoration in one transaction.
    with psycopg.connect(DSN) as c:
        c.execute('alter table rooted.team_provision_requests disable trigger guard_provision_request')
        c.execute('delete from rooted.team_provision_requests where request_id=%s', (q,))
        c.execute('alter table rooted.team_provision_requests enable trigger guard_provision_request')
        c.execute('alter table rooted.team_audit disable trigger immutable_rows')
        c.execute('delete from rooted.team_audit where actor_id=%s', (a,))
        c.execute('alter table rooted.team_audit enable trigger immutable_rows')
        c.execute('delete from rooted.team_invitations where id=%s', (i,))
        c.execute('delete from rooted.leaders where user_id in (%s,%s)', (a,u))
        c.execute('delete from auth.users where id in (%s,%s)', (a,u))
