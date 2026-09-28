import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamClient } from '../src/team-management.js';
const id='11111111-1111-4111-8111-111111111111';
test('team client never fetches without signed-in access token',async()=>{
 let called=false;const call=createTeamClient({getAccessToken:async()=>null,fetchImpl:()=>{called=true;}});
 await assert.rejects(()=>call('list'),/Sign in again/);assert.equal(called,false);
});
test('team client carries stable explicit request ID and fresh token for each request',async()=>{
 let tokens=0;const call=createTeamClient({getAccessToken:async()=>`token-${++tokens}`,fetchImpl:async(url,init)=>{
 assert.equal(url,'/api/team');assert.equal(init.cache,'no-store');assert.equal(init.headers.Authorization,`Bearer token-${tokens}`);
 const b=JSON.parse(init.body);assert.equal(b.request_id,id);return Response.json({request_id:id,action:b.action,result:{status:'held',email_sent:false}});
 }});await call('invite',{email:'test@example.test',display_name:'Test'},id);await call('invite',{email:'test@example.test',display_name:'Test'},id);assert.equal(tokens,2);
});
test('team client does not interpret HTTP or receipt failures as success',async()=>{
 for(const response of [Response.json({error:'admin_required'},{status:403}),new Response('not JSON'),Response.json({request_id:'wrong',action:'role',result:{}})]){
 const call=createTeamClient({getAccessToken:async()=>'token',fetchImpl:async()=>response});await assert.rejects(()=>call('role',{user_id:id,role:'leader'},id));
 }
});

test('uncertain provisioning reconciliation retains request rather than treating conflict as definitive',async()=>{
 const call=createTeamClient({getAccessToken:async()=>'token',fetchImpl:async()=>Response.json({error:'reconciliation_required'},{status:409})});
 await assert.rejects(()=>call('provision',{id},id),e=>e.definitive===false&&e.code==='reconciliation_required'&&/original request is retained/.test(e.message));
});
