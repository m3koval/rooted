import {chromium,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-renderer-accessibility']});
try{
 const p=await b.newPage();await p.route('https://team.test/**',r=>r.fulfill({contentType:'text/html',body:'<main id="team"></main>'}));await p.goto('https://team.test');
 const source=await readFile(new URL('../src/team-management.js',import.meta.url),'utf8');
 await p.evaluate(async source=>{
  const m=await import('data:text/javascript;base64,'+btoa(unescape(encodeURIComponent(source))));window.calls=[];window.confirm=()=>true;window.failStorage=true;window.provisioning='disabled';const values=new Map();
  const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>{if(window.failStorage)throw Error('Storage unavailable');values.set(k,v);},removeItem:k=>values.delete(k)};
  window.team=m.mountTeamManagement(document.querySelector('#team'),{storage,currentUserId:'a',getAccessToken:async()=>'test',fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);window.calls.push(body);if(body.action==='provision'&&window.reconcile)return Response.json({error:'reconciliation_required'},{status:409});return Response.json(body.action==='list'?{actor_id:'a',members:[],invitations:[{id:'i',email:'fictional@example.test',display_name:'Fictional',role:'leader',status:'held'}],has_more:false,provisioning:window.provisioning}:{request_id:body.request_id,action:body.action,result:{id:'i',status:'provisioned',delivery:'held',email_sent:false}});}});
 },source);
 await expect(p.getByRole('heading',{name:'Members',exact:true})).toBeVisible();
 await expect(p.getByRole('button',{name:'Create account — hold email',exact:true})).toHaveCount(0);
 await p.getByLabel('Email',{exact:true}).fill('fake@example.test');await p.getByLabel('Display name',{exact:true}).fill('Fake');await p.getByRole('button',{name:'Stage invitation'}).click();
 await expect(p.getByRole('alert')).toContainText('No change was sent');assert.equal(await p.evaluate(()=>window.calls.filter(c=>c.action!=='list').length),0);
 // Discard only the unsent fictional request for the next independent fixture.
 await p.evaluate(()=>{window.team.destroy();});
 await p.reload();
 await p.evaluate(async source=>{const m=await import('data:text/javascript;base64,'+btoa(unescape(encodeURIComponent(source))));window.calls=[];window.reconcile=true;window.confirm=()=>true;window.team=m.mountTeamManagement(document.querySelector('#team'),{currentUserId:'a',getAccessToken:async()=>'test',fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);window.calls.push(body);if(body.action==='provision'&&window.reconcile)return Response.json({error:'reconciliation_required'},{status:409});return Response.json(body.action==='list'?{actor_id:'a',members:[],invitations:[{id:'i',email:'fictional@example.test',display_name:'Fictional',role:'leader',status:'held'}],has_more:false,provisioning:'held'}:{request_id:body.request_id,action:body.action,result:{id:'i',status:'provisioned',delivery:'held',email_sent:false}});}});},source);
 await p.getByRole('button',{name:'Create account — hold email',exact:true}).click();await expect(p.getByRole('alert')).toContainText('original request is retained');assert.ok(await p.evaluate(()=>JSON.parse(sessionStorage.getItem('rooted.team.pending.v1:a')).request_id));await p.evaluate(()=>window.reconcile=false);await p.getByRole('button',{name:'Retry exact request'}).click();await expect(p.getByRole('status')).toContainText('Account created — email held');const provisions=await p.evaluate(()=>window.calls.filter(c=>c.action==='provision'));assert.equal(provisions.length,2);assert.deepEqual(provisions[0],provisions[1]);
 console.log('PASS: unavailable storage sends zero mutations; disabled provisioning hidden; configured held account action uses exact request and truthful receipt.');
}finally{await b.close();}
