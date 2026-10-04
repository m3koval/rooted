import test from 'node:test';
import assert from 'node:assert/strict';
import {tonightEvent,checkinBlock,checkinTitle} from '../src/checkin-context.js';
const today='2026-10-02', seasons=[{id:'s',active:true},{id:'old',active:false}];
const e={id:'now',season_id:'s',date:today,open:true};
test('tonight is unique across active seasons, not latest open',()=>{
 assert.equal(tonightEvent([e,{...e,id:'past',date:'2026-09-25'}],seasons,today)?.id,'now');
 assert.equal(tonightEvent([e,{...e,id:'other'}],seasons,today),null);
 assert.equal(tonightEvent([{...e,season_id:'old'}],seasons,today),null);
 assert.equal(tonightEvent([{...e,open:false}],seasons,today),null);
});
test('each disabled state explains its distinct reason',()=>{
 assert.match(checkinBlock(null,seasons,today),/Choose/);
 assert.match(checkinBlock({...e,season_id:'old'},seasons,today),/inactive/);
 assert.match(checkinBlock({...e,date:'2026-09-25'},seasons,today),/past/);
 assert.match(checkinBlock({...e,date:'2026-10-09'},seasons,today),/future/);
 assert.match(checkinBlock({...e,open:false},seasons,today),/closed/);
 assert.equal(checkinBlock(e,seasons,today),'');
});
test('historical and future selections are never labeled Tonight',()=>{
 assert.equal(checkinTitle(e,today),'Tonight');
 assert.equal(checkinTitle({...e,date:'2026-09-25'},today),'Past attendance');
 assert.equal(checkinTitle({...e,date:'2026-10-09'},today),'Upcoming gathering');
 assert.equal(checkinTitle(null,today),'Attendance');
});
