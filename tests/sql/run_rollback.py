#!/usr/bin/env python3
"""Run complete canonical migration chain + fictional assertions; ALWAYS rollback."""
from pathlib import Path
import subprocess, re, hashlib, json
root = Path(__file__).resolve().parents[2]
migrations = sorted((root / 'supabase/migrations').glob('*.sql'))
chunks=[]
for migration in migrations:
    sql=migration.read_text()
    assert len(re.findall(r'^begin;\s*$',sql,re.M|re.I))==1
    assert len(re.findall(r'^commit;\s*$',sql,re.M|re.I))==1
    sql=re.sub(r'^(begin|commit);\s*$','',sql,flags=re.M|re.I)
    chunks.append(sql)
tests=[root/'tests/sql/behavior.sql',root/'tests/sql/stations.sql']
combined="BEGIN;\nSET LOCAL statement_timeout = '60s';\n"+'\n'.join(chunks+[p.read_text() for p in tests])+'\nROLLBACK;\n'
assert not re.search(r'^commit;\s*$',combined,re.M|re.I)
file=root/'tests/sql/rollback.sql'
file.write_text(combined)
cmd=['npx','--yes','supabase@latest','db','query','--linked','--project-ref','sfrkowqljeaztupywtzy','--file',str(file),'--output','json']
result=subprocess.run(cmd,cwd=root,text=True,capture_output=True,timeout=150)
(root/'tests/sql/rollback-output.json').write_text(result.stdout)
(root/'tests/sql/rollback-stderr.txt').write_text(result.stderr)
print(result.stderr)
print(result.stdout)
print(json.dumps({'exit_code':result.returncode,'sha256':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in migrations+tests}}))
raise SystemExit(result.returncode)
