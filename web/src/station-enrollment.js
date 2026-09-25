// Enrollment secrets stay in memory and canvas only. No network QR services.
const PREFIX='https://www.rooted3d.com/checkin#station=';
const validToken=value=>typeof value==='string'&&value.length===64&&/^[a-f0-9]{64}$/.test(value);
export function stationEnrollmentURL(token){
 if(!validToken(token))throw new Error('Invalid station enrollment code');
 return PREFIX+token;
}
export function parseStationEnrollmentQR(value){
 if(typeof value!=='string'||!value.startsWith(PREFIX))return null;
 const token=value.slice(PREFIX.length);return validToken(token)?token:null;
}
export function consumeStationEnrollmentFragment(location=window.location,history=window.history){
 let fragment=location.hash;
 if(!fragment)return {token:null,invalid:false};
 // Scrub ALL fragments, even malformed ones, before interpretation or async work.
 try{history.replaceState(null,'',location.pathname+location.search);}catch{fragment='';return {token:null,invalid:true};}
 const token=fragment.startsWith('#station=')?fragment.slice(9):null;fragment='';
 return validToken(token)?{token,invalid:false}:{token:null,invalid:true};
}
export function mountStationEnrollmentQR({canvas,status,getToken,isCurrent,loadQR=()=>import('qrcode')}){
 let disposed=false;
 const active=()=>!disposed&&isCurrent();
 const wipe=()=>{canvas.getContext('2d')?.clearRect(0,0,canvas.width,canvas.height);canvas.width=0;canvas.height=0;canvas.hidden=true;};
 status.textContent='Preparing a private QR code on this device…';canvas.hidden=true;
 // Do not capture the secret across this await. Read it only after the fences.
 (async()=>{
  try{
   const module=await loadQR();if(!active())return;
   let value=stationEnrollmentURL(getToken());
   // qrcode's browser canvas callback renderer is synchronous; no image/object URL.
   (module.default||module).toCanvas(canvas,value,{errorCorrectionLevel:'M',margin:4,width:320},error=>{
    if(!active()){wipe();return;}
    if(error){wipe();status.textContent='QR unavailable. Enter the enrollment code manually on the station.';return;}
    canvas.hidden=false;status.textContent='Ready to scan with the check-in device camera.';
   });value='';
  }catch{if(active()){wipe();status.textContent='QR unavailable. Enter the enrollment code manually on the station.';}}
 })();
 return ()=>{disposed=true;wipe();status.textContent='';getToken=null;isCurrent=null;};
}
