// Isolated UI + real SDK/WebAuthn test. ALL backend responses are mocked.
// No real Auth session, person, credential enrollment, or production writes.
import {chromium} from '@playwright/test';
import {createServer} from 'vite';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {PROJECT_URL} from '../src/core.js';
const server=await createServer({server:{host:'localhost',port:0},define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify(PROJECT_URL),'import.meta.env.VITE_SUPABASE_ANON_KEY':JSON.stringify('sb_publishable_mock_only')}});
await server.listen();
const origin=`http://localhost:${server.httpServer.address().port}`;
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
let checks=0;const ok=(condition,label)=>{assert.ok(condition,label);checks++;};
try {
 const context=await browser.newContext();const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
 const user={id:'00000000-0000-4000-8000-000000000001',email:'fictional@example.invalid',email_confirmed_at:'2026-01-01T00:00:00Z',aud:'authenticated',role:'authenticated',is_anonymous:false};
 const token=[{alg:'HS256',typ:'JWT'},{sub:user.id,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'},'mock'].map(v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url')).join('.');
 const session={access_token:token,refresh_token:'mock-only',token_type:'bearer',expires_in:3600,user};
 let rows=[],role='leader',registerCalls=0,signInCalls=0,reads=0;
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());if(u.origin===origin)return route.continue();
  if(u.origin!==PROJECT_URL)return route.abort();
  let data;const p=u.pathname;
  if(p.endsWith('/token'))data=session;
  else if(p.endsWith('/user'))data=user;
  else if(p.endsWith('/logout'))data={};
  else if(p.endsWith('/rpc/rooted_identity'))data={actor_id:user.id,role,display_name:'Fictional Leader'};
  else if(p.includes('/rest/v1/rpc/')){reads++;data={rows:[]};}
  else if(p.endsWith('/passkeys/registration/options'))data={challenge_id:'mock-registration',options:{challenge:randomBytes(32).toString('base64url'),rp:{id:'localhost',name:'Mock Rooted'},user:{id:Buffer.from(user.id).toString('base64url'),name:user.email,displayName:'Fictional Leader'},pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'required',userVerification:'required'},timeout:30000,attestation:'none'}};
  else if(p.endsWith('/passkeys/registration/verify')){registerCalls++;const credential=route.request().postDataJSON().credential;ok(!!credential.response.attestationObject,'real virtual-authenticator attestation serialized by SDK');rows=[{id:'00000000-0000-4000-8000-000000000002',friendly_name:'Mock personal passkey',created_at:'2026-01-01T00:00:00Z'}];data=rows[0];}
  else if(p.endsWith('/passkeys/authentication/options'))data={challenge_id:'mock-authentication',options:{challenge:randomBytes(32).toString('base64url'),rpId:'localhost',userVerification:'required',timeout:30000}};
  else if(p.endsWith('/passkeys/authentication/verify')){signInCalls++;ok(!!route.request().postDataJSON().credential.response.signature,'real virtual-authenticator assertion serialized by SDK');data=session;}
  else if(p.endsWith('/passkeys'))data=rows;
  else if(p.includes('/passkeys/')&&route.request().method()==='DELETE'){rows=[];data={};}
  else throw new Error('Unexpected mocked API request: '+p);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto(origin+'/leaders.html');await page.getByRole('button',{name:'Sign in with passkey',exact:true}).waitFor();
 ok(await page.getByRole('button',{name:'Register passkey',exact:true}).count()===0,'no signed-out enrollment');
 await page.getByLabel('Email address').fill(user.email);await page.getByLabel('Password',{exact:true}).fill('fictional-password');await page.getByRole('button',{name:'Sign in →',exact:true}).click();
 await page.getByRole('button',{name:'My passkeys',exact:true}).click();
 ok(await page.getByText(/Never register a leader passkey on a shared kiosk/).count()===1,'personal-device warning');
 page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'Register passkey',exact:true}).click();await page.getByText('Passkey registered and verified.',{exact:false}).waitFor();ok(registerCalls===1,'registration verify called once');
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Sign in with passkey',exact:true}).click();await page.getByRole('button',{name:'My passkeys',exact:true}).waitFor();ok(signInCalls===1,'discoverable sign-in returned through authority boot');
 await page.getByRole('button',{name:'My passkeys',exact:true}).click();await page.getByRole('button',{name:'Refresh my passkeys'}).click();await page.getByRole('button',{name:'Remove passkey'}).click();await page.getByText('Passkey removed; server list verified.').waitFor();ok(rows.length===0,'deletion readback');
 await page.getByRole('button',{name:'My check-in PIN',exact:true}).click();ok(await page.getByRole('button',{name:'Set my PIN'}).count()===1,'PIN workflow retained');
 await page.getByRole('button',{name:'Sign out',exact:true}).click();role='participant';const before=reads;await page.getByRole('button',{name:'Sign in with passkey',exact:true}).click();await page.getByRole('heading',{name:'Access not verified'}).waitFor();ok(reads===before,'unassigned passkey authentication cannot read private collections');ok(await page.getByRole('button',{name:'Register passkey',exact:true}).count()===0,'unassigned cannot enroll');
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.evaluate(()=>{navigator.credentials.get=async()=>{throw new DOMException('Cancelled','NotAllowedError');};});await page.getByRole('button',{name:'Sign in with passkey',exact:true}).click();await page.getByText(/cancelled or timed out/).waitFor();ok(await page.getByRole('button',{name:'Sign in →',exact:true}).isEnabled(),'cancellation restores password fallback');
 await page.addInitScript(()=>Object.defineProperty(window,'PublicKeyCredential',{value:undefined,configurable:true}));await page.reload();ok(await page.getByRole('button',{name:'Sign in with passkey',exact:true}).isDisabled(),'unsupported browser safely disabled');ok(await page.getByRole('button',{name:'Sign in →',exact:true}).isEnabled(),'unsupported browser retains password');
 ok(errors.length===0,errors.join(';'));console.log(JSON.stringify({passed:checks,evidence:'MOCKED backend + real Chromium virtual WebAuthn + real Supabase SDK; no production requests'}));
} finally {await browser.close();await server.close();}
