// Chromium viewport QA: fictional Auth/API fixtures only; no hosted traffic.
import {chromium} from '@playwright/test';
import {leaderRoute} from './leader-navigation.mjs';
import {createServer} from 'vite';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {PROJECT_URL} from '../src/core.js';
const server=await createServer({server:{host:'localhost',port:0},define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify(PROJECT_URL),'import.meta.env.VITE_SUPABASE_ANON_KEY':JSON.stringify('sb_publishable_mock_only')}});
await server.listen();
const origin=`http://localhost:${server.httpServer.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-renderer-accessibility']});
const output=process.env.QA_SCREENSHOTS||'/tmp/rooted-app-review';await mkdir(output,{recursive:true});
let checks=0;const ok=(value,label)=>{assert.ok(value,label);checks++;};
const tabs=[['checkin','Tonight'],['community','Community'],['draw','Drawings'],['history','History'],['settings','Ministry'],['profiles','People'],['events','Events'],['preferences','Settings'],['pin','My check-in PIN'],['security','My passkeys']];
try{
 for(const [width,height] of [[320,900],[390,844],[430,900],[1024,768],[768,1024],[1280,900]]){
  const mobile=width<760,context=await browser.newContext({viewport:{width,height},hasTouch:mobile,isMobile:mobile});const page=await context.newPage();const errors=[];let logout=0,unexpected=0,profileCalls=0,role='admin';
  page.on('pageerror',e=>errors.push(e.message));
  const user={id:'00000000-0000-4000-8000-000000000001',email:'fictional@example.invalid',email_confirmed_at:'2026-01-01T00:00:00Z',aud:'authenticated',role:'authenticated',is_anonymous:false};
  const jwt=[{alg:'HS256',typ:'JWT'},{sub:user.id,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'},'mock'].map(v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url')).join('.');
  await context.route('**/*',async r=>{const url=new URL(r.request().url());let data;if(url.origin===origin)return r.continue();if(url.origin!==PROJECT_URL){unexpected++;return r.abort();}
   if(url.pathname.endsWith('/token'))data={access_token:jwt,refresh_token:'mock-only',token_type:'bearer',expires_in:3600,user};
   else if(url.pathname.endsWith('/user'))data=user;
   else if(url.pathname.endsWith('/logout')){logout++;return r.fulfill({status:204});}
   else if(url.pathname.endsWith('/rpc/rooted_identity'))data={actor_id:user.id,role,display_name:'Fictional Leader'};
   else if(url.pathname.endsWith('/rpc/rooted_leader_state')){const kind=r.request().postDataJSON().p_collection;data={rows:kind==='seasons'?[{id:'s1',name:'Fictional season',active:true}]:kind==='events'?['e1','e2'].map((id,i)=>({id,season_id:'s1',name:`Fictional gathering ${i+1}`,date:'2026-09-25',reading_week:'2026-09-21',open:true})):kind==='participants'?[{id:'p1',name:'Avery Brooks',active:true,points:25},{id:'p2',name:'Jordan Ellis',active:true,points:18},{id:'p3',name:'Morgan Reed',active:true,points:12},{id:'p4',name:'Riley Parker',active:true,points:8}]:kind==='checkins'?[{event_id:'e1',participant_id:'p1',attended:true}]:[]};}
   else if(url.pathname.endsWith('/rpc/rooted_admin_profiles')){profileCalls++;data={rows:[{participant_id:'p1',parent_guardian_email:'PRIVATE_CARE@example.invalid'}]};}
   else{unexpected++;return r.abort();}return r.fulfill({json:data});
  });
  await page.goto(origin+'/leaders.html');await page.getByLabel('Email address').fill(user.email);await page.getByLabel('Password',{exact:true}).fill('fictional-password');await page.getByRole('button',{name:'Sign in →',exact:true}).click();await page.locator('.shell').waitFor();
  await page.getByRole('combobox',{name:'Gathering',exact:true}).selectOption('e1');
  ok(profileCalls===0,'profiles not loaded during boot');
  await page.getByRole('button',{name:'Here',exact:true}).click();ok(await page.locator('.roster .person-row').count()===1,'Here filter');
  await page.getByRole('button',{name:'Not checked in',exact:true}).click();ok(await page.locator('.roster .person-row').count()===3,'Not checked in filter');
  await page.getByLabel('Search roster').fill('Jordan');ok(await page.locator('.roster .person-row').count()===1,'search and filter combine');
  await page.getByRole('button',{name:'Check in',exact:true}).click();await page.getByRole('button',{name:'Save check-in',exact:true}).waitFor();await page.getByRole('button',{name:'Close',exact:true}).click();
  await leaderRoute(page,'profiles');ok(profileCalls===0,'People requires explicit load');await page.getByRole('button',{name:'Load private profiles'}).click();await page.locator('.draw-record').waitFor();ok(!(await page.locator('body').innerHTML()).includes('PRIVATE_CARE'),'no contacts in directory DOM');
  await page.locator('.draw-record summary').click();await page.getByText('Email: PRIVATE_CARE@example.invalid',{exact:true}).waitFor();
  await leaderRoute(page,'checkin');ok(!(await page.locator('body').innerHTML()).includes('PRIVATE_CARE'),'contacts cleared on exit');
  for(const [id,label] of tabs){
   await leaderRoute(page,id);
   ok(await page.locator('#view').count()===1,`${width} ${id}: one view`);
   ok(await page.getByRole('heading',{level:1}).count()===1,`${width} ${id}: one accessible heading`);
   ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width} ${id}: no page overflow`);
   ok(await page.getByRole('heading',{level:1}).innerText()===label,`${width} ${id}: current heading`);
   const primary=['settings','pin','security','preferences'].includes(id)?'Settings':id==='profiles'?'People':id==='events'?'Events':'Tonight';
   ok(await page.locator('.app-navigation [aria-current="page"]').innerText()===primary,`${width} ${id}: current destination`);
   const targets='.app-navigation button,.topbar button,.context select';
   const sizes=await page.locator(targets).evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right};}));
   ok(sizes.every(r=>r.width>=44&&r.height>=44&&r.left>=0&&r.right<=width),`${width} ${id}: reachable 44px controls`);
  }
  await leaderRoute(page,'checkin');
  await page.getByRole('combobox',{name:'Gathering',exact:true}).selectOption('e2');ok(await page.getByRole('combobox',{name:'Gathering',exact:true}).inputValue()==='e2',`${width}: gathering selection works`);
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${output}/${width}.png`});
  if(mobile){await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));await page.screenshot({path:`${output}/${width}-scrolled.png`});}
  role='leader';await page.getByRole('button',{name:'↻ Refresh',exact:true}).click();await page.getByText('Shared records refreshed from the server.',{exact:true}).waitFor();await leaderRoute(page,'preferences');ok(await page.getByRole('button',{name:'Ministry',exact:true}).count()===0,'leader cannot access admin settings');await leaderRoute(page,'events');ok(await page.getByRole('button',{name:'Create season',exact:true}).count()===0,'leader cannot manage seasons');
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Sign in →',exact:true}).waitFor();await page.waitForTimeout(100);
  ok(logout===1,`${width}: signout sent`);ok(await page.locator('.shell').count()===0,`${width}: private workspace cleared`);ok(errors.length===0,`${width}: no JS errors ${errors}`);ok(unexpected===0,`${width}: only expected mocked calls`);await context.close();
 }
 console.log(JSON.stringify({passed:checks,widths:[320,390,430,1024,768,1280],screenshots:output,fictionalFixturesOnly:true}));
}finally{await browser.close();await server.close();}
