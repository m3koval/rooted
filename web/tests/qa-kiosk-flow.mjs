// Fictional fixtures, intercepted APIs, real Chromium; never hosted writes.
import {chromium, expect} from '@playwright/test';
import {createServer} from 'vite';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const server=await createServer({server:{host:'localhost',port:0}});await server.listen();
const origin=`http://localhost:${server.httpServer.address().port}`;
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
const artifacts='/tmp/rooted-kiosk-flow-qa';await mkdir(artifacts,{recursive:true});
let checks=0;const ok=(v,m)=>{assert.ok(v,m);checks++;};
const id='00000000-0000-4000-8000-000000000001';
const receipt={checkin_id:id,earned_points:20,components:[{label:'Attendance',points:20}]};
try{
 const c=await browser.newContext();const p=await c.newPage();let searches=[],writes=[],mode='',fail=false;const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await c.route('**/*',async r=>{
  const u=new URL(r.request().url());if(u.origin!==origin)return r.abort();
  if(u.pathname==='/api/station')return r.fulfill({json:{ok:true}});
  if(u.pathname!=='/api/kiosk')return r.continue();
  const b=r.request().postDataJSON();let data;
  if(b.action==='context')data={event:{id,name:'Mock Rooted',date:'2026-09-25',reading_week:'2026-09-21'}};
  if(b.action==='search'){searches.push(b.payload.query);if(b.payload.query==='Slow')await new Promise(r=>setTimeout(r,900));data={matches:b.payload.query==='None'?[]:[{id,name:b.payload.query==='Slow'?'Stale Person':'Alex Example'}]};}
  if(b.action==='person')data={person:{id,name:'Alex Example'},needs_leader:mode==='first',already_checked_in:mode==='duplicate',prior_chapters:7,...(mode==='duplicate'?{receipt}:{})};
  if(b.action==='checkin'){writes.push(b);if(fail){fail=false;return r.abort();}data={action:'kiosk.checkin',request_id:b.request_id,result:{duplicate:false,receipt}};}
  return r.fulfill({json:data});
 });
 await c.addInitScript(()=>{localStorage.setItem('rooted.kiosk.station.v1','a'.repeat(64));sessionStorage.setItem('rooted.kiosk.device.v1','b'.repeat(64));sessionStorage.setItem('rooted.kiosk.expires.v1',new Date(Date.now()+7200000).toISOString());});
 // Simulate a transport that still completes canceled requests: version fences must win.
 await c.addInitScript(()=>{const original=window.fetch;window.fetch=(url,options)=>original(url,options?.body?.includes('Slow')?{...options,signal:undefined}:options);});
 await p.goto(origin+'/kiosk.html');await expect(p.locator('#search-screen')).toBeVisible();
 const q=p.locator('#query');await q.fill('A');await p.waitForTimeout(350);ok(searches.length===0,'minimum two chars');
 await q.fill('Al');await p.waitForTimeout(100);ok(searches.length===0,'debounced');await q.press('Enter');await expect(p.locator('.person-option')).toBeVisible();ok(searches.length===1,'Enter does not reload or duplicate search');
 await q.fill('Slow');ok(await p.locator('.person-option').count()===0,'old matches cleared immediately');await p.waitForTimeout(350);ok(await q.isEnabled(),'typing not busy blocked');await q.fill('Alex');await expect(p.locator('.person-option')).toHaveText('Alex Example');await p.waitForTimeout(700);await expect(p.locator('.person-option')).toHaveText('Alex Example');checks++;
 await q.fill('Slow');await p.waitForTimeout(350);await q.fill('');await p.waitForTimeout(950);ok(await p.locator('.person-option').count()===0,'clear invalidates request');
 await q.fill('None');await expect(p.locator('#search-note')).toContainText('No match');checks++;
 const select=async()=>{await q.fill('Alex');await p.locator('.person-option').click();};
 await select();await expect(p.locator('#bible-step')).toBeVisible();ok(await p.locator('#chapters-step').isHidden(),'name opens Bible only');
 for(const width of [320,390]){await p.setViewportSize({width,height:900});ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Bible no overflow');ok(await p.locator('#bible-yes').evaluate(e=>e.getBoundingClientRect().height>=80),'large yes tap');await p.screenshot({path:`${artifacts}/bible-${width}.png`,fullPage:true});}
 await p.locator('#bible-yes').click();await expect(p.locator('#chapters-step')).toBeVisible();ok(await p.locator('#chapters').inputValue()==='7','prior count preserved');ok(writes.length===0,'answer never writes');await p.locator('#chapters').fill('9');await p.locator('#back-bible').click();await expect(p.locator('#bible-yes')).toHaveAttribute('aria-pressed','true');await p.locator('#bible-yes').click();ok(await p.locator('#chapters').inputValue()==='9','back retains reading');
 for(const width of [320,390]){await p.setViewportSize({width,height:900});ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'chapters no overflow');await p.screenshot({path:`${artifacts}/chapters-${width}.png`,fullPage:true});}
 fail=true;await p.locator('#submit-checkin').click();await expect(p.locator('#status')).toContainText('No server confirmation');await p.locator('#retry').click();await expect(p.locator('#receipt-screen')).toBeVisible();ok(writes.length===2&&JSON.stringify(writes[0])===JSON.stringify(writes[1]),'exact pending retry');ok(writes[0].payload.bible===true&&writes[0].payload.chapters===9,'true answer and weekly total');
 await p.locator('#next').click();await select();await expect(p.locator('#bible-yes')).toHaveAttribute('aria-pressed','false');await p.locator('#bible-no').click();await p.locator('#submit-checkin').click();await expect(p.locator('#receipt-screen')).toBeVisible();ok(writes.at(-1).payload.bible===false,'false answer');
 await p.locator('#next').click();mode='first';await select();await expect(p.locator('#checkin-form')).toBeHidden();await expect(p.locator('#person-note')).toContainText('first check-in');checks++;await p.locator('#back').click();ok(await q.inputValue()==='','not me resets search');
 mode='duplicate';const count=writes.length;await select();await expect(p.locator('#receipt-screen h1')).toHaveText('Already checked in.');ok(writes.length===count,'duplicate saved receipt no writes');await p.screenshot({path:`${artifacts}/duplicate-390.png`,fullPage:true});
 await p.locator('#next').click();await q.fill('Slow');await p.waitForTimeout(350);await p.locator('#lock').click();await p.waitForTimeout(950);await expect(p.locator('#activation')).toBeVisible();ok(await p.locator('.person-option').count()===0,'lock drops stale search');ok(errors.length===0,'no browser errors');
 // Fresh contexts exercise enrollment without inherited authenticated fixtures.
 for(const [suffix,valid] of [['#station='+ 'c'.repeat(64),true],['#station='+ 'C'.repeat(64),false],['?station='+ 'c'.repeat(64),false],['#station='+ 'c'.repeat(64)+'&x=1',false]]){
  const ctx=await browser.newContext();const page=await ctx.newPage();await ctx.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());await page.goto(origin+'/kiosk.html'+suffix);await expect(page.locator('#pair-form')).toBeVisible();ok(new URL(page.url()).hash===''&&new URL(page.url()).search==='','URL scrubbed');ok(await page.locator('#token').inputValue()===(valid?'c'.repeat(64):''),'strict enrollment');if(valid){await page.getByRole('button',{name:'Remember this station'}).click();await expect(page.locator('#activate-form')).toBeVisible();ok(await page.locator('#pin').inputValue()==='','PIN mandatory after QR');}await ctx.close();
 }
 for(const kind of ['leader','different']){
  const ctx=await browser.newContext();await ctx.addInitScript(kind=>{if(kind==='leader')localStorage.setItem('sb-mock-auth-token','fictional');else localStorage.setItem('rooted.kiosk.station.v1','d'.repeat(64));},kind);
  const page=await ctx.newPage();await ctx.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());await page.goto(origin+'/kiosk.html#station='+ 'c'.repeat(64));await expect(page.locator('#pair-form')).toBeHidden();ok(await page.locator('#token').inputValue()==='','blocked enrollment not retained');ok(await page.evaluate(()=>localStorage.getItem('rooted.kiosk.station.v1'))===(kind==='different'?'d'.repeat(64):null),'no silent station replacement');await ctx.close();
 }
 // Daily capability and receipt timers: real Chromium with a controlled clock.
 {
  const ctx=await browser.newContext({viewport:{width:390,height:900},timezoneId:'Asia/Tokyo'}), page=await ctx.newPage();
  const expiry='2026-09-26T04:00:00.000Z'; // Server's next Eastern midnight, not browser-local midnight.
  await page.clock.install({time:new Date('2026-09-26T02:00:00Z')});
  await ctx.addInitScript(()=>localStorage.setItem('rooted.kiosk.station.v1','a'.repeat(64)));
  let locks=0,unlocks=0,contexts=0,kind='normal',checked=false,personReads=0;
  const dailyErrors=[];page.on('pageerror',e=>dailyErrors.push(e.message));
  await ctx.route('**/*',async r=>{
   const u=new URL(r.request().url());if(u.origin!==origin)return r.abort();
   if(!['/api/kiosk','/api/station'].includes(u.pathname))return r.continue();
   const b=r.request().postDataJSON();let data;
   if(u.pathname==='/api/station'){
    if(b.action==='lock'){locks++;return r.fulfill({json:{ok:true}});}
    unlocks++;return r.fulfill({json:{ok:true,device_token:'b'.repeat(64),event_id:id,expires_at:expiry}});
   }
   if(kind==='denied')return r.fulfill({status:403,json:{error:'forbidden'}});
   if(b.action==='context'){contexts++;data={event:{id,name:'Daily Mock Rooted',date:'2026-09-25',reading_week:'2026-09-21'}};}
   if(b.action==='search')data={matches:[{id,name:'Alex Example'}]};
   if(b.action==='person'){personReads++;data={person:{id:kind==='wrong-person'?'00000000-0000-4000-8000-000000000002':id,name:'Alex Example'},needs_leader:false,already_checked_in:checked,prior_chapters:7,receipt:checked?receipt:null};}
   if(b.action==='checkin'){
    if(kind==='pending')return r.abort();
    if(['conflict','unconfirmed','wrong-person'].includes(kind)){checked=kind!=='unconfirmed';return r.fulfill({status:409,json:{error:'checkin_conflict'}});}
    data={action:'kiosk.checkin',request_id:b.request_id,result:{duplicate:kind==='duplicate',receipt}};
   }
   return r.fulfill({json:data});
  });
  await page.goto(origin+'/kiosk.html');
  const unlock=async()=>{await page.locator('#pin').fill('123456');await page.locator('#activate-form button[type=submit]').click();await expect(page.locator('#search-screen')).toBeVisible();};
  const choose=async()=>{await page.locator('#query').fill('Alex');await page.clock.fastForward(350);await page.locator('.person-option').click();};
  const submit=async()=>{await page.locator('#bible-yes').click();await page.locator('#submit-checkin').click();};
  await unlock();ok(await page.evaluate(()=>sessionStorage.getItem('rooted.kiosk.expires.v1'))===expiry,'stores exact returned expiry');
  await page.reload();await expect(page.locator('#search-screen')).toBeVisible();ok(unlocks===1&&contexts===2,'reload validates capability without PIN');
  await choose();await page.locator('#bible-yes').click();await page.clock.fastForward(900100);await expect(page.locator('#search-screen')).toBeVisible();ok(locks===0&&unlocks===1,'15 min child reset does not revoke daily capability');ok(await page.locator('#chapters').inputValue()===''&&await page.locator('#person-name').textContent()==='','idle clears child');
  await choose();await submit();await expect(page.locator('#receipt-screen')).toBeVisible();await expect(page.locator('#points')).toHaveText('20');await expect(page.locator('#components')).toContainText('Attendance: 20');
  await page.clock.fastForward(2000);await page.keyboard.press('Shift');await page.clock.fastForward(2000);await expect(page.locator('#receipt-screen')).toBeVisible();checks++;
  await page.locator('#receipt-note').click();await page.clock.fastForward(2000);await expect(page.locator('#receipt-screen')).toBeVisible();checks++;
  await page.locator('#keep-open').click();await page.clock.fastForward(10000);await expect(page.locator('#receipt-screen')).toBeVisible();await expect(page.locator('#keep-open')).toHaveAttribute('aria-pressed','true');checks++;
  await page.screenshot({path:`${artifacts}/receipt-paused-390.png`,fullPage:true});
  await page.locator('#keep-open').click();await page.clock.fastForward(3100);await expect(page.locator('#search-screen')).toBeVisible();ok(await page.locator('#points').textContent()===''&&await page.locator('#bible-summary').textContent()===''&&await page.locator('#receipt-id').textContent()===''&&await page.locator('#query').inputValue()==='','auto return clears child/receipt and search');
  kind='duplicate';await choose();await submit();await expect(page.locator('#receipt-screen')).toBeVisible();await expect(page.locator('#receipt-screen h1')).toHaveText('Already checked in.');await page.clock.fastForward(3100);await expect(page.locator('#search-screen')).toBeVisible();checks++;
  kind='conflict';await choose();await expect(page.locator('#bible-step')).toBeVisible();const reads=personReads;await submit();await expect(page.locator('#receipt-screen')).toBeVisible();await expect(page.locator('#receipt-screen h1')).toHaveText('Already checked in.');ok(personReads===reads+1,'conflict confirmed by exact person read');await page.clock.fastForward(3100);await expect(page.locator('#search-screen')).toBeVisible();
  checked=false;kind='unconfirmed';await choose();await submit();await expect(page.locator('#pending-screen')).toBeVisible();await expect(page.locator('#status')).toContainText('different check-in');await page.clock.fastForward(4000);await expect(page.locator('#pending-screen')).toBeVisible();ok(await page.evaluate(()=>!!sessionStorage.getItem('rooted.kiosk.pending.v1')),'unconfirmed conflict never claims success');
  kind='wrong-person';await page.locator('#retry').click();await expect(page.locator('#status')).toContainText('different check-in');await expect(page.locator('#pending-screen')).toBeVisible();checks++;
  kind='pending';await page.locator('#retry').click();await expect(page.locator('#status')).toContainText('No server confirmation');await page.clock.fastForward(900100);await expect(page.locator('#pending-screen')).toBeVisible();ok(locks===0,'pending survives 15 minutes without revoke');
  page.on('dialog',d=>d.accept());await page.reload();await expect(page.locator('#pending-screen')).toBeVisible();ok(unlocks===1,'pending restored without second PIN');
  kind='normal';await page.locator('#retry').click();await expect(page.locator('#receipt-screen')).toBeVisible();await page.clock.fastForward(3100);await expect(page.locator('#search-screen')).toBeVisible();
  kind='denied';await page.locator('#query').fill('Alex');await page.clock.fastForward(350);await expect(page.locator('#activation')).toBeVisible();ok(await page.evaluate(()=>sessionStorage.getItem('rooted.kiosk.device.v1'))===null,'server denial clears capability');ok(await page.locator('#query').inputValue()==='','denial clears child');
  kind='normal';await unlock();await page.locator('#lock').click();await expect(page.locator('#status')).toHaveText('Station locked.');ok(locks===1,'explicit Lock revokes on server');await unlock();await page.clock.fastForward(7200000);await expect(page.locator('#activation')).toBeVisible();ok(await page.evaluate(()=>sessionStorage.getItem('rooted.kiosk.expires.v1'))===null,'server returned daily expiry clears session even in Tokyo browser');ok(locks===1,'automatic expiry is not explicit revocation');
  await page.reload();await expect(page.locator('#activate-form')).toBeVisible();ok(unlocks===3,'expired reload remains PIN gated');await page.screenshot({path:`${artifacts}/daily-pin-390.png`,fullPage:true});
  ok(dailyErrors.length===0,'daily browser no errors');await ctx.close();
 }
 console.log(JSON.stringify({passed:checks,artifacts,evidence:'Mock APIs only; real Chromium; canceled transport forced to finish out of order; daily expiry clock and receipt inactivity verified'}));
}finally{await browser.close();await server.close();}
