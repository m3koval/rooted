export async function leaderRoute(page,id){
 const primary={checkin:'Tonight',profiles:'People',events:'Events',preferences:'Settings'};
 const nav=page.getByRole('navigation',{name:'Workspace',exact:true});
 if(primary[id])return nav.getByRole('button',{name:primary[id],exact:true}).click();
 const settings=['settings','stations','team','pin','security'].includes(id);
 await nav.getByRole('button',{name:settings?'Settings':'Tonight',exact:true}).click();
 await page.getByRole('button',{name:({settings:'Ministry',stations:'Stations',team:'Team',pin:'My check-in PIN',security:'My passkeys',projector:'Open Projector',community:'Community',draw:'Drawings',history:'History'})[id],exact:true}).click();
}
