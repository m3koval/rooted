// Local fictional fixtures only. Reduced visualViewport is a simulation, not iPad Safari evidence.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const out='/tmp/rooted-fixes/kiosk'; await mkdir(out,{recursive:true});
const server=await createServer({server:{host:'localhost',port:0}});await server.listen();
const origin=`http://localhost:${server.httpServer.address().port}`;
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-renderer-accessibility']});
const id='00000000-0000-4000-8000-000000000001';let checks=0;
const ok=(v,m)=>{assert.ok(v,m);checks++;};
try {
 const c=await browser.newContext({viewport:{width:1024,height:768},hasTouch:true});const p=await c.newPage();const writes=[],errors=[];p.on('pageerror',e=>errors.push(e.message));
 await c.addInitScript(()=>{localStorage.setItem('rooted.kiosk.station.v1','a'.repeat(64));sessionStorage.setItem('rooted.kiosk.device.v1','b'.repeat(64));sessionStorage.setItem('rooted.kiosk.expires.v1',new Date(Date.now()+3600000).toISOString());});
 await c.route('**/*',r=>{const u=new URL(r.request().url());if(u.origin!==origin)return r.abort();if(u.pathname!=='/api/kiosk')return r.continue();const b=r.request().postDataJSON();let data;
 if(b.action==='context')data={event:{id,name:'Rooted · Fictional review',date:'2026-09-25',reading_week:'2026-09-21'}};
 if(b.action==='search')data={matches:Array.from({length:12},(_,i)=>({id,name:i?'Alex Example '+(i+1):'Alex Example'}))};
 if(b.action==='person')data={person:{id,name:'Alex Example'},needs_leader:false,already_checked_in:false,prior_chapters:7};
 if(b.action==='checkin'){writes.push(b);data={action:'kiosk.checkin',request_id:b.request_id,result:{duplicate:false,receipt:{checkin_id:id,earned_points:20,components:[{label:'Attendance',points:20}]}}};}
 return r.fulfill({json:data});});
 await p.goto(origin+'/kiosk.html');await expect(p.locator('#search-screen')).toBeVisible();
 await p.locator('#query').fill('Alex');await expect(p.locator('.person-option')).toHaveCount(12);
 await p.screenshot({path:out+'/kiosk-ipad-name.png'});
 await p.evaluate(()=>{Object.defineProperty(window.visualViewport,'height',{configurable:true,value:410});window.visualViewport.dispatchEvent(new Event('resize'));});
 ok(await p.locator('.layout').evaluate(e=>e.getBoundingClientRect().height<=410),'shell follows reduced visualViewport');
 const qr=await p.locator('#query').boundingBox();const first=await p.locator('.person-option').first().boundingBox();ok(qr.y<170&&first.y+first.height<410,'search and first result above simulated keyboard');
 await p.evaluate(()=>{const n=document.createElement('div');n.id='simulation-label';n.textContent='REVIEW SIMULATION · reduced visualViewport · not a real iPad keyboard';Object.assign(n.style,{position:'fixed',bottom:'8px',left:'12px',color:'white',fontSize:'13px'});document.body.append(n);});
 await p.screenshot({path:out+'/kiosk-ipad-name-keyboard-simulation.png'});
 await p.locator('.person-option').first().click();await expect(p.locator('#bible-step')).toBeVisible();ok(await p.evaluate(()=>document.activeElement.id!=='query'),'name blurred');
 await p.evaluate(()=>{delete window.visualViewport.height;window.visualViewport.dispatchEvent(new Event('resize'));document.getElementById('simulation-label').remove();});
 await p.locator('#bible-yes').click();await expect(p.locator('#submit-checkin')).toBeDisabled();ok(await p.locator('#chapters').inputValue()==='','prior count is information, not an implicit choice');
 ok(await p.evaluate(()=>!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)),'chapters do not focus native input');
 await expect(p.locator('[data-chapters]')).toHaveCount(11);
 await p.screenshot({path:out+'/kiosk-ipad-chapters.png'});
 for(let n=1;n<=10;n++){await p.locator(`[data-chapters="${n}"]`).click();ok(await p.locator('#chapters').inputValue()===String(n),'quick choice '+n);await expect(p.locator(`[data-chapters="${n}"]`)).toHaveAttribute('aria-pressed','true');}
 await expect(p.locator('[data-chapters]').first()).toHaveAttribute('data-chapters','0');
 await p.locator('#more-chapters').click();await expect(p.locator('#keypad-value')).toHaveText('—');await expect(p.locator('#keypad-done')).toBeDisabled();await p.keyboard.press('Enter');await expect(p.locator('#keypad-value')).toHaveText('1');await p.locator('#keypad-clear').focus();await p.keyboard.press('Space');await expect(p.locator('#keypad-value')).toHaveText('—');
 await expect(p.locator('[data-chapters][aria-pressed="true"]')).toHaveCount(0);await expect(p.locator('#chapters')).toHaveValue('');await expect(p.locator('#submit-checkin')).toBeDisabled();
 for(const digit of ['0','0','1','2'])await p.locator(`[data-digit="${digit}"]`).click();await expect(p.locator('#keypad-value')).toHaveText('12');
 await p.locator('#keypad-backspace').click();await expect(p.locator('#keypad-value')).toHaveText('1');await p.keyboard.press('2');
 await p.screenshot({path:out+'/kiosk-ipad-chapters-keypad.png'});
 await expect(p.locator('#keypad-done')).toHaveText('Use this number');await p.locator('#keypad-done').click();await expect(p.locator('#submit-checkin')).toBeEnabled();ok(await p.locator('#chapters').inputValue()==='12','Done chooses normalized count');ok(writes.length===0,'no implicit submit');
 await p.locator('#more-chapters').click();await expect(p.locator('#keypad-value')).toHaveText('—');await p.keyboard.type('100001');await expect(p.locator('#keypad-done')).toBeDisabled();await expect(p.locator('#keypad-error')).toContainText('100000');await p.keyboard.press('Backspace');await p.locator('#keypad-done').focus();await p.keyboard.press('Enter');ok(await p.locator('#chapters').inputValue()==='10000','hardware editing and Enter only finish keypad');ok(writes.length===0,'keypad Enter never submits');
 await p.locator('#more-chapters').click();await p.keyboard.type('100000');await expect(p.locator('#keypad-done')).toBeEnabled();await expect(p.locator('#keypad-done')).toHaveText('Use this number');await p.locator('#keypad-done').click();ok(await p.locator('#chapters').inputValue()==='100000','server maximum remains selectable');
 await p.locator('[data-chapters="0"]').click();ok(await p.locator('#chapters').inputValue()==='0','None explicitly chooses zero');
 for(const size of [{width:1024,height:768},{width:768,height:1024},{width:390,height:844},{width:320,height:568}]){await p.setViewportSize(size);ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');await p.locator('#submit-checkin').scrollIntoViewIfNeeded();await p.screenshot({path:out+`/kiosk-chapters-${size.width}.png`});if(size.width===390){const cells=await p.locator('.quick-chapters button').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};}));ok(new Set(cells.map(c=>c.x)).size===4&&new Set(cells.map(c=>c.y)).size===3,'equal 4 by 3 phone grid');ok(cells.every(c=>c.w===cells[0].w&&c.h===cells[0].h),'equal chapter targets');}}
 await p.locator('#submit-checkin').click();await expect(p.locator('#receipt-screen')).toBeVisible();await expect(p.locator('#receipt-screen h1')).toHaveText('You’re checked in!');await expect(p.locator('#receipt-id')).toBeHidden();await expect(p.locator('#receipt-screen')).not.toContainText(/server|receipt/i);ok(writes.length===1&&writes[0].payload.chapters===0,'explicit Check in writes once');await p.locator('#next').click();ok(await p.evaluate(()=>document.activeElement.id!=='query'),'reset does not pop name keyboard');ok(errors.length===0,'no runtime errors');
 await expect(p.locator('#lock')).toBeHidden();await p.locator('#staff-tools summary').focus();await p.keyboard.press('Enter');await expect(p.locator('#lock')).toBeVisible();p.once('dialog',d=>d.dismiss());await p.locator('#forget').click();ok(await p.evaluate(()=>!!localStorage.getItem('rooted.kiosk.station.v1')),'forget cancel retains pairing');p.once('dialog',d=>d.accept());await p.locator('#forget').click();await expect(p.locator('#pair-form')).toBeVisible();ok(await p.evaluate(()=>localStorage.getItem('rooted.kiosk.station.v1'))===null,'confirmed forget clears pairing');
 await writeFile(out+'/kiosk-review.json',JSON.stringify({checks,screenshots:'Fictional fixture data. Chromium tablet dimensions, not physical iPad. Name screenshot simulates visualViewport height 410; no native keyboard captured.'},null,2));console.log(JSON.stringify({passed:checks,artifacts:out}));
} finally {await browser.close();await server.close();}
