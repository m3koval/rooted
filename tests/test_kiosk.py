import concurrent.futures
import tempfile
import unittest
from pathlib import Path

from app import AppError, Store
from kiosk import Kiosk


class KioskTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(Path(self.tmp.name) / 'fictional.sqlite')
        self.kiosk = Kiosk(self.store)
        self.eid = self.event()
        self.pid = self.participant('Alex Example')
        self.data = dict(event_id=self.eid, participant_id=self.pid, bible=True, chapters=3)

    def event(self, fictional=1):
        row = self.store.event(dict(name='Fictional gathering', date='2026-09-24', reading_week='2026-09-21'))
        with self.store.connection(True) as db:
            db.execute('UPDATE events SET fictional=? WHERE id=?', (fictional, row['id']))
        return row['id']

    def participant(self, name, fictional=1, previous=True):
        row = self.store.participant(dict(name=name, previously_attended=previous))
        with self.store.connection(True) as db:
            db.execute('UPDATE participants SET fictional=? WHERE id=?', (fictional, row['id']))
        return row['id']

    def error(self, status, fn, data):
        with self.assertRaises(AppError) as caught:
            fn(data)
        self.assertEqual(status, caught.exception.status)

    def test_context_minimal_and_explicit_event(self):
        result = self.kiosk.context({'event_id': self.eid})
        self.assertEqual(set(result), {'event', 'rates'})
        self.assertEqual(set(result['event']), {'id', 'name', 'date', 'reading_week'})
        self.assertEqual(result['rates'], dict(attendance=5, bible=2, friend=10))
        for method in (self.kiosk.context, self.kiosk.search, self.kiosk.person, self.kiosk.checkin):
            for value in (None, True, '1', 0):
                self.error(400, method, dict(self.data, event_id=value))
            self.error(400, method, {})

    def test_nonfictional_guards_no_mutation(self):
        real_event = self.event(0)
        real_person = self.participant('Real name', fictional=0)
        before = self.store.state()
        for method in (self.kiosk.context, self.kiosk.search, self.kiosk.person, self.kiosk.checkin):
            data = dict(self.data, event_id=real_event)
            if method == self.kiosk.search:
                data['query'] = 'Alex'
            self.error(403, method, data)
        for method in (self.kiosk.person, self.kiosk.checkin):
            self.error(403, method, dict(self.data, participant_id=real_person))
        self.error(403, self.kiosk.search, dict(event_id=self.eid, query='Real'))
        self.assertEqual(before, self.store.state())

    def test_search_short_literal_bounded_minimal(self):
        for query in ('', 'A', ' '):
            self.assertEqual(self.kiosk.search(dict(event_id=self.eid, query=query)), dict(matches=[], truncated=False))
        special = self.participant('Literal %_\\ Name')
        self.assertEqual(self.kiosk.search(dict(event_id=self.eid, query='%_'))['matches'], [dict(id=special, name='Literal %_\\ Name')])
        for n in range(12):
            self.participant(f'Match {n:02d}')
        result = self.kiosk.search(dict(event_id=self.eid, query='match'))
        self.assertTrue(result['truncated'])
        self.assertEqual(len(result['matches']), 8)
        self.assertEqual([r['name'] for r in result['matches']], [f'Match {n:02d}' for n in range(8)])
        self.assertTrue(all(set(r) == {'id', 'name'} for r in result['matches']))
        for query in (None, 1, 'x' * 81):
            self.error(400, self.kiosk.search, dict(event_id=self.eid, query=query))

    def test_new_guest_and_reading_only_need_leader(self):
        guest = self.participant('New Guest', previous=False)
        for pid in (guest, self.pid):
            if pid == self.pid:
                self.store.checkin(dict(self.data, attended=False, bible=False, chapters=2))
            data = dict(self.data, participant_id=pid)
            result = self.kiosk.person(data)
            self.assertFalse(result['already_checked_in'])
            self.assertTrue(result['needs_leader'])
            before = self.store.state()
            self.error(409, self.kiosk.checkin, data)
            self.assertEqual(before, self.store.state())

    def test_receipt_retry_conflict_and_referral_exclusion(self):
        initial = self.kiosk.person(self.data)
        self.assertEqual(initial, dict(person=dict(id=self.pid, name='Alex Example'), already_checked_in=False, needs_leader=False, prior_chapters=0, receipt=None))
        result = self.kiosk.checkin(self.data)
        self.assertFalse(result['duplicate'])
        self.assertEqual(result['receipt']['earned_points'], 10)
        self.assertEqual(sum(c['points'] for c in result['receipt']['components']), 10)
        self.assertTrue(all(set(c) == {'label', 'points'} for c in result['receipt']['components']))
        guest = self.participant('Invited Guest', previous=False)
        self.store.checkin(dict(self.data, participant_id=guest, attended=True, inviter_id=self.pid))
        self.store.settings(dict(attendance=99, bible=99, friend=99))
        retry = self.kiosk.checkin(self.data)
        self.assertEqual(retry, dict(duplicate=True, receipt=result['receipt']))
        person = self.kiosk.person(self.data)
        self.assertTrue(person['already_checked_in'])
        self.assertFalse(person['needs_leader'])
        self.assertEqual(person['receipt'], result['receipt'])
        before = self.store.state()
        self.error(409, self.kiosk.checkin, dict(self.data, chapters=4))
        self.assertEqual(before, self.store.state())

    def test_weekly_incremental_and_first_visit_already_verified(self):
        guest = self.participant('Verified Guest', previous=False)
        self.store.checkin(dict(self.data, participant_id=guest, attended=True, chapters=5))
        second = self.event()
        data = dict(self.data, event_id=second, participant_id=guest, chapters=7)
        person = self.kiosk.person(data)
        self.assertEqual(person['prior_chapters'], 5)
        self.assertFalse(person['needs_leader'])
        self.assertEqual(self.kiosk.checkin(data)['receipt']['earned_points'], 9)

    def test_rejects_extra_and_invalid_fields(self):
        before = self.store.state()
        for key in ('points', 'earned_points', 'attended', 'inviter', 'inviter_id'):
            self.error(400, self.kiosk.checkin, dict(self.data, **{key: 1}))
        for key, value in [('participant_id', True), ('bible', 1), ('bible', None), ('chapters', -1), ('chapters', True), ('chapters', '3')]:
            self.error(400, self.kiosk.checkin, dict(self.data, **{key: value}))
        for key in self.data:
            self.error(400, self.kiosk.checkin, {k: v for k, v in self.data.items() if k != key})
        for value in (None, [], 'bad'):
            self.error(400, self.kiosk.checkin, value)
        self.assertEqual(before, self.store.state())

    def test_concurrent_identical_submissions(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(self.kiosk.checkin, [self.data] * 4))
        self.assertEqual(sum(not r['duplicate'] for r in results), 1)
        self.assertTrue(all(r['receipt'] == results[0]['receipt'] for r in results))
        self.assertEqual(len(self.store.state()['checkins']), 1)


if __name__ == '__main__':
    unittest.main()
