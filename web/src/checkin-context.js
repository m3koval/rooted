// Browser guidance only. Protected database functions remain authoritative.
export function tonightEvent(events,seasons,today){
 const eligible=events.filter(e=>e.open&&e.date===today&&seasons.some(s=>s.id===e.season_id&&s.active));
 return eligible.length===1?eligible[0]:null;
}
export function checkinBlock(e,seasons,today){
 if(!e)return 'Choose a gathering. There is no selected gathering for this check-in.';
 if(!seasons.some(s=>s.id===e.season_id&&s.active))return 'This season is inactive. Ordinary check-in is unavailable; choose an active season in Events. Historical missing entries use Record missed attendance.';
 if(e.date<today)return 'This is a past gathering. Ordinary check-in is closed. Use Record missed attendance for a missing entry, or Edit check-in for a saved entry.';
 if(e.date>today)return 'This is a future gathering. Check-in opens on its date, Eastern time. Choose today’s gathering or review Events.';
 if(!e.open)return 'This gathering is closed. Ask an administrator to review it in Events; saved entries can still be edited.';
 return '';
}
export function checkinTitle(e,today){return !e?'Attendance':e.date<today?'Past attendance':e.date>today?'Upcoming gathering':'Tonight';}
