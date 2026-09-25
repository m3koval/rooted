'use strict';
window.RootedTheme=(()=>{
 const artwork={tree:'/real-tree.webp',badge:'/real-badge.webp',wide:'/real-wide.webp'};
 let current=null;
 function apply(theme){
  current=theme;document.body.classList.toggle('theme-active',theme.enabled);
  document.querySelectorAll('[data-theme-surface]').forEach(el=>el.hidden=!theme.enabled);
  document.querySelectorAll('[data-theme-field]').forEach(el=>{const key=el.dataset.themeField;el.textContent=theme[key]||'';if(key==='scripture')el.hidden=!theme.scripture;});
  document.querySelectorAll('[data-theme-art]').forEach(el=>{el.src=artwork[theme.artwork];el.alt=theme.name+' — supplied seasonal artwork';el.dataset.artwork=theme.artwork;});
  document.querySelectorAll('[data-theme-art-frame]').forEach(el=>el.dataset.artwork=theme.artwork);
  const form=document.querySelector('#theme-form');
  if(form){for(const key of ['name','study','tagline','scripture','artwork'])form.elements.namedItem(key).value=theme[key];form.elements.namedItem('enabled').checked=theme.enabled;document.querySelector('#theme-preview').src=artwork[theme.artwork];}
 }
 async function request(method='GET',body){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
  try{const response=await fetch('/api/theme',{method,signal:controller.signal,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Theme could not be loaded.');return data;}finally{clearTimeout(timeout);}
 }
 async function refresh(){const data=await request();apply(data);return data;}
 const status=document.querySelector('#theme-status'),form=document.querySelector('#theme-form');
 if(form)form.elements.namedItem('artwork').onchange=()=>{document.querySelector('#theme-preview').src=artwork[form.elements.namedItem('artwork').value];};
 if(form)form.onsubmit=async event=>{
  event.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;status.textContent='Saving theme…';
  const payload=Object.fromEntries(['name','study','tagline','scripture','artwork'].map(key=>[key,form.elements.namedItem(key).value]));payload.enabled=form.elements.namedItem('enabled').checked;
  try{await request('POST',payload);await refresh();status.textContent='Theme saved. Points, check-ins and drawing history are unchanged.';}
  catch(error){status.textContent='Theme save could not be confirmed. '+error.message+' Retry the same settings.';}
  finally{button.disabled=false;}
 };
 const ready=refresh().catch(()=>{if(status)status.textContent='Theme unavailable. Refresh the page to try again. Check-in and points are independent.';return null;});
 return {ready,refresh,get current(){return current;}};
})();
