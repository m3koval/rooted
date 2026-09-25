import unittest
from unittest.mock import patch
from integrations.breeze import BreezeReader, BreezeError

class BreezeTests(unittest.TestCase):
    def test_reject_untrusted_hosts(self):
        for host in ['http://church.breezechms.com','https://evil.test','https://church.breezechms.com.evil.test','https://x@y.breezechms.com','https://church.breezechms.com/path']:
            with self.assertRaises(ValueError): BreezeReader(host, 'secret')
    def test_request_keeps_key_out_of_url(self):
        r = BreezeReader('https://example.breezechms.com', 'secret')
        req = r._request('/api/events/attendance/list', {'instance_id':'123','type':'person'})
        self.assertNotIn('secret', req.full_url)
        self.assertEqual(req.get_header('Api-key'), 'secret')
    def test_no_write_paths(self):
        r=BreezeReader('https://example.breezechms.com','secret')
        with self.assertRaises(ValueError): r._request('/api/people/add',{})
    def test_details_minimized(self):
        r=BreezeReader('https://example.breezechms.com','secret')
        with patch.object(r,'_get',return_value=[]) as get:
            r.people_page(offset=0,limit=50)
        self.assertEqual(get.call_args.args[1]['details'],0)
    def test_ids_and_pagination_validated(self):
        r=BreezeReader('https://example.breezechms.com','secret')
        for ident in ['1&bad=2','../add','',True]:
            with self.assertRaises(ValueError): r.attendance(ident)
        with self.assertRaises(ValueError): r.people_page(limit=0)
    def test_rate_spacing(self):
        now=[0.0]
        def sleep(n): now[0]+=n
        r=BreezeReader('https://example.breezechms.com','secret',clock=lambda:now[0],sleep=sleep)
        r._pace(); self.assertEqual(now[0],0)
        r._pace(); self.assertEqual(now[0],3.5)
    def test_errors_do_not_leak_provider_body(self):
        import urllib.error, io
        r=BreezeReader('https://example.breezechms.com','secret')
        with patch.object(r._opener,'open',side_effect=urllib.error.HTTPError('url',401,'unauthorized',{},io.BytesIO(b'secret'))):
            with self.assertRaises(BreezeError) as result: r.people_page()
        self.assertNotIn('secret',str(result.exception))
    def test_response_shape(self):
        r=BreezeReader('https://example.breezechms.com','secret')
        with patch.object(r,'_get',return_value={'error':'bad'}):
            with self.assertRaises(BreezeError): r.people_page()

if __name__=='__main__': unittest.main()
