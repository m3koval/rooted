import {chromium,expect} from '@playwright/test';
import {createServer} from 'vite';
import {mkdir} from 'node:fs/promises';
import {PROJECT_URL} from '../src/core.js';
const out='/tmp/rooted-fixes/leaders';await mkdir(out,{recursive:true});
const server=await createServer({server:{host:'localhost',port:0},define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify(PROJECT_URL),'import.meta.env.VITE_SUPABASE_ANON_KEY':JSON.stringify('sb_publishable_mock_only')}});await server.listen();
const origin=`http://localhost:${server.httpServer.address().port}`;const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
let checks=0;const check=async(fn)=>{await fn();checks++;};
try{for(const width of [390,1024]){const context=await browser.newContext({viewport:{width,height:844}}),page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));let denied=false,role='admin',today=true,profileDelay=false,releaseProfile;let teamCalls=0,stationEvent='e2',transferIds=[];
const user={id:'00000000-0000-4000-8000-000000000001',email:'fictional@example.invalid',email_confirmed_at:'2026-01-01T00:00:00Z',aud:'authenticated',role:'authenticated'};
const jwt=[{alg:'HS256',typ:'JWT'},{sub:user.id,exp:1999999999,role:'authenticated'},'mock'].map(v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url')).join('.');
await context.route('**/*',async r=>{const u=new URL(r.request().url());if(u.origin===origin&&u.pathname==='/api/team'){teamCalls++;return r.fulfill({json:{actor_id:user.id,members:[],invitations:[],has_more:false}});}if(u.origin===origin)return r.continue();if(u.origin!==PROJECT_URL)throw Error('Unexpected external request');let data;
if(u.pathname.endsWith('/token'))data={access_token:jwt,refresh_token:'mock',token_type:'bearer',expires_in:3600,user};
else if(u.pathname.endsWith('/user'))data=user;
else if(u.pathname.endsWith('/rpc/rooted_identity')){if(denied)return r.fulfill({status:403,json:{code:'42501'}});data={actor_id:user.id,role,display_name:'Fictional leader'};}
else if(u.pathname.endsWith('/rpc/rooted_station_manage'))data={ok:true,stations:[{id:'station1',label:'Fictional station',event_id:stationEvent,expires_at:'2026-12-01T00:00:00Z',revoked_at:null}]};
else if(u.pathname.endsWith('/rpc/rooted_station_transfer')){const b=r.request().postDataJSON();transferIds.push(b.p_request_id);stationEvent=b.p_event_id;if(transferIds.length===1)return r.abort();data={request_id:b.p_request_id,action:'station.transfer',result:{id:b.p_station_id,event_id:b.p_event_id}};}
else if(u.pathname.endsWith('/rpc/rooted_admin_profiles')){if(profileDelay)await new Promise(resolve=>releaseProfile=resolve);data={rows:[{participant_id:'p1',parent_guardian_email:'PRIVATE_CARE@example.invalid'}]};}
else if(u.pathname.endsWith('/rpc/rooted_leader_state')){const c=r.request().postDataJSON().p_collection;data={rows:c==='seasons'?[{id:'s1',name:'Fictional season',active:true}]:c==='events'?[{id:'e1',season_id:'s1',name:'Current gathering',date:today?'2026-09-25':'2026-09-24',reading_week:'2026-09-21',open:true},{id:'e2',season_id:'s1',name:'Future gathering',date:'2026-10-02',open:true}]:c==='participants'?[{id:'p1',name:'Jordan Fiction',points:10},{id:'p2',name:'Sam Fiction',points:10}]:[]};}
else throw Error('Unexpected RPC '+u.pathname);return r.fulfill({json:data});});
await page.clock.install({time:new Date('2026-09-26T02:00:00Z')});await page.goto(origin+'/leaders.html');await page.getByLabel('Email address').fill(user.email);await page.getByLabel('Password',{exact:true}).fill('fictional');await page.getByRole('button',{name:'Sign in →',exact:true}).click();await page.locator('.shell').waitFor();
const nav=label=>page.getByRole('navigation',{name:'Workspace'}).getByRole('button',{name:label,exact:true}).click();
await check(()=>expect(page.locator('select[name=event]')).toHaveValue('e1'));
await check(()=>expect(page.getByRole('button',{name:'Check in',exact:true}).first()).toBeEnabled());
await page.locator('select[name=event]').selectOption('e2');
await check(()=>expect(page.locator('.tonight-summary')).toContainText('Scheduled'));
await check(()=>expect(page.getByRole('button',{name:'Check in',exact:true}).first()).toBeDisabled());
await nav('Events');await check(()=>expect(page.locator('#view')).toContainText('midnight Eastern'));
await page.clock.setFixedTime(new Date('2026-10-03T04:01:00Z'));
await nav('Tonight');await check(()=>expect(page.locator('.tonight-summary')).toContainText('Closed'));
await check(()=>expect(page.getByRole('button',{name:'Check in',exact:true}).first()).toBeDisabled());
await page.clock.setFixedTime(new Date('2026-10-02T20:00:00Z'));
await page.goto(origin+'/leaders.html');await page.locator('.shell').waitFor();
await check(()=>expect(page.locator('select[name=event]')).toHaveValue('e2'));
await check(()=>expect(page.getByRole('button',{name:'Check in',exact:true}).first()).toBeEnabled());
await page.screenshot({path:`${out}/${width}-weekly.png`,fullPage:true});
if(errors.length)throw Error(errors.join('\n'));await context.close();}
console.log(JSON.stringify({passed:checks,fictionalFixturesOnly:true}));}finally{await browser.close();await server.close();}
