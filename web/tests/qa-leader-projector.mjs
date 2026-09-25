// Offline fixtures: never sends requests to a hosted service.
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import assert from 'node:assert/strict';
import {PROJECT_URL} from '../src/core.js';
const server=await createServer({server:{host:'localhost',port:0},define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify(PROJECT_URL),'import.meta.env.VITE_SUPABASE_ANON_KEY':JSON.stringify('sb_publishable_mock_only')}});await server.listen();
const origin=`http://localhost:${server.httpServer.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
let checks=0;const ok=(x,label)=>{assert.ok(x,label);checks++;};
try{for(const width of [1920,390]){
 const context=await browser.newContext({viewport:{width,height:width===1920?1080:844}}),page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let denied=false,calls=[];const user={id:'00000000-0000-4000-8000-000000000001',email:'PRIVATE_EMAIL_SENTINEL@example.invalid',email_confirmed_at:'2026-01-01T00:00:00Z',aud:'authenticated',role:'authenticated'};
 const jwt=[{alg:'HS256',typ:'JWT'},{sub:user.id,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'},'mock'].map(v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url')).join('.');
 await context.route('**/*',async r=>{const u=new URL(r.request().url());if(u.origin===origin)return r.continue();assert.equal(u.origin,PROJECT_URL);let data;
 if(u.pathname.endsWith('/token'))data={access_token:jwt,refresh_token:'mock',token_type:'bearer',expires_in:3600,user};
 else if(u.pathname.endsWith('/user'))data=user;
 else if(u.pathname.endsWith('/logout'))return r.fulfill({status:204});
 else if(u.pathname.endsWith('/rpc/rooted_identity')){calls.push('identity');if(denied)return r.fulfill({status:403,json:{code:'42501'}});data={actor_id:user.id,role:'admin',display_name:'PRIVATE_LEADER_SENTINEL'};}
 else if(u.pathname.endsWith('/rpc/rooted_admin_profiles'))data={rows:[{participant_id:'p0',date_of_birth:'2001-02-03',guardian_contact:'PRIVATE_CONTACT_SENTINEL',guardian_name:'PRIVATE_GUARDIAN_SENTINEL'}]};
 else if(u.pathname.endsWith('/rpc/rooted_leader_state')){const c=r.request().postDataJSON().p_collection;calls.push(c);data={rows:c==='seasons'?[{id:'s',name:'Season',active:true}]:c==='events'?[{id:'e',season_id:'s',name:'Our gathering',date:'2026-09-25',open:true}]:c==='participants'?Array.from({length:19},(_,i)=>({id:'p'+i,name:i===0?'A very long fictional participant name that should never overflow the chart':'Person '+String(i).padStart(2,'0'),points:i<2?100:i===18?-15:100-i*5,guardian_contact:'PRIVATE_CONTACT_SENTINEL'})):c==='checkins'?[{event_id:'e',participant_id:'p0',attended:true}]:[]};}
 else throw Error('Unexpected '+u.pathname);await r.fulfill({json:data});});
 await page.clock.install();await page.goto(origin+'/leaders.html');await page.getByLabel('Email address').fill(user.email);await page.getByLabel('Password',{exact:true}).fill('fictional-password');await page.getByRole('button',{name:'Sign in →',exact:true}).click();await page.locator('.shell').waitFor();
 const tab=async(id,label)=>width<760?page.getByRole('combobox',{name:'Workspace',exact:true}).selectOption(id):page.getByRole('navigation',{name:'Workspace'}).getByRole('button',{name:label,exact:true}).click();
 await tab('profiles','Private profiles');await page.getByRole('button',{name:'Load private profiles'}).click();await page.locator('.draw-record').waitFor();
 ok(await page.locator('option[value="projector"]').count()===1,'mobile option exists');await tab('projector','Projector');await page.waitForTimeout(100);
 ok(!(await page.locator('.projector-screen').innerHTML()).includes('PRIVATE_'),'allowlist drops contacts and identity');
 ok((await page.locator('.projector-rank').allTextContents()).slice(0,3).join(',')==='1,1,3','shared competition ranks');
 await page.getByRole('button',{name:'Present fullscreen'}).click();await page.waitForTimeout(100);
 ok(await page.locator('.shell,.sidebar,.topbar,.context,dialog').count()===0,'no private chrome in DOM');ok(!(await page.locator('body').innerHTML()).includes('PRIVATE_'),'no sentinel in projection DOM');
 ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
 ok(await page.locator('.projector-row').evaluateAll(ns=>ns.every(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})),'all eight rows fit viewport');
 await page.screenshot({path:`/tmp/rooted-leader-projector-${width}.png`});
 const all=await page.locator('.projector-name').allTextContents();while(await page.getByRole('button',{name:'Next →',exact:true}).isEnabled()){await page.getByRole('button',{name:'Next →',exact:true}).click();all.push(...await page.locator('.projector-name').allTextContents());}ok(new Set(all).size===19,'all participants paginated');ok((await page.locator('.projector-points').allTextContents()).includes('-15 pts'),'signed negative points');
 await page.evaluate(()=>document.exitFullscreen?.().catch(()=>{}));ok(await page.locator('.shell').count()===0,'native fullscreen exit stays privacy safe');
 calls=[];await page.clock.fastForward(15001);await page.waitForTimeout(200);ok(calls.includes('participants')&&calls.includes('checkins')&&!calls.includes('ledger'),'lightweight timer refresh');
 await page.getByRole('button',{name:'Exit presentation'}).click();ok(await page.locator('.shell').count()===1,'explicit exit restores nav');
 await tab('community','Community');ok(await page.getByRole('button',{name:'Open Projector'}).count()===1,'community internal CTA');calls=[];await page.clock.fastForward(30001);await page.waitForTimeout(100);ok(calls.length===0,'timer stops off tab');
 await page.getByRole('button',{name:'Open Projector'}).click();await page.waitForTimeout(100);await page.getByRole('button',{name:'Present fullscreen'}).click();denied=true;await page.clock.fastForward(15001);await page.getByRole('heading',{name:'Presentation paused'}).waitFor();ok(await page.locator('.projector-row,.shell,input').count()===0,'auth expiry blanks rows and private login');await page.getByRole('button',{name:'Exit presentation'}).click();await page.getByLabel('Email address').waitFor();ok(await page.locator('.projector-row').count()===0,'no rows after revoked session');denied=false;await page.getByLabel('Email address').fill(user.email);await page.getByLabel('Password',{exact:true}).fill('fictional-password');await page.getByRole('button',{name:'Sign in →',exact:true}).click();await page.locator('.shell').waitFor();await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByLabel('Email address').waitFor();ok(await page.locator('.projector-row,.shell').count()===0,'explicit signout clears rows');ok(errors.length===0,'no runtime errors: '+errors);await context.close();
}console.log(JSON.stringify({passed:checks,viewports:['1920x1080','390x844'],screenshots:'/tmp/rooted-leader-projector-*.png'}));}finally{await browser.close();await server.close();}
