// Real Chromium; fictional secrets, intercepted APIs, no screenshots or hosted writes.
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import {PROJECT_URL} from '../src/core.js';
const server=await createServer({server:{host:'localhost',port:0},define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify(PROJECT_URL),'import.meta.env.VITE_SUPABASE_ANON_KEY':JSON.stringify('sb_publishable_mock_only')}});await server.listen();
const origin=`http://localhost:${server.httpServer.address().port}`;
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
let checks=0;const ok=(v,label)=>{assert.ok(v,label);checks++;};
try{
 const context=await browser.newContext();const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const secret='ab'.repeat(32);let role='admin',external=0;
 const user={id:'00000000-0000-4000-8000-000000000001',email:'fictional@example.invalid',email_confirmed_at:'2026-01-01T00:00:00Z',aud:'authenticated',role:'authenticated',is_anonymous:false};
 const jwt=[{alg:'HS256',typ:'JWT'},{sub:user.id,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'},'mock'].map(v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url')).join('.');
 await context.route('**/*',async r=>{const url=new URL(r.request().url());let data;
 if(url.origin===origin)return r.continue();if(url.origin!==PROJECT_URL){external++;return r.abort();}
 if(url.pathname.endsWith('/token'))data={access_token:jwt,refresh_token:'mock-only',token_type:'bearer',expires_in:3600,user};
 else if(url.pathname.endsWith('/user'))data=user;
 else if(url.pathname.endsWith('/logout'))return r.fulfill({status:204});
 else if(url.pathname.endsWith('/rpc/rooted_identity'))data={actor_id:user.id,role,display_name:'Fictional Admin'};
 else if(url.pathname.endsWith('/rpc/rooted_station_manage'))data=r.request().postDataJSON().p_action==='station.enroll'?{ok:true,station:{id:'station-1',token:secret}}:{ok:true,stations:[{id:'station-1',label:'Fictional station',expires_at:'2026-10-01',revoked_at:null}]};
 else if(url.pathname.includes('/rest/v1/rpc/')){const body=r.request().postDataJSON();const kind=body.p_collection;data={rows:kind==='seasons'?[{id:'season-1',name:'Fictional season',active:true}]:kind==='events'?[{id:'event-1',season_id:'season-1',name:'Fictional gathering',date:'2026-09-25',reading_week:'2026-09-21',open:true}]:[]};}
 else return r.abort();return r.fulfill({json:data});});
 await page.goto(origin+'/leaders.html');await page.getByLabel('Email address').fill(user.email);await page.getByLabel('Password',{exact:true}).fill('fictional-password');await page.getByRole('button',{name:'Sign in →',exact:true}).click();await page.getByRole('button',{name:'Manage',exact:true}).click();
 const enroll=async()=>{await page.getByLabel('Station label').fill('Fictional station');await page.getByRole('button',{name:'Enroll station',exact:true}).click();await page.getByText('Ready to scan with the check-in device camera.',{exact:true}).waitFor();};
 await enroll();
 const pixels=await page.locator('canvas').evaluate(c=>({width:c.width,height:c.height,data:[...c.getContext('2d').getImageData(0,0,c.width,c.height).data]}));
 ok(jsQR(new Uint8ClampedArray(pixels.data),pixels.width,pixels.height).data===`https://www.rooted3d.com/checkin#station=${secret}`,'real browser canvas decodes exact URL');
 ok(await page.evaluate(s=>![...Object.values(localStorage),...Object.values(sessionStorage)].some(v=>v.includes(s)),secret),'secret never stored');
 for(const width of [320,390,1280]){await page.setViewportSize({width,height:900});ok(await page.locator('canvas').evaluate(c=>c.getBoundingClientRect().right<=innerWidth),'QR fits viewport');}
 await page.evaluate(()=>{window.oldCanvas=document.querySelector('canvas');window.oldCode=document.querySelector('[name=station_token]');});
 await page.getByRole('button',{name:'Hide QR and enrollment code'}).click();ok(await page.evaluate(()=>oldCanvas.width===0&&oldCanvas.height===0&&oldCode.value===''),'hide wipes detached pixels and input');ok(await page.locator('canvas').count()===0,'hidden QR removed');
 await enroll();role='leader';await page.getByRole('button',{name:'↻ Refresh',exact:true}).click();await page.getByText('Shared records refreshed from the server.',{exact:true}).waitFor();ok(await page.locator('canvas').count()===0,'role downgrade wipes QR');
 role='admin';await page.getByRole('button',{name:'↻ Refresh',exact:true}).click();await page.getByRole('button',{name:'Manage',exact:true}).click();await enroll();await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Sign in →',exact:true}).waitFor();ok(await page.locator('canvas').count()===0,'signout removes QR');
 ok(external===0,'no third-party requests');ok(errors.length===0,'no browser errors');console.log(JSON.stringify({passed:checks,fictionalFixturesOnly:true}));
}finally{await browser.close();await server.close();}
