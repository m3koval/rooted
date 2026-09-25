// Real Chromium, fictional fixtures, intercepted APIs only. No live data or writes.
import {chromium,expect} from '@playwright/test';
import {createServer} from 'vite';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
const server=await createServer({server:{host:'localhost',port:0}});await server.listen();
const origin=`http://localhost:${server.httpServer.address().port}`;
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
const artifacts='/tmp/rooted-display-qa';await mkdir(artifacts,{recursive:true});
let checks=0;const ok=(v,m)=>{assert.ok(v,m);checks++;};
const names=['Avery Brooks','Jordan Ellis','Morgan Rivera','Riley Bennett','Charlie Hayes','Taylor Reed','Jamie Parker','Cameron Wells','Quinn Sawyer','Reese Collins','Alex Example','Sam Example'];
const fixture={event:{id:'mock-event',name:'Rooted · Friday gathering',date:'2026-09-25'},attendance_count:8,participants:names.map((name,i)=>({id:String(i),name,points:i===11?-25:i<2?1250:1100-i*75,present:i%3!==0})),updated_at:'2026-09-25T23:30:00Z'};
try{
 const c=await browser.newContext({viewport:{width:1920,height:1080}}),p=await c.newPage();let reads=0,unlocks=0,mode='',release,active=0,maxActive=0;const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.clock.install({time:new Date('2026-09-25T23:30:00Z')});
 await c.route('**/*',async r=>{
  const u=new URL(r.request().url());if(u.origin!==origin)return r.abort();
  if(u.pathname==='/api/station'){const b=r.request().postDataJSON();if(b.action==='unlock'){unlocks++;ok(r.request().headers()['x-rooted-station']==='a'.repeat(64),'station capability');ok(b.pin==='123456','PIN transport');}return r.fulfill({json:{ok:true,device_token:'b'.repeat(64),expires_at:'2026-09-26T04:00:00Z',event_id:'mock-event'}});}
  if(u.pathname!=='/api/display')return r.continue();reads++;active++;maxActive=Math.max(maxActive,active);
  ok(r.request().headers()['x-rooted-device-token']==='b'.repeat(64),'display capability header');ok(!r.request().headers().authorization,'no leader authorization');ok(JSON.stringify(r.request().postDataJSON())===JSON.stringify({action:'display',payload:{}}),'read only contract');
  if(mode==='delay')await new Promise(resolve=>release=resolve);active--;
  if(mode==='offline')return r.abort();if(mode==='denied')return r.fulfill({status:403,json:{error:'forbidden'}});
  return r.fulfill({json:mode==='empty'?{...fixture,participants:[],attendance_count:0}:fixture});
 });
 // Deliberately ignore abort to prove generation fence against late data.
 await c.addInitScript(()=>{const original=fetch;window.fetch=(url,options)=>original(url,String(url).includes('/api/display')?{...options,signal:undefined}:options);});
 await p.goto(origin+'/display#station='+ 'a'.repeat(64));ok(new URL(p.url()).hash==='','fragment scrub');ok(unlocks===0&&reads===0,'scan does not unlock');await p.locator('#pair-form button').click();
 await expect(p.locator('.pin-cells span')).toHaveCount(6);await p.screenshot({path:artifacts+'/pin-desktop.png',fullPage:true});
 const unlock=async()=>{await p.locator('#pin').fill('123456');await p.locator('#activate-form button').click();await expect(p.locator('.row')).toHaveCount(10);};
 await unlock();await expect(p.locator('#attendance')).toHaveText('8');ok(await p.locator('.rank').allTextContents().then(v=>v.slice(0,3).join(',')==='1,1,3'),'competition ties');ok(await p.locator('#pin').inputValue()==='','PIN cleared');ok(await p.evaluate(()=>sessionStorage.getItem('rooted.kiosk.device.v1'))===null,'display session isolated');
 await p.screenshot({path:artifacts+'/board-1920.png',fullPage:true});ok(await p.evaluate(()=>document.documentElement.scrollHeight<=innerHeight),'whole board fits 1080p');await p.locator('#fullscreen').click();ok(await p.evaluate(()=>!!document.fullscreenElement),'user gesture enters fullscreen');await p.locator('#fullscreen').click();ok(await p.locator('.row').last().evaluate(e=>e.getBoundingClientRect().bottom<innerHeight),'ten rows visible on TV');
 for(const width of [320,390,650,651,1280]){await p.setViewportSize({width,height:900});ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow '+width);if(width===390)await p.screenshot({path:artifacts+'/board-390.png',fullPage:true});}
 await p.locator('#next').click();await expect(p.locator('.row')).toHaveCount(2);await expect(p.locator('#chart')).toContainText('Alex Example');await expect(p.locator('.points').last()).toHaveText('-25');ok(await p.locator('.bar').last().evaluate(e=>e.style.width)==='0%','negative net points remain truthful with zero-width bar');await p.locator('#previous').click();
 const n=reads;await p.clock.fastForward(15001);await expect.poll(()=>reads).toBe(n+1);
 await p.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});const paused=reads;await p.clock.fastForward(60000);ok(reads===paused,'hidden tab stops polling');await p.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});await expect.poll(()=>reads).toBe(paused+1);await p.waitForTimeout(100);
 mode='empty';await p.clock.fastForward(15001);await expect(p.locator('#empty')).toBeVisible();await expect(p.locator('#attendance')).toHaveText('0');ok(await p.locator('.row').count()===0,'empty server state never invents people');mode='';await p.clock.fastForward(15001);await expect(p.locator('.row')).toHaveCount(10);
 mode='offline';await p.clock.fastForward(15001);await expect(p.locator('#status')).toContainText('last confirmed');await expect(p.locator('.row')).toHaveCount(10);await expect(p.locator('#updated')).toContainText('Last server update');
 mode='';await p.clock.fastForward(15001);await expect(p.locator('#status')).toHaveText('');
 mode='delay';await p.clock.fastForward(15001);await expect.poll(()=>!!release).toBe(true);await p.clock.fastForward(45000);ok(maxActive===1,'polling never overlaps');await p.locator('#lock').click();ok(await p.locator('.row').count()===0,'lock clears names synchronously');release();await p.waitForTimeout(100);ok(await p.locator('.row').count()===0,'late response cannot repopulate locked screen');
 mode='';await unlock();mode='denied';await p.clock.fastForward(15001);await expect(p.locator('#activate-form')).toBeVisible();ok(await p.locator('.row').count()===0,'revocation removes all names');ok(await p.evaluate(()=>sessionStorage.getItem('rooted.display.device.v1'))===null,'revocation clears token');
 mode='';await unlock();await p.clock.fastForward(6*60*60*1000);await expect(p.locator('#activate-form')).toBeVisible();ok(await p.locator('.row').count()===0,'daily expiry clears board');ok(errors.length===0,'no browser errors');await c.close();
 for(const suffix of ['#station='+ 'A'.repeat(64),'#station='+ 'a'.repeat(64)+'&x=1','?station='+ 'a'.repeat(64)]){const c=await browser.newContext(),p=await c.newPage();await p.goto(origin+'/display'+suffix);ok(new URL(p.url()).hash===''&&new URL(p.url()).search==='','invalid URL scrubbed');ok(await p.locator('#station').inputValue()==='','invalid code rejected');await c.close();}
 {const c=await browser.newContext();await c.addInitScript(()=>localStorage.setItem('sb-mock-auth-token','fictional'));const p=await c.newPage();await p.goto(origin+'/display#station='+ 'a'.repeat(64));await expect(p.locator('#leader-warning')).toBeVisible();await expect(p.locator('#pair-form')).toBeHidden();ok(await p.locator('#station').inputValue()==='','leader browser refuses enrollment');await c.close();}
 console.log(JSON.stringify({passed:checks,artifacts,evidence:'Mock APIs; real Chromium; clock-controlled polling/expiry; forced late response after lock'}));
}finally{await browser.close();await server.close();}
