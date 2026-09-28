import test from 'node:test';
import assert from 'node:assert/strict';
import {provisionInvitation} from '../api/team.js';
const id='11111111-1111-4111-8111-111111111111';
const request_id='22222222-2222-4222-8222-222222222222';
function fixture(mode='held',drop=''){
 const calls=[];let phase,receipt,claimed=false,seenMode;
 const args={id,request_id,base:new URL('https://sfrkowqljeaztupywtzy.supabase.co'),key:'sb_publishable_fake',token:'Bearer mock-user',env:{TEAM_PROVISIONING_MODE:mode,SUPABASE_SERVICE_ROLE_KEY:'mock-server-only',TEAM_SMTP_VERIFIED:'true',TEAM_AUTH_REDIRECT:'https://www.rooted3d.com/leaders'},fetchImpl:async(url,init)=>{
  const path=new URL(url).pathname,b=JSON.parse(init.body);calls.push({path,b});
  if(path.endsWith('rooted_identity'))return Response.json({actor_id:id,role:'admin'});
  if(path.endsWith('/admin/users')){assert.equal(phase,'create_claimed');assert.equal(b.email_confirm,false);assert.equal(b.app_metadata.rooted_provision_request,request_id);if(drop==='create')throw Error('dropped after Auth commit');return Response.json({id,email:'new@example.test'});}
  if(path.endsWith('rooted_team_provision_request')){
   assert.equal(b.p_request_id,request_id);
   if(seenMode&&seenMode!==b.p_mode)return Response.json({code:'23505'},{status:409});
   seenMode=b.p_mode;
   if(receipt)return Response.json(receipt);
   let create=false,send=false;
   if(b.p_step==='start'&&!phase){phase='create_claimed';create=true;}
   if(b.p_step==='save_identity')phase='identity_saved';
   if(b.p_step==='bind')phase='bound';
   if(b.p_step==='claim_delivery'){assert.equal(phase,'bound');phase='delivery_claimed';send=!claimed;claimed=true;}
   if(b.p_step==='finish'){receipt={request_id,action:'provision',result:{id,user_id:id,status:'provisioned',delivery:b.p_delivery,email_sent:false}};if(drop==='finish'){drop='';throw Error('committed response dropped');}return Response.json(receipt);}
   if(drop===b.p_step){drop='';throw Error('phase committed response dropped');}
   return Response.json({phase,create,send,email:'new@example.test',user_id:phase==='create_claimed'?null:id});
  }
  if(path.endsWith('/otp')){assert.equal(phase,'delivery_claimed');assert.equal(b.create_user,false);if(drop==='otp')throw Error('unknown send');return Response.json({});}
  throw Error('unexpected');
 }};
 return {args,calls};
}
const count=(f,s)=>f.calls.filter(x=>x.path.endsWith(s)).length;
test('disabled and unverified SMTP make zero calls',async()=>{for(const mode of ['disabled','verified_smtp']){const f=fixture(mode);f.args.env.TEAM_SMTP_VERIFIED='false';await assert.rejects(provisionInvitation(f.args));assert.equal(f.calls.length,0);}});
test('held receipt is durable and replay identical, no delivery',async()=>{const f=fixture();const r=await provisionInvitation(f.args);assert.equal(r.result.delivery,'held');assert.deepEqual(await provisionInvitation(f.args),r);assert.equal(count(f,'/admin/users'),1);assert.equal(count(f,'/otp'),0);});
test('unknown create is never retried',async()=>{const f=fixture('held','create');for(let n=0;n<2;n++)await assert.rejects(provisionInvitation(f.args),e=>e.code==='reconciliation_required');assert.equal(count(f,'/admin/users'),1);});
test('committed identity/bind/final dropped responses resume without create',async()=>{for(const step of ['save_identity','bind','finish']){const f=fixture('held',step);await assert.rejects(provisionInvitation(f.args));assert.equal((await provisionInvitation(f.args)).result.delivery,'held');assert.equal(count(f,'/admin/users'),1);}});
test('concurrent requests issue one Auth create',async()=>{const f=fixture();const results=await Promise.allSettled([provisionInvitation(f.args),provisionInvitation(f.args)]);assert.ok(results.some(r=>r.status==='fulfilled'));assert.equal(count(f,'/admin/users'),1);});
test('SMTP known acceptance immutable; unknown/claim-drop is attempted, never resent',async()=>{for(const drop of ['', 'otp','claim_delivery']){const f=fixture('verified_smtp',drop);let r;try{r=await provisionInvitation(f.args);}catch{r=await provisionInvitation(f.args);}assert.equal(r.result.delivery,drop?'attempted':'requested');assert.deepEqual(await provisionInvitation(f.args),r);assert.equal(count(f,'/otp'),drop==='claim_delivery'?0:1);assert.equal(r.result.email_sent,false);}});
test('changed mode fails closed and does not send',async()=>{const f=fixture();await provisionInvitation(f.args);f.args.env.TEAM_PROVISIONING_MODE='verified_smtp';await assert.rejects(provisionInvitation(f.args));assert.equal(count(f,'/otp'),0);});
test('non-admin denied before privileged Auth call',async()=>{const f=fixture();f.args.fetchImpl=async()=>Response.json({actor_id:id,role:'leader'});await assert.rejects(provisionInvitation(f.args),e=>e.code==='admin_required');});
