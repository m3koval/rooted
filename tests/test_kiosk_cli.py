import json,re,subprocess,sys,tempfile,unittest,urllib.request,urllib.error
from pathlib import Path
from app import Store

class KioskCLITests(unittest.TestCase):
    def test_real_cli_error_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            db=Path(tmp)/'cli.sqlite3';store=Store(db)
            event=store.event({'name':'Fictional CLI test','date':'2026-10-01','reading_week':'2026-09-21','fictional':True})
            other=store.event({'name':'Fictional test record marked non-demo','date':'2026-10-02','reading_week':'2026-09-21','fictional':False})
            person=store.participant({'name':'Fictional CLI Student','previously_attended':True,'fictional':True})
            with store.connection(True) as conn:
                conn.execute('UPDATE participants SET fictional=1')
                conn.execute('UPDATE events SET fictional=1 WHERE id=?',(event['id'],))
            proc=subprocess.Popen([sys.executable,'-u',str(Path(__file__).resolve().parents[1]/'app.py'),'--db',str(db),'--port','0'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
            try:
                line=proc.stdout.readline()+proc.stdout.readline();match=re.search(r'http://127\.0\.0\.1:\d+',line);self.assertIsNotNone(match,line);origin=match.group()
                def post(action,data):
                    req=urllib.request.Request(origin+'/api/kiosk/'+action,data=json.dumps(data).encode(),headers={'Content-Type':'application/json','Origin':origin})
                    try:
                        with urllib.request.urlopen(req,timeout=5) as r:return r.status,json.load(r)
                    except urllib.error.HTTPError as e:return e.code,json.load(e)
                self.assertEqual(post('context',{'event_id':True})[0],400)
                self.assertEqual(post('context',{'event_id':other['id']})[0],403)
                self.assertEqual(post('context',{'event_id':event['id']})[0],200)
                payload={'event_id':event['id'],'participant_id':person['id'],'bible':False,'chapters':0}
                self.assertEqual(post('checkin',payload)[0],201)
                self.assertEqual(post('checkin',{**payload,'bible':True})[0],409)
            finally:
                proc.terminate();proc.wait(timeout=5);proc.stdout.close()
