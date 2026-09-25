"""Independent local visual theme; never changes participation or draw data."""

from importlib import import_module


class Theme:
    FIELDS = ('name', 'study', 'tagline', 'scripture', 'artwork', 'enabled')
    DEFAULTS = ('REAL', 'James', 'Real Faith. Real Life. Real Fruit.',
                'James 1:22', 'tree', True)

    def __init__(self, store):
        self.store = store
        self._app = import_module(store.checkin.__module__)
        with store.connection(True) as db:
            db.execute('''CREATE TABLE IF NOT EXISTS app_theme (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                name TEXT NOT NULL,
                study TEXT NOT NULL,
                tagline TEXT NOT NULL,
                scripture TEXT NOT NULL,
                artwork TEXT NOT NULL CHECK (artwork IN ('tree','badge','wide')),
                enabled INTEGER NOT NULL CHECK (enabled IN (0,1))
            )''')
            db.execute('INSERT OR IGNORE INTO app_theme '
                       '(id,name,study,tagline,scripture,artwork,enabled) '
                       'VALUES (1,?,?,?,?,?,?)', self.DEFAULTS)

    @staticmethod
    def _result(db):
        result = dict(db.execute(
            'SELECT name,study,tagline,scripture,artwork,enabled '
            'FROM app_theme WHERE id=1').fetchone())
        result['enabled'] = bool(result['enabled'])
        return result

    def get(self):
        with self.store.connection() as db:
            return self._result(db)

    def update(self, data):
        if not isinstance(data, dict) or set(data) != set(self.FIELDS):
            raise self._app.AppError(
                'Exactly name, study, tagline, scripture, artwork and enabled are required.')
        values = {}
        for field, maximum in (('name', 60), ('study', 80), ('tagline', 160), ('scripture', 80)):
            value = data[field]
            if not isinstance(value, str) or len(value) > maximum:
                raise self._app.AppError(f'{field} must be text of at most {maximum} characters.')
            value = value.strip()
            if field != 'scripture' and not value:
                raise self._app.AppError(f'{field} must not be blank.')
            values[field] = value
        if not isinstance(data['artwork'], str) or data['artwork'] not in ('tree', 'badge', 'wide'):
            raise self._app.AppError('artwork must be tree, badge or wide.')
        if type(data['enabled']) is not bool:
            raise self._app.AppError('enabled must be a boolean.')
        values['artwork'] = data['artwork']
        values['enabled'] = data['enabled']
        with self.store.connection(True) as db:
            db.execute('UPDATE app_theme SET name=?,study=?,tagline=?,scripture=?,artwork=?,enabled=? '
                       'WHERE id=1', tuple(values[field] for field in self.FIELDS))
            return self._result(db)
