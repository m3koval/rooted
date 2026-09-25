"""Minimal self-check-in for the local fictional pilot; not authentication."""

from contextlib import contextmanager
from copy import copy
from importlib import import_module


class Kiosk:
    def __init__(self, store):
        self.store = store
        # Resolve helpers from Store's defining module, including when app.py is
        # run as __main__. No top-level app import or second AppError class.
        self._app = import_module(store.checkin.__module__)

    def _data(self, data):
        if not isinstance(data, dict):
            raise self._app.AppError('A JSON object is required.')
        return data

    def _event(self, db, data):
        self._data(data)
        event = self.store.require(db, 'events', data.get('event_id'))
        if event['fictional'] != 1:
            raise self._app.AppError('Self check-in is limited to fictional events.', 403)
        return event

    def _participant(self, db, data):
        person = self.store.require(db, 'participants', data.get('participant_id'))
        if person['fictional'] != 1:
            raise self._app.AppError('Self check-in is limited to fictional participants.', 403)
        return person

    @staticmethod
    def _old(db, pid, eid):
        return db.execute('SELECT * FROM checkins WHERE participant_id=? AND event_id=?',
                          (pid, eid)).fetchone()

    @staticmethod
    def _needs_leader(db, person, old):
        if old is not None:
            return not bool(old['attended'])
        return not person['previously_attended'] and not db.execute(
            'SELECT 1 FROM first_visits WHERE participant_id=?', (person['id'],)).fetchone()

    @staticmethod
    def _receipt(db, pid, eid, old):
        if old is None:
            return None
        labels = {'attendance': 'Attendance', 'bible': 'Brought Bible', 'reading': 'Bible reading'}
        rows = db.execute(
            "SELECT kind, SUM(points) AS points FROM ledger "
            "WHERE participant_id=? AND event_id=? AND kind IN ('attendance','bible','reading') "
            "GROUP BY kind ORDER BY CASE kind WHEN 'attendance' THEN 0 WHEN 'bible' THEN 1 ELSE 2 END",
            (pid, eid)).fetchall()
        components = [{'label': labels[row['kind']], 'points': row['points']} for row in rows]
        return {'checkin_id': old['id'], 'earned_points': sum(row['points'] for row in rows),
                'components': components}

    def context(self, data):
        with self.store.connection() as db:
            db.execute('BEGIN')
            event = self._event(db, data)
            return {'event': {k: event[k] for k in ('id', 'name', 'date', 'reading_week')},
                    'rates': dict(db.execute('SELECT attendance,bible,friend FROM settings WHERE id=1').fetchone())}

    def search(self, data):
        with self.store.connection() as db:
            db.execute('BEGIN')
            self._event(db, data)
            query = data.get('query')
            if not isinstance(query, str) or len(query) > 80:
                raise self._app.AppError('Search must be text of at most 80 characters.')
            query = query.strip()
            if len(query) < 2:
                return {'matches': [], 'truncated': False}
            pattern = '%' + query.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
            # Reject a matching real participant rather than disclose any name.
            if db.execute("SELECT 1 FROM participants WHERE fictional<>1 AND name LIKE ? ESCAPE '\\' LIMIT 1",
                          (pattern,)).fetchone():
                raise self._app.AppError('Self check-in is limited to fictional participants.', 403)
            rows = db.execute("SELECT id,name FROM participants WHERE fictional=1 AND name LIKE ? ESCAPE '\\' "
                              'ORDER BY name COLLATE NOCASE, id LIMIT 9', (pattern,)).fetchall()
            return {'matches': [dict(row) for row in rows[:8]], 'truncated': len(rows) > 8}

    def person(self, data):
        with self.store.connection() as db:
            db.execute('BEGIN')
            event = self._event(db, data)
            person = self._participant(db, data)
            old = self._old(db, person['id'], event['id'])
            prior = db.execute('SELECT chapters FROM reading_totals WHERE participant_id=? AND week=?',
                               (person['id'], event['reading_week'])).fetchone()
            return {'person': {'id': person['id'], 'name': person['name']},
                    'already_checked_in': bool(old and old['attended']),
                    'needs_leader': bool(self._needs_leader(db, person, old)),
                    'prior_chapters': prior['chapters'] if prior else 0,
                    'receipt': self._receipt(db, person['id'], event['id'], old)}

    def checkin(self, data):
        self._data(data)
        if set(data) != {'event_id', 'participant_id', 'bible', 'chapters'}:
            raise self._app.AppError('Only event_id, participant_id, bible and chapters are required and allowed.')
        bible = self._app.boolean(data['bible'], 'Brought Bible')
        chapters = self._app.integer(data['chapters'], 'Weekly chapters')
        # The guard and Store.checkin share one write transaction: no race can
        # change fictional/first-visit status between validation and insertion.
        with self.store.connection(True) as db:
            event = self._event(db, data)
            person = self._participant(db, data)
            old = self._old(db, person['id'], event['id'])
            if self._needs_leader(db, person, old):
                raise self._app.AppError('Please ask a leader to help with this check-in.', 409)

            @contextmanager
            def bound_connection(write=False):
                yield db

            # Do not mutate the shared Store (HTTP requests may be concurrent).
            # Reuse its transaction/idempotency/ledger implementation unchanged.
            bound_store = copy(self.store)
            bound_store.connection = bound_connection
            saved = bound_store.checkin({'event_id': event['id'], 'participant_id': person['id'],
                                         'bible': bool(bible), 'chapters': chapters,
                                         'attended': True, 'inviter_id': None})
            old = self._old(db, person['id'], event['id'])
            return {'duplicate': saved['duplicate'],
                    'receipt': self._receipt(db, person['id'], event['id'], old)}
