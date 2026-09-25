import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import {PNG} from 'pngjs';
import {stationEnrollmentURL, parseStationEnrollmentQR, consumeStationEnrollmentFragment, mountStationEnrollmentQR} from '../src/station-enrollment.js';
const token='a1'.repeat(32), url=`https://www.rooted3d.com/checkin#station=${token}`;
test('canonical URL roundtrips through a real QR encoder and decoder',async()=>{
 assert.equal(stationEnrollmentURL(token),url);
 const image=PNG.sync.read(await QRCode.toBuffer(url,{errorCorrectionLevel:'M',margin:4,scale:6}));
 assert.equal(jsQR(new Uint8ClampedArray(image.data),image.width,image.height).data,url);
 assert.equal(parseStationEnrollmentQR(url),token);
});
test('strict QR parser fails closed',()=>{
 for(const v of [null,{},token,url+'\n',url+' ',url+'&x=1',url+'&station='+token,url.replace('https:','http:'),url.replace('www.',''),url.replace('/checkin','/checkin/'),url.replace('#','?'),url.replace('#','?x=1#'),url.replace(token,token.toUpperCase()),url.replace(token,token.slice(1)),url.replace('station=','station=%61'),url.replace('www.rooted3d.com','www.rooted3d.com.evil.test')]) assert.equal(parseStationEnrollmentQR(v),null);
 assert.throws(()=>stationEnrollmentURL(token+'\n'));
});
test('fragment scrub is synchronous and precedes token consumption',()=>{
 const events=[];const location={hash:'#station='+token,pathname:'/checkin',search:''};
 const result=consumeStationEnrollmentFragment(location,{replaceState(state,title,path){events.push(path);location.hash='';}});
 assert.deepEqual(events,['/checkin']);assert.equal(location.hash,'');assert.deepEqual(result,{token,invalid:false});
 for(const hash of ['#station='+token+'&x=1','#other=secret','#station='+token.toUpperCase()]){let scrubbed=false;assert.deepEqual(consumeStationEnrollmentFragment({...location,hash},{replaceState(){scrubbed=true;}}),{token:null,invalid:true});assert.equal(scrubbed,true);}
 assert.deepEqual(consumeStationEnrollmentFragment({...location,hash:'#station='+token},{replaceState(){throw Error();}}),{token:null,invalid:true});
 assert.deepEqual(consumeStationEnrollmentFragment(location,{}),{token:null,invalid:false});
});
function fixture(){return {canvas:{width:320,height:320,hidden:false,getContext:()=>({clearRect(){}})},status:{textContent:''}};}
test('QR generation never reads a secret after disposal during async loading',async()=>{
 let resolve,reads=0,draws=0;const {canvas,status}=fixture();
 const dispose=mountStationEnrollmentQR({canvas,status,getToken:()=>{reads++;return token;},isCurrent:()=>true,loadQR:()=>new Promise(r=>resolve=r)});
 dispose();resolve({default:{toCanvas(){draws++;}}});await new Promise(r=>setImmediate(r));
 assert.equal(reads,0);assert.equal(draws,0);assert.equal(canvas.width,0);assert.equal(canvas.height,0);assert.equal(status.textContent,'');
});
test('QR generation fences actor/epoch changes and handles generic errors',async()=>{
 let current=true,resolve,reads=0;let {canvas,status}=fixture();
 mountStationEnrollmentQR({canvas,status,getToken:()=>{reads++;return token;},isCurrent:()=>current,loadQR:()=>new Promise(r=>resolve=r)});
 current=false;resolve({});await new Promise(r=>setImmediate(r));assert.equal(reads,0);
 ({canvas,status}=fixture());mountStationEnrollmentQR({canvas,status,getToken:()=>token,isCurrent:()=>true,loadQR:async()=>{throw Error('sensitive');}});
 await new Promise(r=>setImmediate(r));assert.equal(status.textContent.includes('sensitive'),false);assert.match(status.textContent,/manually/);
});
test('local canvas receives exact canonical URL and is wiped on disposal',async()=>{
 const {canvas,status}=fixture();let received;
 const dispose=mountStationEnrollmentQR({canvas,status,getToken:()=>token,isCurrent:()=>true,loadQR:async()=>({default:{toCanvas(c,value,options,callback){received=value;callback(null);}}})});
 await new Promise(r=>setImmediate(r));assert.equal(received,url);assert.match(status.textContent,/Ready/);dispose();assert.equal(canvas.width,0);assert.equal(status.textContent,'');
});
