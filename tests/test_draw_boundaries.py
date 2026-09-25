import tempfile
import unittest
from pathlib import Path
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from app import Store

class DrawBoundaryTests(unittest.TestCase):
    def test_every_ticket_maps_to_correct_weight(self):
        with tempfile.TemporaryDirectory() as directory:
            store=Store(Path(directory)/'qa.db')
            eid=store.event({'name':'Synthetic test','date':'2026-09-24','reading_week':'2026-09-14'})['id']
            for name,chapters in [('Synthetic A',8),('Synthetic B',1),('Synthetic C',10)]:
                pid=store.participant({'name':name,'previously_attended':True})['id']
                store.checkin({'participant_id':pid,'event_id':eid,'attended':True,'bible':True,'chapters':chapters})
            weights={p['id']:p['points'] for p in store.state()['participants']}
            tally=Counter()
            for ticket in range(sum(weights.values())):
                with patch('app.secrets.randbelow',return_value=ticket):
                    result=store.draw({'event_id':eid,'prize':'Test','present_only':True,'one_win':False,'request_id':f'ticket-{ticket}'})
                tally[result['winner_id']]+=1
            self.assertEqual(dict(tally),weights)

    def test_concurrent_draw_retries_persist_once(self):
        with tempfile.TemporaryDirectory() as directory:
            store=Store(Path(directory)/'qa.db')
            eid=store.event({'name':'Synthetic test','date':'2026-09-24','reading_week':'2026-09-14'})['id']
            pid=store.participant({'name':'Synthetic A','previously_attended':True})['id']
            store.checkin({'participant_id':pid,'event_id':eid,'attended':True,'bible':True,'chapters':1})
            payload={'event_id':eid,'prize':'Test','present_only':True,'one_win':False,'request_id':'concurrent-request'}
            with ThreadPoolExecutor(max_workers=8) as pool:
                results=list(pool.map(lambda _:store.draw(payload),range(16)))
            self.assertEqual(len({r['id'] for r in results}),1)
            self.assertEqual(len(store.state()['draws']),1)
