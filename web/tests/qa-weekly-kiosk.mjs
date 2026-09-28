import {chromium,expect} from '@playwright/test';
import {createServer} from 'vite';
import assert from 'node:assert/strict';
const server=await createServer({server:{host:'localhost',port:0}});await server.listen();
const origin=`http://localhost:${server.httpServer.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
const prior='00000000-0000-4000-8000-000000000001',current='00000000-0000-4000-8000-000000000002';
const pending={event_id:prior,request_id:prior,payload:{participant_id:prior,bible:true,chapters:2}};
try {
 const c=await browser.newContext(),p=await c.newPage();let writes=0;
 await c.addInitScript(({pending})=>{localStorage.setItem('rooted.kiosk.station.v1','a'.repeat(64));sessionStorage.setItem('rooted.kiosk.device.v1','b'.repeat(64));sessionStorage.setItem('rooted.kiosk.expires.v1',new Date(Date.now()+3600000).toISOString());sessionStorage.setItem('rooted.kiosk.pending.v1',JSON.stringify(pending));},{pending});
 await c.route('**/*',r=>{const u=new URL(r.request().url());if(u.origin!==origin)return r.abort();if(u.pathname!=='/api/kiosk')return r.continue();const b=r.request().postDataJSON();if(b.action==='checkin')writes++;return r.fulfill({json:{event:{id:current,name:'Fictional new gathering',date:'2026-10-02'}}});});
 await p.goto(origin+'/kiosk.html');await expect(p.locator('#activation')).toBeVisible();await expect(p.locator('#status')).toContainText('will not be moved to today');
 assert.equal(writes,0);assert.deepEqual(await p.evaluate(()=>JSON.parse(sessionStorage.getItem('rooted.kiosk.pending.v1'))),pending);
 await expect(p.locator('#search-screen')).toBeHidden();await c.close();
 const skipped=await browser.newContext(),page=await skipped.newPage();let unlocks=0,reads=0;
 await skipped.addInitScript(()=>localStorage.setItem('rooted.kiosk.station.v1','a'.repeat(64)));
 await skipped.route('**/*',r=>{const u=new URL(r.request().url());if(u.origin!==origin)return r.abort();if(u.pathname==='/api/station'){unlocks++;return r.fulfill({json:{ok:false,error:'no_current_gathering'}});}if(u.pathname==='/api/kiosk'){reads++;return r.abort();}return r.continue();});
 await page.clock.install({time:new Date('2026-10-30T20:00:00Z')});await page.goto(origin+'/kiosk.html');await page.locator('#pin').fill('012345');await page.locator('#pin').press('Enter');
 await expect(page.locator('#status')).toContainText('No gathering is available today');await expect(page.locator('#search-screen')).toBeHidden();assert.equal(unlocks,1);assert.equal(reads,0);assert.equal(await page.evaluate(()=>localStorage.getItem('rooted.kiosk.station.v1')),'a'.repeat(64));await skipped.close();
 console.log(JSON.stringify({passed:10,fixture:'old pending retained without submission; skipped Friday no-current retains enrollment and makes no kiosk read/write'}));
} finally {await browser.close();await server.close();}
