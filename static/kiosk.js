'use strict';
const $=s=>document.querySelector(s);
const pendingKey='rooted-kiosk-pending-v1';
const eventToken=new URL(location.href).searchParams.get('event');
const eventId=/^[1-9]\d*$/.test(eventToken||'')?Number(eventToken):null;
let context=null,person=null,answerBible=null,answerChapters=null,screen='loading',epoch=0,searchVersion=0,searchTimer=null;
let pending=null,returnToReview=false,lastActivity=Date.now(),successAt=0,retryKind='boot',saving=false;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let storageReady=true;
try{const raw=sessionStorage.getItem(pendingKey),p=JSON.parse(raw||'null');if(p&&typeof p==='object')pending=p;sessionStorage.setItem('rooted-storage-test','1');sessionStorage.removeItem('rooted-storage-test');}catch{storageReady=false;}
function remember(payload){const draft=Object.freeze({...payload});sessionStorage.setItem(pendingKey,JSON.stringify(draft));pending=draft;}
function forget(){sessionStorage.removeItem(pendingKey);pending=null;}
async function api(action,data){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
 try{const r=await fetch('/api/kiosk/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:controller.signal});const body=await r.json();if(!r.ok){const e=new Error(body.error||'Request unavailable');e.status=r.status;throw e;}return body;}finally{clearTimeout(timer);}
}
function show(next){
 screen=next;document.body.dataset.step=next;lastActivity=Date.now();$('#idle-warning').hidden=true;
 document.querySelectorAll('.screen').forEach(el=>el.hidden=el.id!=='screen-'+next);
 const steps={search:1,confirm:1,bible:2,reading:3,review:4};const step=steps[next];
 $('#progress').hidden=!step;$('#flow-nav').hidden=!['confirm','bible','reading','review'].includes(next);
 if(step){$('#step-label').textContent='STEP '+step+' OF 4';$('#step-name').textContent=['Your name','Your Bible','Your reading','Finish'][step-1];document.querySelectorAll('.progress-bars i').forEach((el,i)=>el.classList.toggle('active',i<step));}
 const heading=$('#screen-'+next+' h1');if(heading)heading.focus({preventScroll:true});window.scrollTo(0,0);
}
function error(title,copy,kind='boot',canReset=true){
 retryKind=kind;$('#error-title').textContent=title;$('#error-copy').textContent=copy;$('#retry').hidden=kind==='none';$('#error-reset').hidden=!canReset||!!pending;show('error');
}
function clearDraft(){epoch++;searchVersion++;clearTimeout(searchTimer);person=null;answerBible=null;answerChapters=null;returnToReview=false;$('#name-search').value='';$('#matches').replaceChildren();$('#search-hint').textContent='Start with at least 2 letters.';$('#chapters').value='';$('#reading-error').hidden=true;$('#review-name').textContent='';$('#selected-name').textContent='';$('#success-title').textContent="You're checked in.";$('#receipt-components').replaceChildren();$('#earned-points').textContent='';for(const id of ['review-first','review-bible','review-chapters','preview-points','initials','success-copy'])$('#'+id).textContent='';}
function reset(){if(pending){error('This check-in needs help.','The last save has not been confirmed. Ask a leader, or retry the same save.','save',false);return;}clearDraft();if(context)show('search');else boot();}
function firstName(){return person?.person.name.trim().split(/\s+/)[0]||'friend';}
function dateLabel(iso){return new Date(iso+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'});}
function weeklyLabel(iso){const end=new Date(iso+'T12:00:00Z');end.setUTCDate(end.getUTCDate()+6);return dateLabel(iso)+' – '+end.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});}
async function boot(){
 show('loading');const generation=++epoch;
 if(!storageReady){error('This browser needs a quick fix.','A leader needs to enable browser storage or use another browser. No new check-in has been sent.','none',false);return;}
 if(!eventId||!Number.isSafeInteger(eventId)){error("Check-in isn't open yet.",'A leader needs to choose the gathering and open its check-in link on this tablet.','none',false);return;}
 if(pending&&pending.event_id!==eventId){error('A previous save needs help.','Ask a leader to reopen the original gathering before using this tablet.','none',false);return;}
 try{
  const result=await api('context',{event_id:eventId});if(generation!==epoch)return;context=result;
  $('#gathering').textContent=context.event.name;$('#week-label').textContent=weeklyLabel(context.event.reading_week);
  if(pending){
   person=await api('person',{event_id:eventId,participant_id:pending.participant_id});if(generation!==epoch)return;
   if(person.already_checked_in){const receipt=person.receipt;forget();success(receipt,true);return;}
   error('Your last check-in needs a retry.',"Tap Try again to send the same answers. It won't add points twice.",'save',false);return;
  }
  clearDraft();show('search');
 }catch(e){if(generation!==epoch)return;error('Check-in is unavailable.',e.status&&e.status<500?'This local pilot only accepts fictional practice records. Ask a leader to open a practice gathering.':'We could not reach the local check-in server. Ask a leader to check the connection, then try again.','boot',false);}
}
async function searchNames(){
 const query=$('#name-search').value.trim(),version=++searchVersion,generation=epoch;
 $('#matches').replaceChildren();
 if(query.length<2){$('#search-hint').textContent='Start with at least 2 letters.';return;}
 $('#search-hint').textContent='Looking for your name…';
 try{const data=await api('search',{event_id:eventId,query});if(version!==searchVersion||generation!==epoch||screen!=='search')return;
  $('#search-hint').textContent=data.truncated?'Keep typing to narrow it down.':data.matches.length?'Tap your name below.':'No match yet. Try your last name, or tap the help option below.';
  if(data.truncated)return;
  $('#matches').innerHTML=data.matches.map(p=>`<button class="person-option" data-person="${p.id}"><span>${esc(p.name)}</span><small aria-hidden="true">→</small></button>`).join('');
  $('#matches').querySelectorAll('button').forEach(b=>b.onclick=()=>{
   const chosen=data.matches.find(p=>p.id===Number(b.dataset.person));
   if(data.matches.filter(p=>p.name.trim().replace(/\s+/g,' ').toLocaleLowerCase()===chosen.name.trim().replace(/\s+/g,' ').toLocaleLowerCase()).length>1){help('Two people have this name.','A leader can help choose the right record. No check-in has been saved.');return;}
   selectPerson(chosen.id);
  });
 }catch(e){if(version===searchVersion&&generation===epoch&&screen==='search')error("We couldn't find your name yet.",'The search connection was interrupted. Try again—your check-in has not started.','search');}
}
async function selectPerson(id){
 const generation=++epoch;searchVersion++;show('loading');
 try{const result=await api('person',{event_id:eventId,participant_id:id});if(generation!==epoch)return;person=result;
  $('#selected-name').textContent=person.person.name;$('#initials').textContent=person.person.name.trim().split(/\s+/).slice(0,2).map(p=>p[0]).join('').toUpperCase();show('confirm');
 }catch(e){if(generation===epoch)error("We couldn't open that name.",'Try again, or ask a leader for help. No check-in has been saved.','search');}
}
function confirmPerson(){
 if(person.already_checked_in){success(person.receipt,true);return;}
 if(person.needs_leader){help('A quick first-visit check.','Ask a leader to confirm your visit and who invited you. This protects your friend’s bonus. No check-in has been saved here.');return;}
 show('bible');
}
function openReading(){
 $('#chapters').min=String(person.prior_chapters||0);
 $('#chapters').value=answerChapters!==null?String(answerChapters):person.prior_chapters?String(person.prior_chapters):'';
 $('#prior-note').textContent=person.prior_chapters?`You already recorded ${person.prior_chapters} for this week. Enter your total, not extra chapters.`:'0 is okay. Every chapter is worth 1 point.';
 $('#zero-chapters').hidden=!!person.prior_chapters;$('#reading-error').hidden=true;validateReading();show('reading');
}
function validateReading(){const raw=$('#chapters').value;const v=Number(raw);const valid=/^\d{1,6}$/.test(raw)&&Number.isSafeInteger(v)&&v>=Number(person?.prior_chapters||0)&&v<=100000;$('#reading-next').disabled=!valid;return valid;}
function review(){
 $('#review-first').textContent=firstName();$('#review-name').textContent=person.person.name;$('#review-bible').textContent=answerBible?'Yes':'No';$('#review-chapters').textContent=String(answerChapters);
 $('#preview-points').textContent='+'+(context.rates.attendance+(answerBible?context.rates.bible:0)+Math.max(0,answerChapters-person.prior_chapters));show('review');
}
async function save(){
 if(saving)return;
 if(!pending){if(!person||answerBible===null||answerChapters===null)return;try{remember({event_id:eventId,participant_id:person.person.id,bible:answerBible,chapters:answerChapters});}catch{error('This browser needs help.','Your check-in has not been sent. Ask a leader to check browser storage.','none',true);return;}}
 const frozen=pending;const generation=epoch;saving=true;$('#help').disabled=true;show('saving');
 try{const result=await api('checkin',frozen);if(generation!==epoch||pending!==frozen)return;forget();success(result.receipt,result.duplicate);}
 catch(e){
  if(generation!==epoch||pending!==frozen)return;
  if(e.status&&e.status<500){forget();error('A leader needs to check this.',e.status===409?'There is already a saved record with different answers. Ask a leader before trying again.':'This check-in could not be accepted. Ask a leader for help.','none',true);}
  else error("We couldn't confirm your check-in.","Your answers are kept. Tap Try again to send the same check-in—it won't add points twice.",'save',false);
 }finally{saving=false;$('#help').disabled=false;}
}
function success(receipt,already){
 $('#success-label').textContent=already?'ALREADY CHECKED IN':'CHECK-IN SAVED';
 $('#success-title').textContent=already?"You're already checked in.":"You're checked in, "+firstName()+'!';
 $('#success-copy').textContent=already?'No need to check in again. Ask a leader if an answer needs changing.':"You're all set. Enjoy tonight.";
 $('#earned-points').textContent=(already?'':'+')+receipt.earned_points;$('#earned-caption').textContent=already?'points already recorded':'points earned';
 $('#receipt-components').replaceChildren(...receipt.components.map(c=>{const el=document.createElement('span');el.textContent=c.label+' '+c.points;return el;}));
 successAt=Date.now();show('success');$('#reset-countdown').textContent='Ready for the next person in 15 seconds.';$('#announcer').textContent=already?'Already checked in. No duplicate points.':'Check-in saved.';
}
function help(title='Ask a leader for a hand.',copy='They can help find your name or set up your first visit. Then you can check yourself in.'){
 if(pending){error('This check-in needs help.','The last save has not been confirmed. Ask a leader, or retry the same save.','save',false);return;}
 epoch++;searchVersion++;clearTimeout(searchTimer);$('#help-title').textContent=title;$('#help-copy').textContent=copy;show('help');
}
$('#name-search').addEventListener('input',()=>{searchVersion++;clearTimeout(searchTimer);$('#matches').replaceChildren();const short=$('#name-search').value.trim().length<2;$('#search-hint').textContent=short?'Start with at least 2 letters.':'Looking for your name…';searchTimer=setTimeout(searchNames,180);});
$('#confirm-person').onclick=confirmPerson;$('#different-person').onclick=reset;
document.querySelectorAll('[data-bible]').forEach(b=>b.onclick=()=>{answerBible=b.dataset.bible==='true';if(returnToReview&&answerChapters!==null){returnToReview=false;review();}else openReading();});
$('#chapters').oninput=()=>{$('#reading-error').hidden=true;validateReading();};
$('#reading-form').onsubmit=e=>{e.preventDefault();if(!validateReading()){$('#reading-error').textContent='Enter a whole number of chapters for the displayed week.';$('#reading-error').hidden=false;return;}answerChapters=Number($('#chapters').value);returnToReview=false;review();};
$('#zero-chapters').onclick=()=>{answerChapters=0;review();};
$('#edit-bible').onclick=()=>{returnToReview=true;show('bible');};$('#edit-reading').onclick=openReading;
$('#save').onclick=save;$('#done').onclick=reset;$('#start-over').onclick=reset;$('#error-reset').onclick=reset;$('#help-done').onclick=reset;
$('#back').onclick=()=>{if(screen==='confirm')reset();else if(screen==='bible')show('confirm');else if(screen==='reading')show('bible');else if(screen==='review')openReading();};
$('#help').onclick=()=>help();$('#new-person').onclick=()=>help('First time? Welcome.','Ask a leader to add your name and confirm who invited you. You only need this setup once.');
$('#retry').onclick=()=>{if(retryKind==='save')save();else if(retryKind==='search'){show('search');searchNames();}else boot();};
$('#keep-going').onclick=()=>{lastActivity=Date.now();$('#idle-warning').hidden=true;};
for(const type of ['pointerdown','keydown','input'])document.addEventListener(type,()=>{lastActivity=Date.now();$('#idle-warning').hidden=true;},{passive:true});
setInterval(()=>{
 if(screen==='success'){const seconds=Math.max(0,15-Math.floor((Date.now()-successAt)/1000));$('#reset-countdown').textContent='Ready for the next person in '+seconds+' seconds.';if(!seconds)reset();return;}
 if(pending||['loading','saving','error'].includes(screen))return;
 const hasDraft=screen!=='search'||!!$('#name-search').value;if(!hasDraft)return;
 const idle=Date.now()-lastActivity;
 if(idle>=90000){reset();return;}
 if(idle>=70000){$('#idle-message').textContent='For your privacy, starting over in '+Math.ceil((90000-idle)/1000)+' seconds.';$('#idle-warning').hidden=false;}
},1000);
boot();
