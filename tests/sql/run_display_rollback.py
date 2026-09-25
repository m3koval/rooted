#!/usr/bin/env python3
"""Test only display forward migration in an explicit hosted ROLLBACK."""
from pathlib import Path
import subprocess, re, json, hashlib
root = Path(__file__).resolve().parents[2]
project = 'sfrkowqljeaztupywtzy'
migration = root/'supabase/migrations/20260925000300_rooted_secure_display.sql'
tests = root/'tests/sql/secure_display.sql'
cmd = ['npx','--yes','supabase@latest','db','query','--linked','--project-ref',project,'--output','json']
readback = """select
 (select jsonb_agg(version order by version) from supabase_migrations.schema_migrations) as versions,
 (select count(*) from auth.users where email like 'display-rollback-%@example.invalid') as fictional_users,
 (select count(*) from rooted.participants where name like 'Fictional Display %') as fictional_children,
 (select md5(pg_get_functiondef(p.oid)) from pg_proc p where p.oid=to_regprocedure('public.rooted_display(text)')) as display_hash,
 (select md5(pg_get_functiondef('rooted.require_device(text)'::regprocedure))) as gate_hash"""
def query(args):
    r=subprocess.run(cmd+args,cwd=root,text=True,capture_output=True,timeout=150)
    if r.returncode:
        raise RuntimeError(r.stderr+'\n'+r.stdout)
    data=json.loads(r.stdout)
    return {'rows':data} if isinstance(data,list) else data
before=query([readback])
assert '20260925000200' in before['rows'][0]['versions'], 'Daily station migration required'
sql=migration.read_text()
assert len(re.findall(r'^begin;\s*$',sql,re.M|re.I))==1
assert len(re.findall(r'^commit;\s*$',sql,re.M|re.I))==1
sql=re.sub(r'^(begin|commit);\s*$','',sql,flags=re.M|re.I)
# Permit repeat verification after parent release without changing the deployed RPC.
if before['rows'][0]['display_hash']:
    sql=sql.replace('create function public.rooted_display','create or replace function public.rooted_display',1)
combined="BEGIN;\nSET LOCAL statement_timeout='60s';\nSET LOCAL lock_timeout='5s';\nselect rooted.lock_app();\n"+sql+'\n'+tests.read_text()+'\nROLLBACK;\n'
assert not re.search(r'^commit;\s*$',combined,re.M|re.I)
file=root/'tests/sql/display-rollback.sql'
file.write_text(combined)
result=query(['--file',str(file)])
after=query([readback])
assert before['rows']==after['rows'],'Rollback readback mismatch'
assert result['rows'][0]['passed_assertions'] >= 24
assert before['rows'][0]['fictional_users']==0 and before['rows'][0]['fictional_children']==0
evidence={'project':project,'committed':False,'result':result,'before':before['rows'],'after':after['rows'],'sha256':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [migration,tests]}}
(root/'tests/sql/display-rollback-output.json').write_text(json.dumps(evidence,indent=2)+'\n')
print(json.dumps(evidence,indent=2))
