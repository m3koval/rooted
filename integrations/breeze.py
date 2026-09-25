"""Optional read-only Breeze transport; not wired to pilot. No network on import.
One instance per account/process; rate pacing is NOT distributed across processes.
Never use the historical PHP wrapper's disabled TLS verification behavior.
"""
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

class BreezeError(RuntimeError):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

class BreezeReader:
    ALLOWED = frozenset(['/api/people','/api/tags','/api/events','/api/events/attendance/list'])

    def __init__(self, base_url, api_key, *, clock=time.monotonic, sleep=time.sleep):
        if not isinstance(base_url,str) or not re.fullmatch(r'https://[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.breezechms\.com',base_url):
            raise ValueError('Expected exact HTTPS Breeze tenant origin, without trailing slash.')
        if not isinstance(api_key,str) or not api_key or any(ord(c)<33 or ord(c)>126 for c in api_key):
            raise ValueError('Invalid API key.')
        self.base_url=base_url
        self._key=api_key
        self._clock=clock
        self._sleep=sleep
        self._last=None
        self._lock=threading.Lock()
        self._opener=urllib.request.build_opener(NoRedirect())

    @staticmethod
    def _id(value):
        if isinstance(value,bool) or not re.fullmatch(r'[0-9]+',str(value)):
            raise ValueError('Expected a numeric Breeze identifier.')
        return str(value)

    def _pace(self):
        if self._last is not None:
            delay=3.5-(self._clock()-self._last)
            if delay>0: self._sleep(delay)
        self._last=self._clock()

    def _request(self,path,params):
        if path not in self.ALLOWED: raise ValueError('Read-only endpoint not allowed.')
        return urllib.request.Request(self.base_url+path+'?'+urllib.parse.urlencode(params),headers={'Api-key':self._key,'Accept':'application/json','User-Agent':'Rooted-readonly-pilot/0.1'},method='GET')

    def _get(self,path,params):
        request=self._request(path,params)
        with self._lock:
            self._pace()
            try:
                with self._opener.open(request,timeout=15) as response:
                    body=response.read(2_000_001)
                if len(body)>2_000_000: raise BreezeError('Breeze response too large; reduce page size.')
                return json.loads(body)
            except urllib.error.HTTPError as e:
                raise BreezeError(f'Breeze HTTP {e.code}; no automatic retry performed.') from None
            except (urllib.error.URLError,TimeoutError,OSError):
                raise BreezeError('Breeze connection failed; no automatic retry performed.') from None
            except (ValueError,UnicodeError):
                raise BreezeError('Breeze returned invalid JSON.') from None

    def people_page(self,*,offset=0,limit=50):
        if type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=100:
            raise ValueError('Use nonnegative offset and page size 1–100.')
        data=self._get('/api/people',{'details':0,'offset':offset,'limit':limit})
        if not isinstance(data,list): raise BreezeError('Unexpected Breeze people response; verify account schema.')
        return data

    def tags(self):
        return self._get('/api/tags',{})

    def attendance(self,instance_id):
        return self._get('/api/events/attendance/list',{'instance_id':self._id(instance_id),'type':'person'})
