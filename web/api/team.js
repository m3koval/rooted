// Server-only transport. Authority is resolved by auth.uid() + current active admin
// in each protected RPC, never by role claims or by a supplied actor ID.
export const config = { api: { bodyParser: false } };
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object=v=>v!==null && typeof v==='object' && !Array.isArray(v);
const fail=(status,code)=>Object.assign(new Error(code),{status,code});
const exact=(v,allowed)=>object(v)&&Object.keys(v).every(k=>allowed.includes(k));
const uuid=v=>typeof v==='string'&&UUID.test(v);
const role=v=>['leader','admin'].includes(v);
function publicKey(key) {
 if(typeof key!=='string'||key.startsWith('sb_secret_'))return false;
 if(key.startsWith('sb_publishable_'))return true;
 try{return JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString('utf8')).role==='anon';}catch{return false;}
}
export function validateBody(b) {
 if (!object(b)) throw fail(400,'invalid_request');
 if(b.action==='list') {
  if(!exact(b,['action','offset']) || (b.offset!==undefined && (!Number.isInteger(b.offset)||b.offset<0||b.offset>100000))) throw fail(400,'invalid_request');
  return {p_offset:b.offset??0};
 }
 if(!exact(b,['action','request_id','payload'])||!uuid(b.request_id)||!object(b.payload)) throw fail(400,'invalid_request');
 const p={...b.payload};
 if(b.action==='invite') {
  if(!exact(p,['email','display_name','role']) || typeof p.email!=='string'||p.email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email.trim()) || typeof p.display_name!=='string'||!p.display_name.trim()||p.display_name.trim().length>80) throw fail(400,'invalid_request');
  p.email=p.email.trim().toLowerCase();p.display_name=p.display_name.trim();p.role=p.role??'leader';
  if(!role(p.role)) throw fail(400,'invalid_request');
 } else if(['cancel','provision'].includes(b.action)) {
  if(!exact(p,['id'])||!uuid(p.id))throw fail(400,'invalid_request');
 } else if(['role','deactivate','reactivate'].includes(b.action)) {
  if(!exact(p,b.action==='role'?['user_id','role']:['user_id'])||!uuid(p.user_id)||(b.action==='role'&&!role(p.role)))throw fail(400,'invalid_request');
 } else throw fail(400,'invalid_request');
 return {p_request_id:b.request_id,p_action:b.action,p_payload:p};
}
async function boundedBody(req) {
 if(req.headers['content-length']!==undefined && (!/^\d+$/.test(String(req.headers['content-length']))||Number(req.headers['content-length'])>8192))throw fail(413,'request_too_large');
 let raw;
 if(req.body!==undefined)raw=Buffer.isBuffer(req.body)?req.body:Buffer.from(typeof req.body==='string'?req.body:JSON.stringify(req.body));
 else {const chunks=[];let size=0;for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>8192)throw fail(413,'request_too_large');chunks.push(b);}raw=Buffer.concat(chunks);}
 if(raw.length>8192)throw fail(413,'request_too_large');
 try{return JSON.parse(raw.toString('utf8'));}catch{throw fail(400,'invalid_request');}
}
async function boundedReply(response) {
 const reader=response.body?.getReader();if(!reader)throw fail(502,'unavailable');
 let size=0;const chunks=[];
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>262144){await reader.cancel();throw fail(502,'unavailable');}chunks.push(Buffer.from(value));}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail(502,'unavailable');}
}
export function createHandler({env=process.env,fetchImpl=globalThis.fetch}={}) {
 return async(req,res)=>{
  for(const [k,v] of Object.entries({'Cache-Control':'no-store, max-age=0','CDN-Cache-Control':'no-store','Vercel-CDN-Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}))res.setHeader(k,v);
  const send=(status,data)=>{res.statusCode=status;res.end(JSON.stringify(data));};
  try {
   if(req.method!=='POST'){res.setHeader('Allow','POST');throw fail(405,'method_not_allowed');}
   if(typeof req.url!=='string'||req.url.includes('?'))throw fail(400,'invalid_request');
   const origin=env.TEAM_ORIGIN||'https://www.rooted3d.com';
   if(req.headers.origin!==origin || new URL(origin).host!==req.headers.host || (req.headers['sec-fetch-site']&&req.headers['sec-fetch-site']!=='same-origin'))throw fail(403,'forbidden');
   if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||'')||(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity'))throw fail(415,'unsupported_media_type');
   const token=req.headers.authorization;
   if(typeof token!=='string'||!/^Bearer [A-Za-z0-9._~-]{8,8192}$/.test(token))throw fail(401,'sign_in_required');
   const body=await boundedBody(req);const args=validateBody(body);
   let base;try{base=new URL(env.SUPABASE_URL||env.VITE_SUPABASE_URL);}catch{throw fail(503,'unavailable');}
   const key=env.SUPABASE_ANON_KEY||env.VITE_SUPABASE_ANON_KEY;
   if(base.origin!=='https://sfrkowqljeaztupywtzy.supabase.co'||base.pathname!=='/'||base.search||base.hash||base.username||base.password||!publicKey(key))throw fail(503,'unavailable');
   if(body.action==='provision'){
    const receipt=await provisionInvitation({env,fetchImpl,token,id:args.p_payload.id,request_id:args.p_request_id,base,key});
    if(!object(receipt)||receipt.request_id!==body.request_id||receipt.action!=='provision'||!object(receipt.result))throw fail(502,'unavailable');
    send(200,receipt);return;
   }
   // No service credentials needed: Supabase verifies JWT, DB verifies current membership.
   const response=await fetchImpl(new URL(`/rest/v1/rpc/${body.action==='list'?'rooted_team_list':'rooted_team_mutate'}`,base),{
    method:'POST',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json',apikey:key,Authorization:token},body:JSON.stringify(args)
   });
   const data=await boundedReply(response);
   if(!response.ok){
    if(response.status===401)throw fail(401,'sign_in_required');
    if(data?.code==='42501')throw fail(403,'admin_required');
    if(data?.code==='23505')throw fail(409,'conflict');
    if(['22023','23514','22P02'].includes(data?.code))throw fail(400,'invalid_request');
    throw fail(502,'unavailable');
   }
   if(body.action==='list') {
    if(!object(data)||!uuid(data.actor_id)||!Array.isArray(data.members)||!Array.isArray(data.invitations)||typeof data.has_more!=='boolean'||data.delivery!=='held')throw fail(502,'unavailable');
    const provisioning = env.SUPABASE_SERVICE_ROLE_KEY && env.TEAM_PROVISIONING_MODE==='held' ? 'held' : env.SUPABASE_SERVICE_ROLE_KEY && env.TEAM_PROVISIONING_MODE==='verified_smtp' && env.TEAM_SMTP_VERIFIED==='true' && env.TEAM_AUTH_REDIRECT==='https://www.rooted3d.com/leaders' ? 'verified_smtp' : 'disabled';
    send(200,{actor_id:data.actor_id,members:data.members,invitations:data.invitations,has_more:data.has_more,delivery:'held',provisioning});
   } else {
    if(!object(data)||data.request_id!==body.request_id||data.action!==body.action||!object(data.result))throw fail(502,'unavailable');
    send(200,{request_id:data.request_id,action:data.action,result:data.result});
   }
  } catch(e){send(e.status||503,{error:e.status?e.code:'unavailable'});}
 };
}
export default createHandler();

// Explicit server-only operation; default disabled, never bundled into browser code.
// Auth creation is unconfirmed, membership binding precedes ANY email request.
// Ambiguous create results are held for reconciliation, never guessed by email.
export async function provisionInvitation({env,fetchImpl,token,id,request_id,base,key}) {
 if(!uuid(request_id))throw fail(400,'invalid_request');
 const mode=env.TEAM_PROVISIONING_MODE||'disabled';
 if(!['held','verified_smtp'].includes(mode))throw fail(503,'provisioning_disabled');
 if(mode==='verified_smtp'&&(env.TEAM_SMTP_VERIFIED!=='true'||env.TEAM_AUTH_REDIRECT!=='https://www.rooted3d.com/leaders'))throw fail(503,'delivery_not_verified');
 const secret=env.SUPABASE_SERVICE_ROLE_KEY;
 if(typeof secret!=='string'||!secret)throw fail(503,'unavailable');
 async function call(path,body,privileged=true){
  const r=await fetchImpl(new URL(path,base),{method:'POST',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json',apikey:privileged?secret:key,Authorization:privileged?`Bearer ${secret}`:token},body:JSON.stringify(body)});
  const data=await boundedReply(r);
  if(!r.ok)throw fail(r.status===401?401:data?.code==='42501'?403:data?.code==='23505'?409:502,data?.code==='42501'?'admin_required':data?.code==='23505'?'conflict':'unavailable');
  return data;
 }
 const identity=await call('/rest/v1/rpc/rooted_identity',{},false);
 if(!uuid(identity.actor_id)||identity.role!=='admin')throw fail(403,'admin_required');
 const step=(p_step,p_user_id=null,p_delivery=null)=>call('/rest/v1/rpc/rooted_team_provision_request',{p_actor:identity.actor_id,p_request_id:request_id,p_id:id,p_mode:mode,p_step,p_user_id,p_delivery});
 let state=await step('start');
 if(state.request_id)return state;
 if(state.phase==='create_claimed'){
  if(!state.create)throw fail(409,'reconciliation_required');
  // The committed claim precedes Auth. Even an explicit provider error is not
  // permission to repeat creation: reconcile the exact operation instead.
  try {
   const created=await call('/auth/v1/admin/users',{email:state.email,email_confirm:false,app_metadata:{rooted_provision_request:request_id}});
   const user=created.user||created;
   if(!uuid(user.id)||user.email?.toLowerCase()!==state.email)throw fail(502,'unavailable');
   state=await step('save_identity',user.id);
  } catch {throw fail(409,'reconciliation_required');}
 }
 if(state.phase==='identity_saved')state=await step('bind');
 if(state.request_id)return state;
 if(state.phase==='delivery_claimed')return step('finish',null,'attempted');
 if(state.phase!=='bound')throw fail(502,'unavailable');
 if(mode==='held')return step('finish',null,'held');
 const email=state.email;
 const claim=await step('claim_delivery');
 if(claim.request_id)return claim;
 let outcome='attempted';
 if(claim.send){
  try {await call(`/auth/v1/otp?redirect_to=${encodeURIComponent(env.TEAM_AUTH_REDIRECT)}`,{email,create_user:false},false);outcome='requested';}
  catch { /* Unknown provider outcome; never claim email delivery. */ }
 }
 return step('finish',null,outcome);
}
