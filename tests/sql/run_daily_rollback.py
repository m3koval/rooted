#!/usr/bin/env python3
"""Focused installed-schema proof. Never replays foundation or commits fixtures."""
from pathlib import Path
import subprocess, re, json, hashlib
root = Path(__file__).resolve().parents[2]
project = 'sfrkowqljeaztupywtzy'
migration = root/'supabase/migrations/20260925000200_rooted_daily_station_sessions.sql'
tests = root/'tests/sql/daily_station_sessions.sql'
cmd = ['npx','--yes','supabase@latest','db','query','--linked','--project-ref',project,'--output','json']
# Store only minimized metadata, never production person data or bearer tokens.
readback = """select
 (select jsonb_agg(version order by version) from supabase_migrations.schema_migrations) as versions,
 (select count(*) from auth.users where email like 'daily-rollback-%@example.invalid') as fictional_users,
 (select count(*) from rooted.participants where name='Fictional Daily Child') as fictional_children,
 (select md5(pg_get_functiondef('public.rooted_station_unlock(text,text)'::regprocedure))) as unlock_hash,
 (select md5(pg_get_functiondef('rooted.require_device(text)'::regprocedure))) as gate_hash"""
def query(args):
    r=subprocess.run(cmd+args,cwd=root,text=True,capture_output=True,timeout=150)
    if r.returncode:
        raise RuntimeError(r.stderr+'\n'+r.stdout)
    data = json.loads(r.stdout)
    return {'rows': data} if isinstance(data, list) else data
before = query([readback])
versions=before['rows'][0]['versions']
assert '20260924000100' in versions and '20260925000100' in versions
sql=migration.read_text()
assert len(re.findall(r'^begin;\s*$',sql,re.M|re.I)) == 1
assert len(re.findall(r'^commit;\s*$',sql,re.M|re.I)) == 1
sql=re.sub(r'^(begin|commit);\s*$','',sql,flags=re.M|re.I)
combined="""BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='5s';
select rooted.lock_app();
create temporary table daily_acl_before as
 select oid,proacl,proowner,prosecdef,proconfig from pg_proc where oid in
 ('public.rooted_station_unlock(text,text)'::regprocedure,'rooted.require_device(text)'::regprocedure);
create temporary table daily_devices_before as select id,expires_at from rooted.devices;
"""+sql+'\n'+tests.read_text()+'\nROLLBACK;\n'
assert not re.search(r'^commit;\s*$',combined,re.M|re.I)
file=root/'tests/sql/daily-rollback.sql'
file.write_text(combined)
result=query(['--file',str(file)])
after=query([readback])
assert before['rows']==after['rows'], 'Rollback readback mismatch'
evidence={'project':project,'committed':False,'result':result,'before':before['rows'],'after':after['rows'],'sha256':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [migration,tests]}}
(root/'tests/sql/daily-rollback-output.json').write_text(json.dumps(evidence,indent=2)+'\n')
print(json.dumps(evidence,indent=2))
