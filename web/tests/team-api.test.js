import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, validateBody } from '../api/team.js';
const env={SUPABASE_URL:'https://sfrkowqljeaztupywtzy.supabase.co',SUPABASE_ANON_KEY:'sb_publishable_mock_only',TEAM_ORIGIN:'https://www.rooted3d.com'};
const id='11111111-1111-4111-8111-111111111111';
function request(body,extra={}) { return { method:'POST',url:'/api/team',headers:{origin:env.TEAM_ORIGIN,host:'www.rooted3d.com','content-type':'application/json',authorization:'Bearer user-session-token'},body,...extra }; }
async function run(req,fetchImpl) { const headers={}; let output; const res={setHeader:(k,v)=>headers[k]=v,end:s=>output=JSON.parse(s)}; await createHandler({env,fetchImpl})(req,res); return {status:res.statusCode,output,headers}; }
test('invite defaults leader and rejects privilege/actor injection',()=>{
 assert.equal(validateBody({action:'invite',request_id:id,payload:{email:'leader@example.test',display_name:'Test'}}).p_payload.role,'leader');
 assert.throws(()=>validateBody({action:'invite',request_id:id,payload:{email:'leader@example.test',display_name:'Test',actor_id:id}}));
 assert.throws(()=>validateBody({action:'role',request_id:id,payload:{user_id:id,role:'owner'}}));
});
test('list delegates current authority to user-JWT protected RPC, no service role',async()=>{
 let calls=0;
 const r=await run(request({action:'list'}),async(url,init)=>{calls++;assert.equal(new URL(url).pathname,'/rest/v1/rpc/rooted_team_list');assert.equal(init.headers.Authorization,'Bearer user-session-token');assert.equal(init.headers.apikey,'sb_publishable_mock_only');return Response.json({actor_id:id,members:[],invitations:[],has_more:false,delivery:'held'});});
 assert.equal(calls,1);assert.equal(r.status,200);assert.equal(r.headers['Cache-Control'],'no-store, max-age=0');
});
test('cross-origin and missing token rejected before network',async()=>{
 let calls=0;const fetchImpl=()=>{calls++;throw Error('unexpected');};
 const a=request({action:'list'});a.headers.origin='https://evil.test';assert.equal((await run(a,fetchImpl)).status,403);
 const b=request({action:'list'});delete b.headers.authorization;assert.equal((await run(b,fetchImpl)).status,401);assert.equal(calls,0);
});
test('inactive/non-admin RPC denial sanitized; no fake success',async()=>{
 const r=await run(request({action:'list'}),async()=>Response.json({code:'42501',message:'private details'}, {status:403}));assert.equal(r.status,403);assert.deepEqual(r.output,{error:'admin_required'});
});
test('held invitation never calls Auth or sends mail',async()=>{
 let calls=0;const r=await run(request({action:'invite',request_id:id,payload:{email:'test@example.test',display_name:'Test'}}),async(url)=>{calls++;assert.match(String(url),/rooted_team_mutate$/);return Response.json({request_id:id,action:'invite',result:{id,status:'held',email_sent:false}});});assert.equal(calls,1);assert.equal(r.output.result.email_sent,false);
});
test('bounded request, query strings and upstream reply',async()=>{
 assert.equal((await run(request({action:'list',junk:'x'.repeat(9000)}),()=>{})).status,413);
 assert.equal((await run(request({action:'list'},{url:'/api/team?token=secret'}),()=>{})).status,400);
 assert.equal((await run(request({action:'list'}),async()=>new Response('x'.repeat(600000)))).status,502);
});
test('provider errors do not leak and delivery action is unavailable',async()=>{
 assert.equal((await run(request({action:'list'}),async()=>Response.json({message:'secret'},{status:500}))).output.error,'unavailable');
 assert.throws(()=>validateBody({action:'send',request_id:id,payload:{id}}));
});
