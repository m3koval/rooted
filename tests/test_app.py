import http.client
import json
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from app import Store, AppError, make_server


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'test.sqlite3'
        self.s = Store(self.path)
        self.a = self.s.participant({'name': 'Alex', 'previously_attended': True})['id']
        self.b = self.s.participant({'name': 'Blair', 'previously_attended': False})['id']
        self.e = self.event('2026-09-24', '2026-09-21')

    def tearDown(self):
        self.tmp.cleanup()

    def event(self, date, week):
        return self.s.event({'name': 'Rooted night', 'date': date, 'reading_week': week})['id']

    def check(self, person=None, event=None, **kw):
        return self.s.checkin(dict(participant_id=person or self.a, event_id=event or self.e,
                                   attended=True, bible=True, chapters=3, **kw))

    def test_duplicate_checkin_and_week_do_not_duplicate_points(self):
        self.check()
        self.check()
        e2 = self.event('2026-09-25', '2026-09-21')
        self.check(event=e2)
        state = self.s.state()
        reading = [x for x in state['ledger'] if x['kind'] == 'reading']
        self.assertEqual(sum(x['points'] for x in reading), 3)
        self.assertEqual(len(state['checkins']), 2)
        self.assertEqual(sum(x['points'] for x in state['ledger']), 17)

    def test_weekly_cumulative_total_awards_only_increase(self):
        self.check()
        e2 = self.event('2026-09-25', '2026-09-21')
        self.s.checkin(dict(participant_id=self.a,event_id=e2,attended=False,bible=False,chapters=5))
        self.assertEqual(sum(x['points'] for x in self.s.state()['ledger'] if x['kind']=='reading'), 5)

    def test_conflicting_repeat_is_rejected_without_mutation(self):
        self.check()
        before = self.s.state()['ledger']
        with self.assertRaises(AppError):
            self.s.checkin(dict(participant_id=self.a,event_id=self.e,attended=True,bible=False,chapters=3))
        self.assertEqual(before, self.s.state()['ledger'])

    def test_friend_requires_actual_first_attendance_and_awards_once(self):
        self.s.checkin(dict(participant_id=self.b,event_id=self.e,attended=False,bible=False,chapters=0,inviter_id=self.a))
        self.assertFalse(any(x['kind']=='friend' for x in self.s.state()['ledger']))
        e2 = self.event('2026-09-25', '2026-09-21')
        self.check(person=self.b,event=e2,inviter_id=self.a)
        e3 = self.event('2026-10-01', '2026-09-28')
        self.check(person=self.b,event=e3,inviter_id=self.a)
        self.assertEqual(len([x for x in self.s.state()['ledger'] if x['kind']=='friend']), 1)

    def test_existing_attendee_never_counts_as_new_friend(self):
        self.check(inviter_id=self.b)
        self.assertFalse(any(x['kind']=='friend' for x in self.s.state()['ledger']))

    def test_first_visit_without_inviter_cannot_be_claimed_later(self):
        self.check(person=self.b)
        e2 = self.event('2026-10-01', '2026-09-28')
        self.check(person=self.b,event=e2,inviter_id=self.a)
        self.assertFalse(any(x['kind']=='friend' for x in self.s.state()['ledger']))

    def test_validation_and_atomicity(self):
        for chapters in [-1, 1.5, True, '3']:
            with self.assertRaises(AppError):
                self.s.checkin(dict(participant_id=self.a,event_id=self.e,attended=True,bible=True,chapters=chapters))
        with self.assertRaises(AppError):
            self.check(inviter_id=self.a)
        self.assertEqual(self.s.state()['ledger'], [])
        with self.assertRaises(AppError):
            self.event('2026-02-30','2026-09-21')
        with self.assertRaises(AppError):
            self.event('2026-09-24','2026-09-22')

    def test_ledger_is_immutable_and_survives_restart(self):
        self.check()
        with sqlite3.connect(self.path) as db:
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute('UPDATE ledger SET points=999')
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute('DELETE FROM ledger')
        self.assertEqual(Store(self.path).state()['ledger'], self.s.state()['ledger'])

    def test_settings_are_explicit_demo_and_nonretroactive(self):
        self.check()
        old = self.s.state()['ledger']
        self.s.settings({'attendance': 8, 'bible': 4, 'friend': 12})
        self.assertEqual(old, self.s.state()['ledger'])
        with self.assertRaises(AppError):
            self.s.settings({'attendance': -1, 'bible': 4, 'friend': 12})

    def draw(self, **kw):
        return self.s.draw(dict(event_id=self.e,prize='Book',present_only=True,one_win=True,
                                request_id='test-draw-0001', **kw))

    def test_draw_zero_entries_and_server_randomness_frozen_idempotent(self):
        with self.assertRaises(AppError):
            self.draw()
        self.check()
        with patch('app.secrets.randbelow', return_value=0) as rng:
            result = self.draw()
            rng.assert_called_once_with(10)
        self.assertEqual(result['winner_id'], self.a)
        self.assertEqual(result['weights'], [{'participant_id':self.a,'name':'Alex','weight':10}])
        self.assertEqual(self.draw(), result)
        with self.assertRaises(AppError):
            self.s.draw(dict(event_id=self.e,prize='Different',present_only=True,one_win=True,request_id='test-draw-0001'))
        with self.assertRaises(AppError):
            self.s.draw(dict(event_id=self.e,prize='Second',present_only=True,one_win=True,request_id='test-draw-0002'))
        self.assertEqual(Store(self.path).state()['draws'][0]['weights'], result['weights'])

    def test_present_only_filters_and_opt_out_permits_another_win(self):
        other = self.event('2026-10-01','2026-09-28')
        self.check(event=other)
        with self.assertRaises(AppError):
            self.draw()
        result = self.s.draw(dict(event_id=self.e,prize='Book',present_only=False,one_win=False,request_id='all-1'))
        self.assertEqual(result['winner_id'], self.a)
        again = self.s.draw(dict(event_id=self.e,prize='Book 2',present_only=False,one_win=False,request_id='all-2'))
        self.assertEqual(again['winner_id'], self.a)

    def test_concurrent_retries_award_once(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda _:self.check(), range(12)))
        self.assertEqual(len(self.s.state()['checkins']), 1)
        self.assertEqual(sum(x['points'] for x in self.s.state()['ledger']), 10)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.server = make_server(Path(self.tmp.name)/'test.db', port=0)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def request(self, method, path, data=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port)
        conn.request(method,path,body=json.dumps(data) if data is not None else None,headers=headers or {})
        response = conn.getresponse()
        result = (response.status,dict(response.getheaders()),response.read())
        conn.close()
        return result

    def test_local_bind_state_and_frontend(self):
        self.assertEqual(self.server.server_address[0], '127.0.0.1')
        for path in ['/','/app.js','/style.css','/api/state']:
            status, headers, body = self.request('GET',path)
            self.assertEqual(status,200)
            self.assertNotIn('Access-Control-Allow-Origin',headers)
        self.assertEqual(self.request('GET','/../app.py')[0],404)

    def test_host_origin_and_json_guards(self):
        self.assertEqual(self.request('GET','/api/state',headers={'Host':'evil.example'})[0],403)
        self.assertEqual(self.request('POST','/api/participants',{}, {'Content-Type':'application/json','Origin':'https://evil.example'})[0],403)
        self.assertEqual(self.request('POST','/api/participants',{}, {'Content-Type':'text/plain'})[0],415)
        self.assertEqual(self.request('POST','/api/participants',{'name':'Local','previously_attended':False},{'Content-Type':'application/json','Origin':f'http://127.0.0.1:{self.port}'})[0],201)
        self.assertEqual(self.request('POST','/api/participants',{}, {'Content-Type':'application/json','Origin':'null'})[0],403)


if __name__ == '__main__':
    unittest.main()
