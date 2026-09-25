export const PROJECT_URL = 'https://sfrkowqljeaztupywtzy.supabase.co';
export function validConfig(url, key) {
  if (url !== PROJECT_URL || !key || key.startsWith('sb_secret_')) return false;
  if (key.startsWith('sb_publishable_')) return true;
  try { return JSON.parse(atob(key.split('.')[1])).role === 'anon'; } catch { return false; }
}
export function authorized(identity, userId) {
  return identity && identity.actor_id === userId && ['admin','leader'].includes(identity.role);
}
export function definitive(error) {
  // Only a database rejection proves that a transaction was not committed.
  return /^(22...|23...|42501|55000|40001|40P01)$/.test(error?.code || '');
}
export function safeError(error) {
  const c = error?.code;
  if (c === '42501') return 'Your leader access could not be verified. Sign in again or contact an administrator.';
  if (c === '23505') return 'This record conflicts with an existing entry. Refresh and review its history; do not submit a changed check-in.';
  if (c === '22023' || c?.startsWith('22') || c?.startsWith('23')) return 'The server rejected this request. Check dates, event status, required fields, and eligibility, then try again.';
  return 'The server could not confirm this request. Its result may already be saved. Retry the saved request, not a new one.';
}
export function receiptValid(data, command) {
  return !!data && data.request_id === command.id && data.action === command.action && data.result && typeof data.result === 'object';
}
export function newCommand(actor, action, payload) {
  return { actor, id: crypto.randomUUID(), action, payload: structuredClone(payload) };
}
export async function readAll(client, collection) {
  const out = []; const size = 500;
  for (let offset = 0; offset <= 1000000; offset += size) {
    const {data,error} = await client.rpc('rooted_leader_state', {p_collection:collection,p_limit:size,p_offset:offset});
    if(error) throw error;
    if (!Array.isArray(data?.rows)) throw new Error('Invalid state');
    out.push(...data.rows);
    if(data.rows.length < size) return out;
  }
  throw new Error('Collection too large');
}
export function monday(date) {
  const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay()+6)%7));
  return d.toISOString().slice(0,10);
}
export function rankParticipants(rows) { return [...rows].sort((a,b)=>Number(b.points)-Number(a.points)||a.name.localeCompare(b.name)); }
