// Deliberately independent of the leader app: no Supabase SDK, cookies, or Auth APIs.
const $ = id => document.getElementById(id);
const TOKEN_KEY = 'rooted.kiosk.device.v1';
const PENDING_KEY = 'rooted.kiosk.pending.v1';
const STATION_KEY = 'rooted.kiosk.station.v1';
const ACTIVITY_KEY = 'rooted.kiosk.activity.v1';
const IDLE_MS = 15 * 60 * 1000;
let station = '', generation = 0, lastActivity = Date.now();
function leaderSession() {
  try { return [localStorage, sessionStorage].some(store => Object.keys(store).some(k => /^sb-.+-auth-token(?:\.\d+)?$/.test(k))); }
  catch { return true; }
}
function pairedUI() {
  const blocked = leaderSession();
  $('leader-warning').hidden = !blocked;
  $('pair-form').hidden = blocked || !!station;
  $('activate-form').hidden = blocked || !station;
  $('forget').hidden = !station;
}
async function stationApi(action, value, pin) {
  const response = await fetch('/api/station', {
    method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', [action === 'unlock' ? 'X-Rooted-Station' : 'X-Rooted-Device']: value },
    body: JSON.stringify({ action, ...(action === 'unlock' ? { pin } : {}) }),
  });
  const data = await response.json();
  if (!response.ok || data.ok !== true) throw Object.assign(new Error('Station request failed'), { code: data.error });
  return data;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let token = '', pending = null, context = null, selected = null, busy = false, idle;
const screens = ['activation', 'search-screen', 'person-screen', 'pending-screen', 'receipt-screen'];
function status(message = '') { $('status').textContent = message; }
function screen(id) {
  for (const name of screens) $(name).hidden = name !== id;
  $('lock').hidden = !token;
  $('lock').disabled = false; pairedUI();
  clearTimeout(idle);
  if (!pending && ['person-screen', 'receipt-screen', 'search-screen'].includes(id)) idle = setTimeout(reset, 90000);
}
function reset() {
  if (pending || busy) return;
  selected = null; $('query').value = ''; $('matches').replaceChildren(); $('search-note').textContent = '';
  $('person-name').textContent = ''; $('points').textContent = ''; $('components').replaceChildren();
  $('receipt-id').textContent = ''; $('receipt-note').textContent = ''; $('bible').checked = false;
  $('chapters').value = ''; $('week').textContent = ''; $('person-note').textContent = '';
  status(); screen(token && context ? 'search-screen' : 'activation');
}
function setBusy(value) {
  busy = value;
  for (const button of document.querySelectorAll('button')) button.disabled = value;
  $('lock').disabled = false;
}
function message(e) {
  if (e.code === 'invalid_pin') return 'That PIN was not accepted. Ask a leader to try again.';
  if (e.code === 'locked') return 'Too many attempts. Wait 15 minutes before trying again.';
  if (e.code === 'invalid_station') return 'This station is expired or revoked. Ask a leader for a new setup code.';
  if (e.code === 'event_closed') return 'Check-in for this event is closed. Ask a leader for help.';
  if (e.code === 'rate_limited') return 'Please wait one minute, then try again.';
  if (e.code === 'leader_required_or_expired' || e.code === 'forbidden') return 'Ask a leader for help. This device may be expired, revoked, or need leader approval.';
  if (e.code === 'checkin_conflict') return 'A different check-in may already exist. Ask a leader to verify the record.';
  if (e.code === 'invalid_request') return 'This check-in could not be accepted. Ask a leader to help.';
  return 'No server confirmation received. Check the connection and retry; no offline points are awarded.';
}
async function api(action, payload = {}, requestId) {
  if (leaderSession()) { await lockStation(); throw Object.assign(new Error('Leader browser'), { stale: true }); }
  const epoch = generation;
  const response = await fetch('/api/kiosk', {
    method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'X-Rooted-Device-Token': token },
    body: JSON.stringify({ action, payload, ...(requestId ? { request_id: requestId } : {}) }),
  });
  const data = await response.json();
  if (epoch !== generation || !token) throw Object.assign(new Error('Station locked'), { stale: true });
  if (!response.ok) throw Object.assign(new Error('Request failed'), { code: data.error });
  return data;
}
function showPending() {
  $('pending-id').textContent = `Request: ${pending.request_id}`;
  screen('pending-screen');
}
function showReceipt(receipt, duplicate = false) {
  if (!receipt || !uuid.test(receipt.checkin_id) || !Number.isSafeInteger(receipt.earned_points) || !Array.isArray(receipt.components)) throw new Error('Missing receipt');
  $('points').textContent = String(receipt.earned_points);
  $('receipt-note').textContent = duplicate ? 'You were already checked in. These are the points from your saved receipt, not additional points.' : 'Your check-in is saved. These points come from your server receipt.';
  $('components').replaceChildren(...receipt.components.map(c => { const li = document.createElement('li'); li.textContent = `${c.label}: ${c.points}`; return li; }));
  $('receipt-id').textContent = `Receipt: ${receipt.checkin_id}`;
  screen('receipt-screen');
}
async function submitPending() {
  if (busy || !pending) return;
  showPending(); setBusy(true); status('Confirming with the server…');
  try {
    const result = await api('checkin', pending.payload, pending.request_id);
    if (result.action !== 'kiosk.checkin' || result.request_id !== pending.request_id || !result.result || typeof result.result.duplicate !== 'boolean') throw new Error('Missing receipt');
    // Render only a real receipt; clear the persisted retry only after validation.
    showReceipt(result.result.receipt, result.result.duplicate);
    sessionStorage.removeItem(PENDING_KEY); pending = null;
    screen('receipt-screen'); status();
  } catch (e) { if (!e.stale && token) { showPending(); status(message(e)); } }
  finally { setBusy(false); }
}
async function activate() {
  if (busy) return;
  setBusy(true); status('Checking device access…');
  try {
    context = await api('context');
    if (!context.event || !uuid.test(context.event.id) || typeof context.event.name !== 'string') throw new Error('Invalid context');
    sessionStorage.setItem(TOKEN_KEY, token);
    if (pending && pending.event_id !== context.event.id) throw new Error('Pending event mismatch');
    $('event-label').textContent = `${context.event.name} · ${context.event.date}`;
    status(); if (pending) showPending(); else screen('search-screen');
  } catch (e) { if (!e.stale) { context = null; status(message(e)); screen('activation'); } }
  finally { setBusy(false); }
}
$('pair-form').addEventListener('submit', e => {
  e.preventDefault(); if (busy || leaderSession()) return pairedUI();
  const value = $('token').value.trim(); $('token').value = '';
  if (!/^[0-9a-f]{64}$/.test(value)) return status('Enter the exact station setup code from a leader.');
  try { localStorage.setItem(STATION_KEY, value); station = value; pairedUI(); status('Station remembered. Enter a leader PIN to unlock.'); }
  catch { status('This browser cannot remember a station. Ask a leader to enable storage.'); }
});
$('activate-form').addEventListener('submit', async e => {
  e.preventDefault(); if (busy || leaderSession() || !station) return pairedUI();
  let pin = $('pin').value; $('pin').value = '';
  if (!/^[0-9]{6}$/.test(pin)) return status('Enter a six-digit leader PIN.');
  setBusy(true); status('Unlocking station…'); const epoch = generation;
  try {
    const result = await stationApi('unlock', station, pin); pin = '';
    if (!/^[0-9a-f]{64}$/.test(result.device_token) || !uuid.test(result.event_id) || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) <= Date.now()) throw new Error('Invalid unlock');
    if (epoch !== generation || leaderSession()) { await stationApi('lock', result.device_token); return; }
    token = result.device_token; sessionStorage.setItem(TOKEN_KEY, token);
    lastActivity = Date.now(); sessionStorage.setItem(ACTIVITY_KEY, String(lastActivity));
    setBusy(false); await activate();
  } catch (err) { if (!err.stale) status(message(err)); }
  finally { pin = ''; setBusy(false); }
});
$('search-form').addEventListener('submit', async e => {
  e.preventDefault(); if (busy) return;
  const query = $('query').value.trim(); if (query.length < 2) return status('Please enter at least two letters.');
  setBusy(true); status('Finding your name…'); $('matches').replaceChildren();
  try {
    const data = await api('search', { query });
    if (!Array.isArray(data.matches)) throw new Error('Invalid results');
    $('matches').replaceChildren(...data.matches.map(p => {
      const button = document.createElement('button'); button.className = 'person-option'; button.textContent = p.name;
      button.addEventListener('click', () => selectPerson(p.id)); return button;
    }));
    $('search-note').textContent = data.truncated ? 'More names match. Type more of your name to narrow the search.' : data.matches.length ? 'Choose your name. If names are the same, ask a leader.' : 'No match found. Ask a leader to help.';
    status(); screen('search-screen');
  } catch (err) { if (!err.stale) status(message(err)); }
  finally { setBusy(false); }
});
async function selectPerson(id) {
  if (busy) return; setBusy(true); status('Checking your record…');
  try {
    const data = await api('person', { participant_id: id });
    if (!data.person || data.person.id !== id || typeof data.needs_leader !== 'boolean' || typeof data.already_checked_in !== 'boolean') throw new Error('Invalid person');
    if (data.already_checked_in && data.receipt) { showReceipt(data.receipt, true); status(); return; }
    selected = data.person; $('person-name').textContent = data.person.name;
    $('person-note').textContent = data.needs_leader ? 'Welcome! A leader needs to help with your first check-in. Please ask them before continuing.' : 'Confirm your Bible and reading for this week.';
    $('checkin-form').hidden = data.needs_leader;
    $('chapters').value = String(data.prior_chapters);
    $('bible').checked = false;
    $('week').textContent = `Week beginning ${context.event.reading_week} · Already recorded: ${data.prior_chapters} chapters`;
    screen('person-screen'); status();
  } catch (e) { if (!e.stale) status(message(e)); }
  finally { setBusy(false); }
}
$('checkin-form').addEventListener('submit', e => {
  e.preventDefault(); if (busy || pending || !selected) return;
  const chapters = Number($('chapters').value);
  if ($('chapters').value === '' || !Number.isInteger(chapters) || chapters < 0 || chapters > 100000) return status('Enter a whole number from 0 to 100000.');
  const intent = { event_id: context.event.id, request_id: crypto.randomUUID(), payload: { participant_id: selected.id, bible: $('bible').checked, chapters } };
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(intent)); }
  catch { return status('This browser cannot safely retain a retry. Ask a leader; nothing was submitted.'); }
  pending = intent; submitPending();
});
$('retry').addEventListener('click', submitPending);
$('back').addEventListener('click', reset); $('next').addEventListener('click', reset);
async function lockStation(forget = false) {
  const old = token; generation++; token = ''; context = null; busy = false;
  sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(ACTIVITY_KEY);
  if (forget) { localStorage.removeItem(STATION_KEY); station = ''; }
  $('pin').value = ''; $('token').value = '';
  const retry = pending; pending = null; reset(); pending = retry;
  $('event-label').textContent = 'Rooted · Shared check-in'; setBusy(true);
  status('Station locked on this device.');
  try { if (old) await stationApi('lock', old); status(pending ? 'Station locked. An unfinished check-in is retained for exact retry after a leader unlocks this same event.' : 'Station locked.'); }
  catch { status('Locked on this device, but server revocation is NOT confirmed. Ask a leader to revoke the session; it may remain valid until expiry.'); }
  finally { setBusy(false); }
}
$('lock').addEventListener('click', () => lockStation());
$('forget').addEventListener('click', () => { if (confirm('Forget this trusted station? A new setup code will be needed.')) lockStation(true); });
function activity() {
  if (!token) return;
  if (Date.now() - lastActivity >= IDLE_MS || leaderSession()) { lockStation(); return; }
  lastActivity = Date.now(); sessionStorage.setItem(ACTIVITY_KEY, String(lastActivity));
}
for (const name of ['pointerdown', 'keydown']) document.addEventListener(name, activity, { capture: true });
setInterval(() => { if (token && (Date.now() - lastActivity >= IDLE_MS || leaderSession())) lockStation(); }, 1000);
window.addEventListener('storage', () => {
  const saved = localStorage.getItem(STATION_KEY) || '';
  const changed = saved !== station;
  station = /^[0-9a-f]{64}$/.test(saved) ? saved : '';
  pairedUI(); if (token && (leaderSession() || changed)) lockStation();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && token && (Date.now() - lastActivity >= IDLE_MS || leaderSession())) lockStation(); });
window.addEventListener('beforeunload', e => { if (pending) { e.preventDefault(); e.returnValue = ''; } });
try {
  station = localStorage.getItem(STATION_KEY) || '';
  if (!/^[0-9a-f]{64}$/.test(station)) station = '';
  token = sessionStorage.getItem(TOKEN_KEY) || '';
  lastActivity = Number(sessionStorage.getItem(ACTIVITY_KEY)) || 0;
  const saved = sessionStorage.getItem(PENDING_KEY);
  if (saved) {
    const p = JSON.parse(saved);
    if (!uuid.test(p.request_id) || !p.payload || !uuid.test(p.payload.participant_id) || typeof p.payload.bible !== 'boolean' || !Number.isInteger(p.payload.chapters) || p.payload.chapters < 0 || p.payload.chapters > 100000) throw new Error('Invalid saved retry');
    pending = { event_id: p.event_id, request_id: p.request_id, payload: { participant_id: p.payload.participant_id, bible: p.payload.bible, chapters: p.payload.chapters } };
  }
  if (token && (!station || leaderSession() || Date.now() - lastActivity >= IDLE_MS)) lockStation();
  else if (/^[0-9a-f]{64}$/.test(token)) activate(); else { token = ''; screen('activation'); }
} catch {
  setBusy(true); status('Session storage is unavailable or an unfinished retry could not be restored. Ask a leader to verify any check-in before clearing this tab.');
}
