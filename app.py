#!/usr/bin/env python3
"""ROOTED local-only pilot. Python standard library; no remote integrations."""
import argparse
from contextlib import contextmanager
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import sqlite3
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent


class AppError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def text(value, field, maximum=100):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
        raise AppError(f'{field} must be 1–{maximum} characters.')
    return value.strip()


def integer(value, field, minimum=0, maximum=100000):
    if type(value) is not int or not minimum <= value <= maximum:
        raise AppError(f'{field} must be an integer from {minimum} to {maximum}.')
    return value


def boolean(value, field):
    if type(value) is not bool:
        raise AppError(f'{field} must be true or false.')
    return value


def iso_date(value, field):
    try:
        result = date.fromisoformat(value)
        if result.isoformat() != value:
            raise ValueError()
        return result
    except (TypeError, ValueError):
        raise AppError(f'{field} must be a valid YYYY-MM-DD date.')


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


SCHEMA = '''
CREATE TABLE IF NOT EXISTS settings (
 id INTEGER PRIMARY KEY CHECK(id=1), attendance INTEGER NOT NULL CHECK(attendance>=0),
 bible INTEGER NOT NULL CHECK(bible>=0), friend INTEGER NOT NULL CHECK(friend>=0));
INSERT OR IGNORE INTO settings VALUES (1,5,2,10);
CREATE TABLE IF NOT EXISTS participants (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, breeze_id TEXT UNIQUE,
 previously_attended INTEGER NOT NULL CHECK(previously_attended IN (0,1)),
 fictional INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, date TEXT NOT NULL,
 reading_week TEXT NOT NULL, fictional INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checkins (
 id INTEGER PRIMARY KEY, participant_id INTEGER NOT NULL REFERENCES participants(id),
 event_id INTEGER NOT NULL REFERENCES events(id), attended INTEGER NOT NULL,
 bible INTEGER NOT NULL, chapters INTEGER NOT NULL CHECK(chapters>=0),
 inviter_id INTEGER REFERENCES participants(id), created_at TEXT NOT NULL,
 UNIQUE(participant_id,event_id));
CREATE TABLE IF NOT EXISTS reading_totals (
 participant_id INTEGER NOT NULL REFERENCES participants(id), week TEXT NOT NULL,
 chapters INTEGER NOT NULL, PRIMARY KEY(participant_id,week));
CREATE TABLE IF NOT EXISTS first_visits (
 participant_id INTEGER PRIMARY KEY REFERENCES participants(id),
 event_id INTEGER NOT NULL REFERENCES events(id), inviter_id INTEGER REFERENCES participants(id));
CREATE TABLE IF NOT EXISTS ledger (
 id INTEGER PRIMARY KEY, participant_id INTEGER NOT NULL REFERENCES participants(id),
 event_id INTEGER NOT NULL REFERENCES events(id), kind TEXT NOT NULL,
 points INTEGER NOT NULL CHECK(points>=0), source TEXT NOT NULL UNIQUE,
 note TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'Point ledger is immutable'); END;
CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'Point ledger is immutable'); END;
CREATE TABLE IF NOT EXISTS draws (
 id INTEGER PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
 event_id INTEGER NOT NULL REFERENCES events(id), prize TEXT NOT NULL,
 present_only INTEGER NOT NULL, one_win INTEGER NOT NULL,
 winner_id INTEGER NOT NULL REFERENCES participants(id), winner_name TEXT NOT NULL,
 weights TEXT NOT NULL, total_weight INTEGER NOT NULL, ticket INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS draws_no_update BEFORE UPDATE ON draws BEGIN SELECT RAISE(ABORT,'Draw history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS draws_no_delete BEFORE DELETE ON draws BEGIN SELECT RAISE(ABORT,'Draw history is immutable'); END;
'''


class Store:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript(SCHEMA)

    @contextmanager
    def connection(self, write=False):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        try:
            if write:
                db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def require(self, db, table, value):
        integer(value, table + ' ID', 1)
        row = db.execute(f'SELECT * FROM {table} WHERE id=?', (value,)).fetchone()
        if not row:
            raise AppError(f'{table.capitalize()} not found.', 404)
        return row

    def participant(self, data):
        name = text(data.get('name'), 'Name', 80)
        previous = boolean(data.get('previously_attended'), 'Previously attended')
        breeze = data.get('breeze_id') or None
        if breeze is not None:
            breeze = text(breeze, 'Breeze person ID', 80)
        with self.connection(True) as db:
            try:
                cursor = db.execute('INSERT INTO participants(name,breeze_id,previously_attended,created_at) VALUES (?,?,?,?)',
                                    (name,breeze,previous,now()))
            except sqlite3.IntegrityError:
                raise AppError('This Breeze person ID is already registered.', 409)
            return dict(self.require(db,'participants',cursor.lastrowid))

    def event(self, data):
        name = text(data.get('name'), 'Event name')
        day = iso_date(data.get('date'), 'Event date')
        week = iso_date(data.get('reading_week'), 'Reading week')
        if week.weekday() != 0:
            raise AppError('Reading week must start on a Monday. Choose the week being reported, not necessarily the event week.')
        with self.connection(True) as db:
            cursor = db.execute('INSERT INTO events(name,date,reading_week,created_at) VALUES (?,?,?,?)',
                                (name,day.isoformat(),week.isoformat(),now()))
            return dict(self.require(db,'events',cursor.lastrowid))

    def settings(self, data):
        values = [integer(data.get(k), k.title()+' DEMO points', maximum=1000) for k in ('attendance','bible','friend')]
        with self.connection(True) as db:
            db.execute('UPDATE settings SET attendance=?,bible=?,friend=? WHERE id=1',values)
        return dict(zip(('attendance','bible','friend'),values))

    def award(self, db, person, event, kind, points, source, note):
        db.execute('INSERT INTO ledger(participant_id,event_id,kind,points,source,note,created_at) VALUES (?,?,?,?,?,?,?)',
                   (person,event,kind,points,source,note,now()))

    def checkin(self, data):
        pid = integer(data.get('participant_id'),'Participant ID',1)
        eid = integer(data.get('event_id'),'Event ID',1)
        attended = boolean(data.get('attended'),'Attended')
        bible = boolean(data.get('bible'),'Brought Bible')
        chapters = integer(data.get('chapters'),'Weekly chapters')
        inviter = data.get('inviter_id') or None
        if inviter is not None:
            integer(inviter,'Inviter ID',1)
            if inviter == pid:
                raise AppError('A participant cannot invite themselves.')
        if bible and not attended:
            raise AppError('Bible points require attendance. Uncheck Bible for a reading-only record.')
        with self.connection(True) as db:
            person = self.require(db,'participants',pid)
            event = self.require(db,'events',eid)
            if inviter:
                self.require(db,'participants',inviter)
            old = db.execute('SELECT * FROM checkins WHERE participant_id=? AND event_id=?',(pid,eid)).fetchone()
            if old:
                if (old['attended'],old['bible'],old['chapters'],old['inviter_id']) != (attended,bible,chapters,inviter):
                    raise AppError('This event record is locked. Repeated identical submissions are safe; corrections need a future audited adjustment workflow.',409)
                return {'id':old['id'],'duplicate':True}
            cursor = db.execute('INSERT INTO checkins(participant_id,event_id,attended,bible,chapters,inviter_id,created_at) VALUES (?,?,?,?,?,?,?)',
                                (pid,eid,attended,bible,chapters,inviter,now()))
            cid = cursor.lastrowid
            config = db.execute('SELECT * FROM settings WHERE id=1').fetchone()
            if attended:
                self.award(db,pid,eid,'attendance',config['attendance'],f'attendance:{cid}','Attended · DEMO rate')
                if bible:
                    self.award(db,pid,eid,'bible',config['bible'],f'bible:{cid}','Brought Bible · DEMO rate')
                first = db.execute('SELECT 1 FROM first_visits WHERE participant_id=?',(pid,)).fetchone()
                if not first:
                    db.execute('INSERT INTO first_visits VALUES (?,?,?)',(pid,eid,inviter))
                    if inviter and not person['previously_attended']:
                        self.award(db,inviter,eid,'friend',config['friend'],f'friend:{pid}',f'First attended visit: {person["name"]} · DEMO rate')
            prior = db.execute('SELECT chapters FROM reading_totals WHERE participant_id=? AND week=?',(pid,event['reading_week'])).fetchone()
            previous = prior['chapters'] if prior else 0
            if chapters > previous:
                db.execute('INSERT INTO reading_totals VALUES (?,?,?) ON CONFLICT(participant_id,week) DO UPDATE SET chapters=excluded.chapters',
                           (pid,event['reading_week'],chapters))
                self.award(db,pid,eid,'reading',chapters-previous,f'reading:{pid}:{event["reading_week"]}:{chapters}',
                           f'Week {event["reading_week"]}: cumulative {previous} → {chapters} chapters (1 point each)')
            return {'id':cid,'duplicate':False}

    @staticmethod
    def draw_dict(row):
        result = dict(row)
        result.pop('payload',None)
        result['weights'] = json.loads(result['weights'])
        result['present_only'] = bool(result['present_only'])
        result['one_win'] = bool(result['one_win'])
        return result

    def draw(self, data):
        eid = integer(data.get('event_id'),'Event ID',1)
        prize = text(data.get('prize'),'Prize',120)
        present = boolean(data.get('present_only'),'Present-only')
        one_win = boolean(data.get('one_win'),'One win per event')
        request_id = text(data.get('request_id'),'Draw request ID',120)
        payload = json.dumps([eid,prize,present,one_win])
        with self.connection(True) as db:
            existing = db.execute('SELECT * FROM draws WHERE request_id=?',(request_id,)).fetchone()
            if existing:
                if existing['payload'] != payload:
                    raise AppError('That draw request ID was already used with different options.',409)
                return self.draw_dict(existing)
            self.require(db,'events',eid)
            rows = db.execute('SELECT p.id,p.name,COALESCE(SUM(l.points),0) weight FROM participants p LEFT JOIN ledger l ON p.id=l.participant_id GROUP BY p.id HAVING weight>0 ORDER BY p.id').fetchall()
            present_ids = {r[0] for r in db.execute('SELECT participant_id FROM checkins WHERE event_id=? AND attended=1',(eid,))}
            winners = {r[0] for r in db.execute('SELECT winner_id FROM draws WHERE event_id=?',(eid,))}
            weights = [{'participant_id':r['id'],'name':r['name'],'weight':r['weight']} for r in rows
                       if (not present or r['id'] in present_ids) and (not one_win or r['id'] not in winners)]
            total = sum(r['weight'] for r in weights)
            if not total:
                raise AppError('No eligible positive-point entries. Check attendance, points, and previous-winner exclusions.',422)
            ticket = secrets.randbelow(total)
            cumulative = 0
            for row in weights:
                cumulative += row['weight']
                if ticket < cumulative:
                    winner = row
                    break
            cursor = db.execute('INSERT INTO draws(request_id,payload,event_id,prize,present_only,one_win,winner_id,winner_name,weights,total_weight,ticket,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                (request_id,payload,eid,prize,present,one_win,winner['participant_id'],winner['name'],json.dumps(weights),total,ticket,now()))
            return self.draw_dict(db.execute('SELECT * FROM draws WHERE id=?',(cursor.lastrowid,)).fetchone())

    def state(self):
        with self.connection() as db:
            db.execute('BEGIN')  # One consistent snapshot across all collections.
            return {
                'participants':[dict(r) for r in db.execute('SELECT p.*,COALESCE(SUM(l.points),0) points,COALESCE(SUM(CASE WHEN l.kind="reading" THEN l.points ELSE 0 END),0) chapters FROM participants p LEFT JOIN ledger l ON p.id=l.participant_id GROUP BY p.id ORDER BY points DESC,p.name COLLATE NOCASE,p.id')],
                'events':[dict(r) for r in db.execute('SELECT * FROM events ORDER BY date DESC,id DESC')],
                'checkins':[dict(r) for r in db.execute('SELECT * FROM checkins ORDER BY id')],
                'ledger':[dict(r) for r in db.execute('SELECT l.*,p.name,e.name event_name FROM ledger l JOIN participants p ON p.id=l.participant_id JOIN events e ON e.id=l.event_id ORDER BY l.id DESC')],
                'reading_totals':[dict(r) for r in db.execute('SELECT * FROM reading_totals')],
                'first_visits':[dict(r) for r in db.execute('SELECT * FROM first_visits')],
                'draws':[self.draw_dict(r) for r in db.execute('SELECT * FROM draws ORDER BY id DESC')],
                'settings':dict(db.execute('SELECT attendance,bible,friend FROM settings WHERE id=1').fetchone()),
                'breeze':{'connected':False,'status':'Disconnected — no sync implemented'},
                'demo':bool(db.execute('SELECT 1 FROM participants WHERE fictional=1 LIMIT 1').fetchone()),
            }

    def seed_demo(self):
        # Seed in one transaction; only an empty pilot can accept fictional data.
        with self.connection(True) as db:
            if any(db.execute(f'SELECT 1 FROM {t} LIMIT 1').fetchone() for t in ('participants','events','ledger','draws')):
                raise AppError('Demo seed requires an empty database. Use a separate --db path.',409)
            names = ['Avery Brooks','Jordan Ellis','Riley Chen','Sam Rivera','Taylor Quinn','Morgan Reed']
            for name in names:
                db.execute('INSERT INTO participants(name,previously_attended,fictional,created_at) VALUES (?,1,1,?)',(name,now()))
            db.execute('INSERT INTO events(name,date,reading_week,fictional,created_at) VALUES (?,?,?,1,?)',
                       ('Fictional • Thursday gathering','2026-09-24','2026-09-21',now()))
            eid = db.execute('SELECT id FROM events').fetchone()[0]
            for i,row in enumerate(db.execute('SELECT id FROM participants').fetchall()):
                pid = row[0]
                chapters = [8,5,3,6,2,0][i]
                db.execute('INSERT INTO checkins(participant_id,event_id,attended,bible,chapters,created_at) VALUES (?,?,1,1,?,?)',(pid,eid,chapters,now()))
                cid = db.execute('SELECT last_insert_rowid()').fetchone()[0]
                self.award(db,pid,eid,'attendance',5,f'attendance:{cid}','Fictional demo attendance')
                self.award(db,pid,eid,'bible',2,f'bible:{cid}','Fictional demo Bible')
                db.execute('INSERT INTO first_visits VALUES (?,?,NULL)',(pid,eid))
                if chapters:
                    db.execute('INSERT INTO reading_totals VALUES (?,?,?)',(pid,'2026-09-21',chapters))
                    self.award(db,pid,eid,'reading',chapters,f'reading:{pid}:2026-09-21:{chapters}','Fictional demo · week 2026-09-21')
        return {'seeded':True}


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    server_version = 'RootedLocal/1.0'

    def log_message(self, fmt, *args):
        # Do not log names or request payloads; local diagnostics only.
        print('%s %s' % (self.address_string(),fmt % args))

    def send(self, status, content, mime='application/json; charset=utf-8'):
        body = json.dumps(content).encode() if mime.startswith('application/json') else content
        self.send_response(status)
        self.send_header('Content-Type',mime)
        self.send_header('Content-Length',str(len(body)))
        self.send_header('Cache-Control','no-store')
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Connection','close')
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def guard(self, mutation=False):
        hosts = self.headers.get_all('Host',[])
        port = self.server.server_address[1]
        allowed = {f'127.0.0.1:{port}',f'localhost:{port}'}
        if port == 80:
            allowed.update({'127.0.0.1','localhost'})
        if len(hosts) != 1 or hosts[0] not in allowed:
            raise AppError('Local Host required.',403)
        if mutation:
            origins = self.headers.get_all('Origin',[])
            if len(origins)>1 or (origins and origins[0] != 'http://'+hosts[0]):
                raise AppError('Same local Origin required.',403)
            if self.headers.get('Sec-Fetch-Site') == 'cross-site':
                raise AppError('Cross-site requests are not allowed.',403)

    def do_GET(self):
        try:
            self.guard()
            path = urlsplit(self.path).path
            if path == '/api/theme':
                return self.send(200,self.server.theme.get())
            if path == '/api/state':
                return self.send(200,self.server.store.state())
            files = {'/':('kiosk.html','text/html; charset=utf-8'),
                     '/check-in/':('kiosk.html','text/html; charset=utf-8'),
                     '/leader/':('index.html','text/html; charset=utf-8'),
                     '/theme.js':('theme.js','text/javascript; charset=utf-8'),
                     '/theme.css':('theme.css','text/css; charset=utf-8'),
                     '/real-tree.webp':('real-tree.webp','image/webp'),
                     '/real-badge.webp':('real-badge.webp','image/webp'),
                     '/real-wide.webp':('real-wide.webp','image/webp'),
                     '/kiosk.js':('kiosk.js','text/javascript; charset=utf-8'),
                     '/kiosk.css':('kiosk.css','text/css; charset=utf-8'),
                     '/kiosk-regular.ttf':('kiosk-regular.ttf','font/ttf'),
                     '/kiosk-bold.ttf':('kiosk-bold.ttf','font/ttf'),
                     '/kiosk-forest.jpg':('kiosk-forest.jpg','image/jpeg'),
                     '/app.js':('app.js','text/javascript; charset=utf-8'),
                     '/style.css':('style.css','text/css; charset=utf-8')}
            if path not in files:
                raise AppError('Not found.',404)
            filename,mime = files[path]
            self.send(200,(ROOT/'static'/filename).read_bytes(),mime)
        except AppError as exc:
            self.send(exc.status,{'error':str(exc)})

    def do_POST(self):
        try:
            self.guard(True)
            if self.headers.get_content_type() != 'application/json':
                raise AppError('Content-Type application/json required.',415)
            if self.headers.get('Transfer-Encoding'):
                raise AppError('Transfer-Encoding is not supported.')
            lengths = self.headers.get_all('Content-Length',[])
            if len(lengths)!=1 or not lengths[0].isdigit():
                raise AppError('One valid Content-Length is required.',411)
            length = int(lengths[0])
            if length > 16384:
                raise AppError('Request too large.',413)
            self.connection.settimeout(5)
            try:
                data = json.loads(self.rfile.read(length))
            except (ValueError,UnicodeError):
                raise AppError('Invalid JSON.')
            if not isinstance(data,dict):
                raise AppError('JSON body must be an object.')
            if self.path == '/api/theme':
                return self.send(200,self.server.theme.update(data))
            kiosk_routes = {
                '/api/kiosk/context':self.server.kiosk.context,
                '/api/kiosk/search':self.server.kiosk.search,
                '/api/kiosk/person':self.server.kiosk.person,
                '/api/kiosk/checkin':self.server.kiosk.checkin,
            }
            if self.path in kiosk_routes:
                result = kiosk_routes[self.path](data)
                return self.send(201 if self.path == '/api/kiosk/checkin' else 200,result)
            routes = {'/api/participants':self.server.store.participant,'/api/events':self.server.store.event,
                      '/api/checkins':self.server.store.checkin,'/api/settings':self.server.store.settings,
                      '/api/draws':self.server.store.draw,'/api/demo':lambda _:self.server.store.seed_demo()}
            route = routes.get(self.path)
            if not route:
                raise AppError('Not found.',404)
            self.send(201,route(data))
        except AppError as exc:
            self.send(exc.status,{'error':str(exc)})
        except (sqlite3.Error,OSError):
            self.send(503,{'error':'Local storage or request unavailable. Retry the same request; do not create a new draw request.'})


def make_server(db_path, port=8769):
    server = LocalServer(('127.0.0.1',port),Handler)
    server.store = Store(db_path)
    from kiosk import Kiosk
    server.kiosk = Kiosk(server.store)
    from theme import Theme
    server.theme = Theme(server.store)
    return server


def main():
    parser = argparse.ArgumentParser(description='ROOTED local-only pilot. No authentication. Never expose publicly.')
    parser.add_argument('--port',type=int,default=8769)
    parser.add_argument('--db',type=Path,default=ROOT/'data'/'rooted.sqlite3')
    parser.add_argument('--seed-demo',action='store_true',help='Seed fictional data into an empty database only')
    args = parser.parse_args()
    if args.seed_demo:
        try:
            Store(args.db).seed_demo()
        except AppError as exc:
            parser.error(str(exc))
    server = make_server(args.db,args.port)
    print(f'ROOTED LOCAL ONLY · NOT PRODUCTION READY\nhttp://127.0.0.1:{server.server_address[1]}\nDatabase: {args.db}\nBreeze disconnected. Ctrl-C to stop.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    # Keep the API adapter and HTTP handler on the same AppError class.
    import sys
    sys.modules['app'] = sys.modules[__name__]
    main()
