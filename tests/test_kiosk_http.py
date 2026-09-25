import http.client,json,tempfile,threading,unittest
from pathlib import Path
from app import make_server

class KioskHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.server=make_server(Path(self.tmp.name)/'db.sqlite3',0)
        self.thread=threading.Thread(target=self.server.serve_forever);self.thread.start()
        self.port=self.server.server_address[1]
        self.event=self.server.store.event({'name':'Fictional kiosk night','date':'2026-10-01','reading_week':'2026-09-21'})['id']
        with self.server.store.connection(True) as db:
            db.execute('UPDATE events SET fictional=1 WHERE id=?',(self.event,))
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.tmp.cleanup()
    def req(self,method,path,data=None,origin=None):
        c=http.client.HTTPConnection('127.0.0.1',self.port)
        headers={'Content-Type':'application/json'}
        if origin:headers['Origin']=origin
        c.request(method,path,None if data is None else json.dumps(data),headers)
        r=c.getresponse();out=(r.status,r.read());c.close();return out
    def test_kiosk_is_front_door_and_leader_surface_preserved(self):
        status,body=self.req('GET','/');self.assertEqual(status,200);self.assertIn(b'/kiosk.js',body)
        status,body=self.req('GET','/check-in/?event='+str(self.event));self.assertEqual(status,200);self.assertIn(b'What\'s your name?',body)
        status,body=self.req('GET','/leader/');self.assertEqual(status,200);self.assertIn(b'LEADER WORKSPACE',body)
        for route in ['/kiosk.js','/kiosk.css','/kiosk-regular.ttf','/kiosk-bold.ttf','/kiosk-forest.jpg']:
            self.assertEqual(self.req('GET',route)[0],200,route)
    def test_context_is_minimal_and_guarded(self):
        status,body=self.req('POST','/api/kiosk/context',{'event_id':self.event})
        self.assertEqual(status,200);data=json.loads(body)
        self.assertEqual(data['event']['id'],self.event);self.assertNotIn('participants',data)
        self.assertEqual(self.req('POST','/api/kiosk/context',{'event_id':self.event},'https://evil.example')[0],403)
        self.assertEqual(self.req('POST','/api/kiosk/context',{})[0],400)

if __name__=='__main__':unittest.main()
