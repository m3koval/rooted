// Real Chromium, fictional values and intercepted APIs only; no hosted writes.
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { PROJECT_URL } from '../src/core.js';
const server = await createServer({server:{host:'localhost',port:0},define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify(PROJECT_URL),'import.meta.env.VITE_SUPABASE_ANON_KEY':JSON.stringify('sb_publishable_mock_only')}});
await server.listen();
const origin=`http://localhost:${server.httpServer.address().port}`;
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
let checks=0;const ok=(value,label)=>{assert.ok(value,label);checks++;};
const artifacts='/tmp/rooted-pin-qa';await mkdir(artifacts,{recursive:true});
try {
 const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let unlocks=0,updates=0;
 const user={id:'00000000-0000-4000-8000-000000000001',email:'fictional@example.invalid',email_confirmed_at:'2026-01-01T00:00:00Z',aud:'authenticated',role:'authenticated',is_anonymous:false};
 const token=[{alg:'HS256',typ:'JWT'},{sub:user.id,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'},'mock'].map(v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url')).join('.');
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());let data;
  if(url.origin===origin){
   if(url.pathname==='/api/station'){unlocks++;ok(route.request().postDataJSON().pin==='012345','unlock preserves zero');return route.fulfill({status:403,json:{ok:false,error:'invalid_pin'}});}
   return route.continue();
  }
  if(url.origin!==PROJECT_URL)return route.abort();
  if(url.pathname.endsWith('/token'))data={access_token:token,refresh_token:'mock-only',token_type:'bearer',expires_in:3600,user};
  else if(url.pathname.endsWith('/user'))data=user;
  else if(url.pathname.endsWith('/rpc/rooted_identity'))data={actor_id:user.id,role:'leader',display_name:'Fictional Leader'};
  else if(url.pathname.endsWith('/rpc/rooted_set_checkin_pin')){updates++;ok(route.request().postDataJSON().p_pin==='012345','leader preserves zero');data={ok:true};}
  else if(url.pathname.includes('/rest/v1/rpc/'))data={rows:[]};
  else return route.abort();
  return route.fulfill({json:data});
 });
 await page.goto(origin+'/kiosk.html');
 ok(await page.locator('#token').getAttribute('maxlength')==='64','enrollment remains 64 characters');
 await page.locator('#token').fill('a'.repeat(64));await page.getByRole('button',{name:'Remember this station'}).click();
 const pin=page.locator('#pin');
 await pin.focus();await page.keyboard.type('012345');
 ok(await pin.inputValue()==='012345','keyboard preserves zero');ok(unlocks===0,'six digits never auto-submit');
 ok(await page.locator('.pin-cells span').count()===6,'six visual cells');ok(await page.locator('.pin-cells').innerText()==='●\n●\n●\n●\n●\n●','only masked dots in cells');
 await page.keyboard.press('ArrowLeft');await page.keyboard.press('Backspace');ok(await pin.inputValue()==='01235','native arrow and backspace');
 await page.keyboard.press('ControlOrMeta+A');await page.keyboard.press('Delete');ok(await pin.inputValue()==='','keyboard clear');ok((await page.locator('.pin-cells').innerText()).trim()==='','visual clear');
 await page.getByRole('button',{name:'Unlock station'}).click();ok(await page.locator('#pin-error').innerText()==='Enter all six numbers, using digits 0–9.','friendly empty validation');ok(unlocks===0,'invalid blocks request');
 await pin.focus();await page.evaluate(()=>navigator.clipboard.writeText('０１-２３ ４５'));await page.keyboard.press('ControlOrMeta+V');ok(await pin.inputValue()==='012345','real clipboard normalization');
 for(const width of [320,390,1280]){
  await page.setViewportSize({width,height:900});await pin.focus();
  const layout=await page.locator('.pin-cells').evaluate(el=>({right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width,count:el.children.length,heights:[...el.children].map(c=>c.getBoundingClientRect().height),focus:getComputedStyle(el.querySelector('.is-active')).outlineWidth,overflow:document.documentElement.scrollWidth>innerWidth}));
  ok(!layout.overflow&&layout.right<=width&&layout.heights.every(h=>h>=54)&&layout.focus==='3px',`kiosk ${width} fits with focus`);
  await page.screenshot({path:`${artifacts}/kiosk-${width}.png`,fullPage:true});
 }
 await page.getByRole('button',{name:'Unlock station'}).click();await page.getByText('That PIN was not accepted.',{exact:false}).waitFor();ok(unlocks===1,'one deliberate unlock');ok(await pin.inputValue()==='','unlock clears native input');ok((await page.locator('.pin-cells').innerText()).trim()==='','unlock clears dots');
 await pin.fill('1234567');await page.getByRole('button',{name:'Unlock station'}).click();ok(unlocks===1,'overlong input not silently truncated/submitted');
 await page.evaluate(()=>document.querySelector('#activate-form').reset());ok(await pin.inputValue()==='','form reset clears input');ok((await page.locator('.pin-cells').innerText()).trim()==='','form reset clears cells');
 await page.goto(origin+'/leaders.html');await page.getByLabel('Email address').fill(user.email);await page.getByLabel('Password',{exact:true}).fill('fictional-password');await page.getByRole('button',{name:'Sign in →',exact:true}).click();await page.getByRole('button',{name:'My check-in PIN',exact:true}).click();
 const first=page.getByLabel('New six-digit PIN'),confirm=page.getByLabel('Confirm PIN');
 ok(await page.locator('.pin-native').count()===2,'one native input per field');
 await first.focus();await page.keyboard.type('012345');await page.keyboard.press('Tab');ok(await confirm.evaluate(el=>el===document.activeElement),'single tab stop per PIN');await page.keyboard.type('123456');
 await page.getByRole('button',{name:'Set my PIN'}).click();ok(await page.getByText('Those PINs do not match.',{exact:false}).isVisible(),'friendly mismatch');ok(updates===0,'mismatch blocks API');
 await confirm.fill('012345');
 for(const width of [320,390,1280]){
  await page.setViewportSize({width,height:900});await first.focus();
  ok(await page.locator('.pin-cells').evaluateAll(els=>els.every(el=>el.getBoundingClientRect().right<=innerWidth&&el.getBoundingClientRect().width>0)) ,`leader ${width} cells fit`);
  await page.screenshot({path:`${artifacts}/leader-${width}.png`,fullPage:true});
 }
 await page.getByRole('button',{name:'Set my PIN'}).click();await page.getByText('Your check-in PIN was updated.',{exact:true}).waitFor();ok(updates===1,'deliberate leader update');ok(await first.inputValue()===''&&await confirm.inputValue()==='','leader reset clears both');ok((await page.locator('.pin-cells').allInnerTexts()).every(v=>!v.trim()),'leader reset clears all cells');
 ok(await page.evaluate(()=>![...Object.values(localStorage),...Object.values(sessionStorage)].some(v=>v.includes('012345'))),'PIN not stored');ok(errors.length===0,'no browser exceptions');
 console.log(JSON.stringify({passed:checks,artifacts}));
} finally {await browser.close();await server.close();}
