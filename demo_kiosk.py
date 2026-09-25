"""Launch a loopback-only, fictional-data Rooted self-check-in demo."""
import argparse
from datetime import date, timedelta
from pathlib import Path
from app import make_server


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db',default='data/self-checkin-demo.sqlite3')
    parser.add_argument('--port',type=int,default=8771)
    args=parser.parse_args()
    path=Path(args.db)
    if path.exists():
        parser.error('Choose a NEW database path for this demo. Existing databases are never changed or reset by this launcher.')
    server=make_server(path,args.port)
    store=server.store
    today=date.today()
    week=today-timedelta(days=today.weekday()+7)
    event=store.event({'name':'Fictional · Self-check-in practice','date':today.isoformat(),'reading_week':week.isoformat(),'fictional':True})
    for name in ('Avery Brooks','Jordan Ellis','Riley Chen','Morgan Lee','Sam Rivera','Taylor Quinn'):
        store.participant({'name':name,'previously_attended':name!='Taylor Quinn','fictional':True})
    with store.connection(True) as conn:
        conn.execute('UPDATE participants SET fictional=1')
        conn.execute('UPDATE events SET fictional=1')
    origin=f'http://127.0.0.1:{server.server_address[1]}'
    print(f'Fictional local pilot only. No authentication. Do not use real youth data.\nCheck-in: {origin}/check-in/?event={event["id"]}\nLeader tools: {origin}/leader/\nDatabase: {path.resolve()}\nCtrl+C stops the server.',flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__=='__main__':
    main()
