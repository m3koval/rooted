// Browser -> real HTTP API handlers -> disposable PostgreSQL RPCs.
// Supabase/PostgREST transport is replaced by a SQL adapter; no hosted writes.
import {chromium,expect} from '@playwright/test';
import {createServer} from 'vite';
import {execFileSync} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHandler as stationHandler} from '../api/station.js';
import {createHandler as kioskHandler} from '../api/kiosk.js';
const db='rooted_weekly_coupled_verify',bin='/tmp/rooted-pg/root/usr/lib/postgresql/16/bin/psql';
const env={...process.env,LD_LIBRARY_PATH:'/tmp/rooted-pg/root/usr/lib/x86_64-linux-gnu'};
const lit=v=>v===null?'null':"'"+String(typeof v==='object'?JSON.stringify(v):v).replaceAll("'","''")+"'";
function sql(q){return execFileSync(bin,['-X','-qAt','-v','ON_ERROR_STOP=1','-h','/tmp/rooted-pg','-p','55439','-U','helper','-d',db,'-c',q],{env,encoding:'utf8'}).trim();}
let clock='2026-10-02T20:00:00Z';
const actor=randomUUID(),season=randomUUID(),prior=randomUUID(),station=randomUUID(),person=randomUUID(),secret=randomBytes(32).toString('hex');
assert.equal(sql('select count(*) from rooted.checkins'),'0');
sql(`create or replace function rooted.gathering_now() returns timestamptz language sql volatile set search_path='' as $$ select current_setting('test.weekly_now')::timestamptz $$; insert into auth.users(id,email) values(${lit(actor)},'coupled@example.invalid'); insert into rooted.leaders(user_id,display_name,role) values(${lit(actor)},'Coupled Fiction','admin'); insert into rooted.checkin_pins(user_id,pin_hash) values(${lit(actor)},extensions.crypt('012345',extensions.gen_salt('bf',4))); insert into rooted.participants(id,name,previously_attended) values(${lit(person)},'Jordan Fiction',true); insert into rooted.seasons(id,name,starts_on,ends_on) values(${lit(season)},'Coupled Fiction','2026-09-25','2026-11-27'); insert into rooted.weekly_schedule(season_id,enabled) values(${lit(season)},true); insert into rooted.events(id,season_id,name,date,reading_week) values(${lit(prior)},${lit(season)},'Prior Gathering','2026-09-25','2026-09-21'); select set_config('test.weekly_now',${lit(clock)},false); select rooted.weekly_maintain(); insert into rooted.stations(id,event_id,label,token_hash,authorized_by,expires_at) values(${lit(station)},${lit(prior)},'Coupled Station',extensions.digest(${lit(secret)},'sha256'),${lit(actor)},'2026-12-01');`);
let rpcCalls=0;
async function upstream(url,options){const name=new URL(url).pathname.split('/').at(-1);assert.ok(['rooted_station_unlock','rooted_station_lock','rooted_kiosk'].includes(name));const args=JSON.parse(options.body);rpcCalls++;try{return new Response(sql(`begin;set local role service_role;select set_config('test.weekly_now',${lit(clock)},true) where false;set local test.weekly_now=${lit(clock)};select public.${name}(${Object.entries(args).map(([k,v])=>`${k}=>${lit(v)}`).join(',')});commit;`),{status:200});}catch{return new Response(JSON.stringify({code:'42501'}),{status:403});}}
const config={env:{SUPABASE_URL:'https://local.invalid',SUPABASE_SERVICE_ROLE_KEY:'local-test-only'},fetchImpl:upstream};
const handlers={'/api/station':stationHandler(config),'/api/kiosk':kioskHandler(config)};
const server=await createServer({server:{host:'localhost',port:0},plugins:[{name:'real-local-api',configureServer(s){s.middlewares.use((req,res,next)=>handlers[req.url]?handlers[req.url](req,res):next());}}]});await server.listen();
const origin=`http://localhost:${server.httpServer.address().port}`,out='/tmp/rooted-weekly-coupled';await mkdir(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,args:['--no-sandbox']});
try{for(const [width,height] of [[390,844],[768,1024],[1024,768]]){
const context=await browser.newContext({viewport:{width,height}}),page=await context.newPage();await context.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());await page.clock.install({time:new Date(clock)});
await page.goto(origin+'/kiosk.html#station='+secret);await page.getByRole('button',{name:'Remember this station'}).click();await page.locator('#pin').fill('012345');await page.locator('#pin').press('Enter');await expect(page.locator('#search-screen')).toBeVisible();await page.locator('#query').fill('Jordan');await page.clock.fastForward(350);await page.locator('.person-option').click();
if(width===390){await expect(page.locator('#bible-step')).toBeVisible();await page.screenshot({path:out+`/bible-${width}.png`});await page.locator('#bible-yes').click();await expect(page.locator('#chapters')).toHaveValue('');await page.locator('[data-chapters="3"]').click();await page.locator('#back').click();await expect(page.locator('#bible-step')).toBeVisible();await page.locator('#bible-yes').click();await expect(page.locator('#chapters')).toHaveValue('3');await page.screenshot({path:out+`/chapters-${width}.png`});await page.locator('#submit-checkin').click();}
await expect(page.locator('#receipt-screen')).toBeVisible();assert.equal(sql('select count(*) from rooted.checkins'),'1');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:out+`/receipt-${width}.png`});await context.close();}
assert.equal(sql(`select event_id<>${lit(prior)} from rooted.stations where id=${lit(station)}`),'t');
clock='2026-10-30T20:00:00Z';const c=await browser.newContext(),p=await c.newPage();await c.addInitScript(secret=>localStorage.setItem('rooted.kiosk.station.v1',secret),secret);await p.clock.install({time:new Date(clock)});await p.goto(origin+'/kiosk.html');await p.locator('#pin').fill('012345');await p.locator('#pin').press('Enter');await expect(p.locator('#status')).toContainText('No gathering is available today');assert.equal(sql('select count(*) from rooted.checkins'),'1');await p.screenshot({path:out+'/last-friday.png'});await c.close();console.log(JSON.stringify({passed:true,rpcCalls,database:db,realHTTPHandlers:true,realPostgres:true,limitation:'SQL adapter replaces hosted PostgREST and Auth transport',screenshots:out}));
}finally{await browser.close();await server.close();}
