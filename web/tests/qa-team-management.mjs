import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://team.test/**',route=>route.fulfill({contentType:'text/html',body:'<main id="team"></main>'}));await page.goto('https://team.test/');
 const source=await readFile(new URL('../src/team-management.js',import.meta.url),'utf8');
 await page.evaluate(async(source)=>{
  const module=await import('data:text/javascript;base64,'+btoa(unescape(encodeURIComponent(source))));
  window.calls=[];window.mode='normal';window.confirm=()=>true;
  window.crypto.randomUUID ||= ()=> '11111111-1111-4111-8111-111111111111';
  window.mount=()=>module.mountTeamManagement(document.querySelector('#team'),{currentUserId:'a',getAccessToken:async()=>'test-token',fetchImpl:async(_url,init)=>{
   const body=JSON.parse(init.body);window.calls.push(body);
   if(window.mode==='denied')return Response.json({error:'admin_required'},{status:403});
   if(body.action==='list')return Response.json({actor_id:'a',delivery:'held',has_more:false,members:[{user_id:'a',display_name:'Admin <script>',role:'admin',active:true},{user_id:'b',display_name:'Leader Test',role:'leader',active:true}],invitations:[]});
   if(window.mode==='drop'){window.mode='normal';throw new Error('Response lost after commit');}
   return Response.json({request_id:body.request_id,action:body.action,result:{id:'held-id',status:'held',email_sent:false}});
  }});window.team=window.mount();
 },source);
 await page.getByRole('heading',{name:'Members',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Deactivate',exact:true}).first().isDisabled(),true);
 await page.getByLabel('Email',{exact:true}).fill('new@example.test');await page.getByLabel('Display name',{exact:true}).fill('New Leader');
 await page.getByRole('button',{name:'Stage invitation'}).click();
 await page.getByRole('status').filter({hasText:'Invitation staged — no email sent.'}).waitFor();
 const calls=await page.evaluate(()=>window.calls);assert.equal(calls.find(c=>c.action==='invite').payload.role,'leader');
 await page.getByLabel('Email',{exact:true}).fill('retry@example.test');await page.getByLabel('Display name',{exact:true}).fill('Retry');
 await page.evaluate(()=>window.mode='drop');await page.getByRole('button',{name:'Stage invitation'}).click();
 await page.getByRole('alert').filter({hasText:'Response lost'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Stage invitation'}).count(),0);
 const stored=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('rooted.team.pending.v1:a')));assert.equal(stored.payload.email,'retry@example.test');
 await page.evaluate(()=>{window.team.destroy();window.team=window.mount();});
 await page.waitForFunction(()=>document.querySelector('#team').getAttribute('aria-busy')==='false');
 await page.getByRole('button',{name:'Retry exact request'}).click();
 await page.getByRole('heading',{name:'Members',exact:true}).waitFor();
 const retries=await page.evaluate(()=>window.calls.filter(c=>c.payload?.email==='retry@example.test'));assert.equal(retries.length,2);assert.deepEqual(retries[0],retries[1]);
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('rooted.team.pending.v1:a')),null);
 await page.evaluate(()=>{window.mode='denied';return window.team.refresh();});
 await page.getByRole('alert').filter({hasText:'Admin access required'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Stage invitation'}).count(),0);
 await page.evaluate(()=>window.team.destroy());assert.equal(await page.locator('#team').textContent(),'');
 assert.deepEqual(errors,[]);console.log('Team mobile mocked browser QA passed: admin controls, default leader held invite, denial clears panel, destroy clears private DOM; no page errors.');
}finally{await browser.close();}
