// Chromium viewport QA: fictional Auth/API fixtures only; no hosted traffic.
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {PROJECT_URL} from '../src/core.js';
const server=await createServer({server:{host:'localhost',port:0},define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify(PROJECT_URL),'import.meta.env.VITE_SUPABASE_ANON_KEY':JSON.stringify('sb_publishable_mock_only')}});
await server.listen();
const origin=`http://localhost:${server.httpServer.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
const output=process.env.QA_SCREENSHOTS||'/tmp/rooted-mobile-navigation';await mkdir(output,{recursive:true});
let checks=0;const ok=(value,label)=>{assert.ok(value,label);checks++;};
const tabs=[['checkin','Check-in'],['community','Community'],['draw','Drawings'],['history','History'],['settings','Manage'],['profiles','Private profiles'],['pin','My check-in PIN'],['security','My passkeys']];
try{
 for(const width of [320,390,430,1280]){
  const mobile=width<760,context=await browser.newContext({viewport:{width,height:900},hasTouch:mobile,isMobile:mobile});const page=await context.newPage();const errors=[];let logout=0,unexpected=0;
  page.on('pageerror',e=>errors.push(e.message));
  const user={id:'00000000-0000-4000-8000-000000000001',email:'fictional@example.invalid',email_confirmed_at:'2026-01-01T00:00:00Z',aud:'authenticated',role:'authenticated',is_anonymous:false};
  const jwt=[{alg:'HS256',typ:'JWT'},{sub:user.id,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'},'mock'].map(v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url')).join('.');
  await context.route('**/*',async r=>{const url=new URL(r.request().url());let data;if(url.origin===origin)return r.continue();if(url.origin!==PROJECT_URL){unexpected++;return r.abort();}
   if(url.pathname.endsWith('/token'))data={access_token:jwt,refresh_token:'mock-only',token_type:'bearer',expires_in:3600,user};
   else if(url.pathname.endsWith('/user'))data=user;
   else if(url.pathname.endsWith('/logout')){logout++;return r.fulfill({status:204});}
   else if(url.pathname.endsWith('/rpc/rooted_identity'))data={actor_id:user.id,role:'admin',display_name:'Fictional Leader'};
   else if(url.pathname.endsWith('/rpc/rooted_leader_state')){const kind=r.request().postDataJSON().p_collection;data={rows:kind==='seasons'?[{id:'s1',name:'Fictional season',active:true}]:kind==='events'?['e1','e2'].map((id,i)=>({id,season_id:'s1',name:`Fictional gathering ${i+1}`,date:'2026-09-25',reading_week:'2026-09-21',open:true})):kind==='participants'?[{id:'p1',name:'Fictional Participant',active:true,points:0}]:[]};}
   else{unexpected++;return r.abort();}return r.fulfill({json:data});
  });
  await page.goto(origin+'/leaders.html');await page.getByLabel('Email address').fill(user.email);await page.getByLabel('Password',{exact:true}).fill('fictional-password');await page.getByRole('button',{name:'Sign in →',exact:true}).click();await page.locator('.shell').waitFor();
  for(const [id,label] of tabs){
   if(mobile)await page.getByRole('combobox',{name:'Workspace',exact:true}).selectOption(id);else await page.getByRole('navigation',{name:'Workspace'}).getByRole('button',{name:label,exact:true}).click();
   ok(await page.locator('#view').count()===1,`${width} ${id}: one view`);
   ok(await page.getByRole('heading',{level:1}).count()===1,`${width} ${id}: one accessible heading`);
   ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width} ${id}: no page overflow`);
   if(mobile){ok(await page.getByRole('heading',{level:1}).innerText()===label,`${width} ${id}: current heading`);ok(await page.getByRole('combobox',{name:'Workspace',exact:true}).inputValue()===id,`${width} ${id}: selected state`);ok(await page.evaluate(()=>document.activeElement?.name==='workspace'),`${width} ${id}: retained focus`);}
   else ok(await page.locator('.desktop-workspace [aria-current="page"]').innerText()===label,`${width} ${id}: aria current`);
   const targets=mobile?'.mobile-workspace select,.topbar button,.context select':'.desktop-workspace button,.topbar button';
   const sizes=await page.locator(targets).evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right};}));
   ok(sizes.every(r=>r.width>=44&&r.height>=44&&r.left>=0&&r.right<=width),`${width} ${id}: reachable 44px controls`);
  }
  if(mobile)await page.getByRole('combobox',{name:'Workspace',exact:true}).selectOption('checkin');else await page.getByRole('button',{name:'Check-in',exact:true}).click();
  await page.getByRole('combobox',{name:'Gathering',exact:true}).selectOption('e2');ok(await page.getByRole('combobox',{name:'Gathering',exact:true}).inputValue()==='e2',`${width}: gathering selection works`);
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${output}/${width}.png`});
  if(mobile){await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));await page.screenshot({path:`${output}/${width}-scrolled.png`});}
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Sign in →',exact:true}).waitFor();await page.waitForTimeout(100);
  ok(logout===1,`${width}: signout sent`);ok(await page.locator('.shell').count()===0,`${width}: private workspace cleared`);ok(errors.length===0,`${width}: no JS errors ${errors}`);ok(unexpected===0,`${width}: only expected mocked calls`);await context.close();
 }
 console.log(JSON.stringify({passed:checks,widths:[320,390,430,1280],screenshots:output,fictionalFixturesOnly:true}));
}finally{await browser.close();await server.close();}
