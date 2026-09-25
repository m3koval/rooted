// Mocked upstream transport tests; these do not prove hosted SQL behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler } from '../web/api/station.js';
const token = 'a'.repeat(64), id = '11111111-1111-4111-8111-111111111111';
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-only', NODE_ENV: 'production' };
const success = { ok:true, device_token:'b'.repeat(64), event_id:id, expires_at:'2026-10-01T01:00:00Z' };
function req(options = {}) {
 const {headers, raw, ...rest}=options;
 return Object.assign(Readable.from(raw === undefined ? [] : [raw]), {method:'POST',url:'/api/station',socket:{remoteAddress:'127.0.0.1'},headers:{host:'rooted.example',origin:'https://rooted.example','content-type':'application/json','sec-fetch-site':'same-origin','x-rooted-station':token,...headers},...(raw === undefined ? {body:{action:'unlock',pin:'012345'}} : {}),...rest});
}
async function invoke(handler, options) {
 const headers={}; let raw;
 const res={setHeader:(k,v)=>headers[k]=v,end:v=>raw=v};
 await handler(req(options),res);
 assert.equal(headers['Cache-Control'],'no-store, max-age=0');
 assert.equal(headers['Access-Control-Allow-Origin'],undefined);
 return {status:res.statusCode,data:JSON.parse(raw),headers};
}
function setup(data=success,status=200) {
 const calls=[]; const handler=createHandler({env,fetchImpl:async(url,options)=>{calls.push({url:String(url),...options});return new Response(JSON.stringify(data),{status});}});
 return {handler,calls};
}
test('unlock uses fixed RPC, preserves PIN leading zero, strips extras',async()=>{
 const {handler,calls}=setup({...success,leader_email:'private'});
 const r=await invoke(handler); assert.deepEqual(r.data,success); assert.equal(r.status,200);
 assert.equal(calls[0].url,'https://example.supabase.co/rest/v1/rpc/rooted_station_unlock');
 assert.deepEqual(JSON.parse(calls[0].body),{p_station_token:token,p_pin:'012345'});
 assert.equal(calls[0].headers.Authorization,'Bearer test-only');
});
test('lock uses fixed revoke RPC and device header',async()=>{
 const {handler,calls}=setup({ok:true,private:'hidden'});
 const r=await invoke(handler,{body:{action:'lock'},headers:{'x-rooted-station':undefined,'x-rooted-device':token}});
 assert.deepEqual(r.data,{ok:true}); assert.equal(calls[0].url,'https://example.supabase.co/rest/v1/rpc/rooted_station_lock');
 assert.deepEqual(JSON.parse(calls[0].body),{p_token:token});
});
for (const [name,options,status] of [
 ['GET',{method:'GET'},405],['origin',{headers:{origin:'https://evil.example'}},403],['missing origin',{headers:{origin:undefined}},403],['cross site',{headers:{'sec-fetch-site':'cross-site'}},403],
 ['query',{url:'/api/station?pin=012345'},400],['token missing',{headers:{'x-rooted-station':undefined}},403],['token uppercase',{headers:{'x-rooted-station':'A'.repeat(64)}},403],['duplicate header',{headers:{'x-rooted-station':[token,token]}},403],
 ['media',{headers:{'content-type':'text/plain'}},415],['encoding',{headers:{'content-encoding':'gzip'}},415],['oversize',{raw:' '.repeat(8193)},413],['invalid JSON',{raw:'{'},400],
 ['unknown action',{body:{action:'enroll',pin:'012345'}},400],['numeric PIN',{body:{action:'unlock',pin:123456}},400],['PIN length',{body:{action:'unlock',pin:'12345'}},400],['extra body',{body:{action:'unlock',pin:'012345',rpc:'evil'}},400],['lock PIN',{body:{action:'lock',pin:'012345'}},400],['wrong lock header',{body:{action:'lock'}},403]
]) test(`reject ${name} without upstream`,async()=>{const {handler,calls}=setup(); assert.equal((await invoke(handler,options)).status,status);assert.equal(calls.length,0);});
test('documented DB failures pass safely with no automatic retry',async()=>{
 for (const error of ['invalid_station','invalid_pin','locked','event_closed']) {const {handler,calls}=setup({ok:false,error,private:'hidden'});assert.deepEqual((await invoke(handler)).data,{ok:false,error});assert.equal(calls.length,1);}
});
test('unknown failures and SQL details never leak',async()=>{
 assert.deepEqual((await invoke(setup({ok:false,error:'secret'}).handler)).data,{ok:false,error:'unavailable'});
 assert.deepEqual((await invoke(setup({message:'secret'},400).handler)).data,{error:'unavailable'});
 assert.equal((await invoke(setup({ok:true}).handler)).status,502);
});
test('network failure remains uncertain',async()=>{
 const h=createHandler({env,fetchImpl:async()=>{throw new Error('secret');}});
 assert.deepEqual((await invoke(h,{body:{action:'lock'},headers:{'x-rooted-device':token}})).data,{error:'unavailable'});
});
test('unlock proxy throttling supplements persistent DB throttle',async()=>{
 const {handler,calls}=setup({ok:false,error:'invalid_pin'});
 for(let i=0;i<12;i++) assert.equal((await invoke(handler)).status,200);
 assert.equal((await invoke(handler)).status,429);assert.equal(calls.length,12);
});
