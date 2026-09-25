import tempfile
import unittest
from pathlib import Path

from app import AppError, Store
from theme import Theme


DEFAULTS = {'name': 'REAL', 'study': 'James',
            'tagline': 'Real Faith. Real Life. Real Fruit.',
            'scripture': 'James 1:22', 'artwork': 'tree', 'enabled': True}


class ThemeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'theme.db'
        self.store = Store(self.path)
        self.theme = Theme(self.store)

    def test_defaults_and_singleton(self):
        self.assertEqual(self.theme.get(), DEFAULTS)
        self.assertIs(self.theme.get()['enabled'], True)
        Theme(self.store)
        with self.store.connection() as db:
            self.assertEqual([tuple(r) for r in db.execute('SELECT id FROM app_theme')], [(1,)])

    def test_update_persistence_and_new_instances(self):
        payload = dict(DEFAULTS, name='  New name  ', study='  Mark ',
                       tagline=' Live it. ', scripture='', artwork='badge', enabled=False)
        expected = dict(payload, name='New name', study='Mark', tagline='Live it.')
        self.assertEqual(self.theme.update(payload), expected)
        self.assertEqual(self.theme.get(), expected)
        self.assertIs(self.theme.get()['enabled'], False)
        self.assertEqual(Theme(self.store).get(), expected)
        self.assertEqual(Theme(Store(self.path)).get(), expected)
        self.assertEqual(payload['name'], '  New name  ')

    def test_lengths_and_artwork(self):
        for artwork in ('tree', 'badge', 'wide'):
            payload = dict(DEFAULTS, name='n' * 60, study='s' * 80,
                           tagline='t' * 160, scripture='r' * 80, artwork=artwork)
            self.assertEqual(self.theme.update(payload), payload)

    def test_invalid_payloads_do_not_mutate(self):
        invalid = [None, [], 'theme', True, {}, dict(DEFAULTS, extra='no'),
                   dict(DEFAULTS, url='https://example.com/art.webp'),
                   dict(DEFAULTS, upload='data:image/png;base64,abc')]
        for field in DEFAULTS:
            missing = dict(DEFAULTS)
            del missing[field]
            invalid.append(missing)
        for field, maximum in (('name', 60), ('study', 80), ('tagline', 160), ('scripture', 80)):
            for value in (None, 1, True, [], {}, 'x' * (maximum + 1)):
                invalid.append(dict(DEFAULTS, **{field: value}))
        for field in ('name', 'study', 'tagline'):
            for value in ('', ' \t\n '):
                invalid.append(dict(DEFAULTS, **{field: value}))
        for value in (0, 1, 'true', 'false', None, [], {}):
            invalid.append(dict(DEFAULTS, enabled=value))
        for value in ('', 'TREE', ' tree ', 'https://example.com/a.webp',
                      '../a.webp', 'data:image/png;base64,abc', None, 1, True, [], {}):
            invalid.append(dict(DEFAULTS, artwork=value))
        saved = self.theme.update(dict(DEFAULTS, artwork='wide', enabled=False))
        for payload in invalid:
            with self.subTest(payload=payload):
                with self.assertRaises(AppError):
                    self.theme.update(payload)
                self.assertEqual(self.theme.get(), saved)

    def test_switching_and_disabling_preserve_all_core_state(self):
        self.store.seed_demo()
        event_id = self.store.state()['events'][0]['id']
        self.store.draw({'event_id': event_id, 'prize': 'Fictional fixture',
                         'present_only': True, 'one_win': False,
                         'request_id': 'theme-invariant-fixture'})
        before = self.store.state()
        self.assertTrue(before['draws'])
        self.assertTrue(before['ledger'])
        self.assertTrue(before['reading_totals'])
        with self.store.connection() as db:
            schema_before = [tuple(r) for r in db.execute(
                "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name != 'app_theme' ORDER BY name")]
        for artwork, enabled in (('badge', True), ('wide', True), ('tree', False)):
            self.theme.update(dict(DEFAULTS, artwork=artwork, enabled=enabled))
            self.assertEqual(self.store.state(), before)
            self.assertEqual(Theme(Store(self.path)).get()['enabled'], enabled)
        with self.store.connection() as db:
            self.assertEqual([tuple(r) for r in db.execute(
                "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name != 'app_theme' ORDER BY name")], schema_before)


if __name__ == '__main__':
    unittest.main()
