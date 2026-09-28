// Real local PostgreSQL + rendered client integration; no hosted requests.
// Run only against the disposable rooted_checkin_browser_verify database.
import {chromium,expect} from '@playwright/test';
import {createServer} from 'vite';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {PROJECT_URL} from '../src/core.js';
const bin='/tmp/rooted-pg/root/usr/lib/postgresql/16/bin/psql';
const env={...process.env,LD_LIBRARY_PATH:'/tmp/rooted-pg/root/usr/lib/x86_64-linux-gnu'};
const db=process.env.ROOTED_LOCAL_QA_DB||'rooted_checkin_browser_verify';
if(!/^rooted_checkin_browser_verify[0-9]*$/.test(db))throw Error('Only disposable browser-verification databases allowed');
const literal=v=>v===null?'null':"'"+String(v).replaceAll("'","''")+"'";
function sql(query){return execFileSync(bin,['-X','-qAt','-v','ON_ERROR_STOP=1','-h','/tmp/rooted-pg','-p','55439','-U','helper','-d',db,'-c',query],{env,encoding:'utf8'}).trim();}
const actor=randomUUID(),p1=randomUUID(),p2=randomUUID(),season=randomUUID(),event=randomUUID();
if(sql('select count(*) from rooted.checkins')!=='0')throw Error('Disposable database must have no checkins before test');
sql(`insert into auth.users(id,email) values(${literal(actor)},'browser-fixture@example.invalid');insert into rooted.leaders(user_id,display_name,role) values(${literal(actor)},'Browser Fixture','leader');insert into rooted.participants(id,name,previously_attended) values(${literal(p1)},'Jordan Fiction',true),(${literal(p2)},'Sam Fiction',true);insert into rooted.seasons(id,name,starts_on,ends_on) values(${literal(season)},'Browser Fixture','2026-01-01','2026-12-31');insert into rooted.events(id,season_id,name,date,reading_week) values(${literal(event)},${literal(season)},'Browser Gathering','2026-09-28','2026-09-28');`);
function rpc(name,args){if(!/^rooted_[a-z_]+$/.test(name)||Object.keys(args).some(k=>!/^p_[a-z_]+$/.test(k)))throw Error('RPC allowlist');return JSON.parse(sql(`begin;set local role authenticated;set local request.jwt.claim.sub=${literal(actor)};select public.${name}(${Object.entries(args).map(([k,v])=>`${k} => ${literal(typeof v==='object'&&v!==null?JSON.stringify(v):v)}`).join(',')});commit;`));}
rpc('rooted_leader_mutate',{p_request_id:randomUUID(),p_action:'checkin',p_payload:{participant_id:p1,event_id:event,attended:true,bible:true,chapters:3}});
const server=await createServer({server:{host:'localhost',port:0},define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify(PROJECT_URL),'import.meta.env.VITE_SUPABASE_ANON_KEY':JSON.stringify('sb_publishable_mock_only')}});await server.listen();
const origin=`http://localhost:${server.httpServer.address().port}`,out='/tmp/rooted-fixes/checkin-postgres';await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
let checks=0;const check=async fn=>{await fn();checks++;};
try{
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();const errors=[],calls=[];page.on('pageerror',e=>errors.push(e.message));
 const user={id:actor,email:'browser-fixture@example.invalid',aud:'authenticated',role:'authenticated'};
 const jwt=[{alg:'HS256',typ:'JWT'},{sub:actor,exp:1999999999,role:'authenticated'},'mock'].map(x=>Buffer.from(typeof x==='string'?x:JSON.stringify(x)).toString('base64url')).join('.');
 await context.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin===origin)return route.continue();if(u.origin!==PROJECT_URL)throw Error('Unexpected external request');
  if(u.pathname.endsWith('/token'))return route.fulfill({json:{access_token:jwt,refresh_token:'fixture',expires_in:3600,token_type:'bearer',user}});
  if(u.pathname.endsWith('/user'))return route.fulfill({json:user});
  const name=u.pathname.split('/rpc/')[1];if(!name)throw Error('Unexpected path '+u.pathname);
  const args=route.request().postDataJSON()||{};calls.push({name,args});
  try{return route.fulfill({json:rpc(name,args)});}catch(e){errors.push('SQL RPC failed '+name+': '+e.message);return route.fulfill({status:400,json:{code:'22023'}});}
 });
 await page.goto(`${origin}/leaders.html?gathering=${event}&season=${season}`);
 await page.getByLabel('Email address').fill(user.email);await page.getByLabel('Password',{exact:true}).fill('fictional');await page.getByRole('button',{name:'Sign in →',exact:true}).click();await page.locator('.shell').waitFor();
 await page.getByRole('button',{name:'Edit check-in',exact:true}).click();const dialog=page.getByRole('dialog');
 await check(()=>expect(dialog).toBeVisible());
 await dialog.locator('input[name=chapters]').fill('6');await dialog.locator('input[name=bible]').uncheck();
 await dialog.locator('button[type=submit]').click();await expect(page.getByText('✓ Check-in updated',{exact:true})).toBeVisible();
 let rows=rpc('rooted_leader_state',{p_collection:'checkins'}).rows;
 if(rows.length!==1||rows[0].chapters!==6||rows[0].bible!==false)throw Error('Actual DB edit readback failed');checks++;
 await page.getByRole('button',{name:'Edit check-in',exact:true}).click();
 await page.getByRole('dialog').locator('select[name=participant_id]').selectOption(p2);
 // Frontend may use a confirm dialog or an explicit inline confirmation checkbox.
 page.on('dialog',d=>d.accept());
 const confirmation=page.getByRole('dialog').locator('input[name=confirm_person]');if(await confirmation.count())await confirmation.check();
 await page.getByRole('dialog').locator('button[type=submit]').click();
 await expect(page.getByRole('dialog')).toHaveCount(0);await expect.poll(()=>rpc('rooted_leader_state',{p_collection:'checkins'}).rows[0].participant_id).toBe(p2);
 rows=rpc('rooted_leader_state',{p_collection:'checkins'}).rows;if(rows[0].participant_id!==p2)throw Error('Actual reassignment failed');checks++;
 await check(()=>expect(page.locator('.person-row').filter({hasText:'Jordan Fiction'}).getByRole('button',{name:'Check in',exact:true})).toBeVisible());
 await check(()=>expect(page.locator('.person-row').filter({hasText:'Sam Fiction'}).getByRole('button',{name:'Edit check-in',exact:true})).toBeVisible());
 const points=rpc('rooted_leader_state',{p_collection:'participants'}).rows;
 if(Number(points.find(p=>p.id===p1).points)!==0)throw Error('Mistaken participant retained points');checks++;
 const original=JSON.parse(sql(`select row_to_json(c) from rooted.checkins c limit 1`));if(original.participant_id!==p1||original.chapters!==3||!original.bible)throw Error('Original overwritten');checks++;
 await page.screenshot({path:out+'/actual-database-transfer.png'});
 await page.getByRole('button',{name:'Edit check-in',exact:true}).click();
 await page.getByRole('dialog').locator('input[name=attended]').uncheck();
 await check(()=>expect(page.getByLabel('Chapters read this week')).toHaveValue('0'));
 await check(()=>expect(page.getByLabel('Chapters read this week')).toBeDisabled());
 await page.screenshot({path:out+'/absent-zero-credit.png'});
 await page.getByRole('dialog').locator('button[type=submit]').click();
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect.poll(()=>rpc('rooted_leader_state',{p_collection:'checkins'}).rows[0].attended).toBe(false);checks++;
 const absent=rpc('rooted_leader_state',{p_collection:'checkins'}).rows.find(c=>c.participant_id===p2);
 if(absent.chapters!==0||absent.bible!==false)throw Error('Absent Bible/chapters persisted');checks++;
 if(Number(rpc('rooted_leader_state',{p_collection:'participants'}).rows.find(p=>p.id===p2).points)!==0)throw Error('Absent participant retained check-in points');checks++;
 await page.locator('.person-row').filter({hasText:'Jordan Fiction'}).getByRole('button',{name:'Check in',exact:true}).click();
 await page.getByLabel('Present at this gathering').uncheck();
 await check(()=>expect(page.getByLabel('Cumulative chapters read this week')).toBeDisabled());
 await check(()=>expect(page.getByLabel('Cumulative chapters read this week')).toHaveValue('0'));
 await page.getByLabel('Present at this gathering').check();
 await page.getByRole('dialog').locator('input[name=chapters]').fill('2');
 await page.getByRole('dialog').locator('button[type=submit]').click();
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect.poll(()=>rpc('rooted_leader_state',{p_collection:'checkins'}).rows.length).toBe(2);checks++;
 const latest=rpc('rooted_leader_state',{p_collection:'checkins'}).rows;
 if(!latest.find(c=>c.participant_id===p1)?.attended||latest.find(c=>c.participant_id===p2)?.attended)throw Error('Actual attendance/recheckin invalid');checks++;
 if(errors.length)throw Error(errors.join('\n'));
 console.log(JSON.stringify({passed:checks,realPostgres:true,db,rpcCalls:calls.length,screenshot:out+'/actual-database-transfer.png'}));
}finally{await browser.close();await server.close();}
