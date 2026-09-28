// Standalone admin panel; mount only inside an authenticated admin workspace.
// UI role visibility is not authority: every call revalidates current membership.
const messages={reconciliation_required:'Account creation needs verified administrator reconciliation. The original request is retained; retry only after reconciliation. Do not stage another invitation.',provisioning_disabled:'Account creation is disabled in this environment.',delivery_not_verified:'Email delivery has not been verified for this environment.',admin_required:'Admin access required. Your access may have changed; self-deactivation and removing your own Admin role are also blocked.',sign_in_required:'Sign in again to manage the team.',conflict:'That member or pending invitation already exists, or this request conflicts. Refresh and review.',invalid_request:'Please check the details. The member or invitation may have changed.',unavailable:'Team management is unavailable. The reviewed migration and API must be installed before use.'};
export function createTeamClient({getAccessToken,fetchImpl=globalThis.fetch}) {
 return async function request(action,payload={},requestId) {
  const token=await getAccessToken();if(!token)throw new Error(messages.sign_in_required);
  const body=action==='list'?{action,offset:payload.offset??0}:{action,payload,request_id:requestId||crypto.randomUUID()};
  const r=await fetchImpl('/api/team',{method:'POST',cache:'no-store',credentials:'same-origin',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(body)});
  let data;try{data=await r.json();}catch{throw new Error(messages.unavailable);}
  if(!r.ok||data.error)throw Object.assign(new Error(messages[data.error]||'Request failed. Retry the exact request.'),{definitive:data.error!=='reconciliation_required'&&[400,401,403,409].includes(r.status),code:data.error});
  if(action==='list'&&(!Array.isArray(data.members)||!Array.isArray(data.invitations)||typeof data.has_more!=='boolean'))throw new Error(messages.unavailable);
  if(action!=='list'&&(data.request_id!==body.request_id||data.action!==action||!data.result))throw new Error('No valid receipt received. Refresh before retrying.');
  return data;
 };
}
export function mountTeamManagement(container,{getAccessToken,currentUserId,fetchImpl=globalThis.fetch,storage}={}) {
 const request=createTeamClient({getAccessToken,fetchImpl});
 let destroyed=false,busy=false,generation=0,offset=0,state=null,notice='';
 const storageKey=`rooted.team.pending.v1:${currentUserId}`;
 try{storage??=globalThis.sessionStorage;}catch{storage=null;}
 let pending=null;try{const saved=JSON.parse(storage?.getItem(storageKey)||'null');if(saved?.actor===currentUserId&&saved.request_id&&saved.action&&saved.payload)pending=saved;}catch{}
 function savePending(){try{if(!storage)return false;if(pending){const value=JSON.stringify(pending);storage.setItem(storageKey,value);return storage.getItem(storageKey)===value;}storage.removeItem(storageKey);return storage.getItem(storageKey)===null;}catch{return false;}}
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 function button(label,fn,disabled=false){const b=el('button',label);b.type='button';b.disabled=busy||disabled;b.addEventListener('click',fn);return b;}
 function render(error=''){
  if(destroyed)return;container.replaceChildren();container.setAttribute('aria-busy',String(busy));
  container.append(el('h2','Team'),el('p','Leaders handle check-in, drawings, history and private profiles. Admins also manage settings, stations, profile changes and team access.'));
  const status=el('p',error||notice||(busy?'Loading team…':''));status.setAttribute('role',error?'alert':'status');container.append(status);
  container.append(button('Refresh',refresh));
  if(pending){container.append(el('p','A team request needs reconciliation. Retry exactly; no other changes are allowed until its outcome is known.'),button('Retry exact request',()=>mutate(pending.action,pending.payload,true)));return;}
  if(!state)return;
  const form=el('form');const email=el('input');email.type='email';email.required=true;email.maxLength=254;email.name='email';
  const name=el('input');name.required=true;name.maxLength=80;name.name='display_name';
  const roles=el('select');roles.name='role';for(const r of ['leader','admin']){const o=el('option',r==='admin'?'Admin':'Leader');o.value=r;roles.append(o);}
  for(const [label,input] of [['Email',email],['Display name',name],['Role',roles]]){const l=el('label',label);l.append(input);input.disabled=busy;form.append(l);}
  const submit=el('button','Stage invitation');submit.type='submit';submit.disabled=busy;form.append(submit);
  form.addEventListener('submit',e=>{e.preventDefault();mutate('invite',{email:email.value,display_name:name.value,role:roles.value});});
  container.append(el('h3','Invite a leader'),el('p',state.provisioning==='verified_smtp'?'Stage an invitation, then choose Create account & request email. Delivery is separate from account access.':state.provisioning==='held'?'Stage an invitation, then create its account. Email delivery is disabled.':'Invitations are held for review. Account creation and email delivery are disabled in this environment.'),form,el('h3','Members'));
  if(!state.members.length)container.append(el('p','No members on this page.'));
  for(const member of state.members){
   const row=el('section');row.append(el('strong',member.display_name),el('p',`${member.role==='admin'?'Admin':'Leader'} · ${member.active?'Active':'Inactive'}${member.user_id===currentUserId?' · You':''}`));
   const self=member.user_id===currentUserId;
   row.append(button(member.active?'Deactivate':'Reactivate',()=>mutate(member.active?'deactivate':'reactivate',{user_id:member.user_id}),self));
   row.append(button(member.role==='admin'?'Change to Leader':'Change to Admin',()=>mutate('role',{user_id:member.user_id,role:member.role==='admin'?'leader':'admin'}),self));
   container.append(row);
  }
  container.append(el('h3','Invitations'));
  if(!state.invitations.length)container.append(el('p','No pending invitations on this page.'));
  for(const invite of state.invitations){const row=el('section');row.append(el('p',`${invite.display_name} · ${invite.email} · ${invite.role}`),el('p',invite.delivery_attempted_at?'Email request attempted — delivery not confirmed':invite.status==='provisioned'?'Account created — email held':'Held — no account or email'));if(invite.status!=='provisioned')row.append(button('Cancel invitation',()=>mutate('cancel',{id:invite.id})));if(['held','verified_smtp'].includes(state.provisioning)&&!invite.delivery_attempted_at&&invite.status!=='provisioned')row.append(button(state.provisioning==='verified_smtp'?'Create account & request email':'Create account — hold email',()=>mutate('provision',{id:invite.id})));container.append(row);}
  container.append(button('Previous page',()=>{offset=Math.max(0,offset-100);refresh();},offset===0),button('Next page',()=>{offset+=100;refresh();},!state.has_more));
  container.append(el('p','Deactivation removes Rooted membership authority; it does not delete the Auth account, PIN, passkeys or historical actions. Reactivation restores the existing personal PIN. Previously issued device sessions stay revoked. Cancelling a held invitation does not revoke an Auth identity.'));
 }
 async function refresh(){
  if(destroyed||busy)return;busy=true;const seq=++generation;render();
  try{const next=await request('list',{offset});if(destroyed||seq!==generation)return;if(next.actor_id!==currentUserId)throw Object.assign(new Error(messages.sign_in_required),{definitive:true});state=next;busy=false;render();}
  catch(e){if(destroyed||seq!==generation)return;state=null;busy=false;render(e.message);}
 }
 async function mutate(action,payload,retry=false){
  if(destroyed||busy)return;
  if(pending&&!retry)return;
  if(!retry&&['deactivate','reactivate','role','cancel','provision'].includes(action)&&!globalThis.confirm('Confirm this team access change?'))return;
  if(!pending){pending={actor:currentUserId,action,payload:JSON.parse(JSON.stringify(payload)),request_id:crypto.randomUUID()};}
  if(!savePending()){render('This browser cannot safely retain the request. No change was sent. Enable session storage, then retry the exact request.');return;}
  busy=true;render();
  try{const receipt=await request(pending.action,pending.payload,pending.request_id);if(destroyed)return;notice=action==='provision'?(receipt.result.delivery==='requested'?'Account created; email requested, not confirmed delivered.':receipt.result.delivery==='attempted'?'Email request was already attempted. Verify delivery before any resend.':'Account created — email held.'):action==='invite'?'Invitation staged — no email sent.':action==='cancel'?'Held invitation cancelled. No Auth account was revoked.':'Membership change saved.';
   if(action==='invite'&&(receipt.result.status!=='held'||receipt.result.email_sent!==false))throw new Error('Unexpected invitation receipt. Refresh before continuing.');
   const completed=pending;pending=null;if(!savePending()){pending=completed;busy=false;notice='The server acknowledged this change, but this browser could not clear its saved request. Retry exactly after restoring session storage; do not create another request.';render();return;}busy=false;await refresh();
  }catch(e){if(destroyed)return;if(e.definitive){const rejected=pending;pending=null;if(!savePending())pending=rejected;}busy=false;state=null;notice='';render(e.message);}
 }
 render();void refresh();
 return {refresh,destroy(){destroyed=true;generation++;state=null;container.replaceChildren();container.removeAttribute('aria-busy');}};
}
