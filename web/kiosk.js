// Deliberately independent of the leader app: no Supabase SDK, cookies, or Auth APIs.
import { enhancePin } from './src/pin-input.js';
// Consume enrollment fragments before this module starts any asynchronous work.
let enrollment = /^#station=([0-9a-f]{64})$/.exec(location.hash)?.[1] || '';
const invalidEnrollment = !!(location.hash || location.search) && (!enrollment || !!location.search);
if (location.hash || location.search) history.replaceState(null, '', location.pathname);
if (invalidEnrollment) enrollment = '';
const $ = id => document.getElementById(id);
const pinControl = enhancePin($('pin'));
const TOKEN_KEY = 'rooted.kiosk.device.v1';
const PENDING_KEY = 'rooted.kiosk.pending.v1';
const STATION_KEY = 'rooted.kiosk.station.v1';
const EXPIRY_KEY = 'rooted.kiosk.expires.v1';
const IDLE_MS = 15 * 60 * 1000;
let station = '', generation = 0, expiresAt = 0, expiryTimer, receiptTimer, receiptPaused = false;
function scheduleExpiry() {
  clearTimeout(expiryTimer);
  if (token) expiryTimer = setTimeout(() => {
    if (Date.now() >= expiresAt) expireSession(); else scheduleExpiry();
  }, Math.min(Math.max(0, expiresAt - Date.now()), 2147483647));
}
function expireSession() {
  generation++; token = ''; context = null; busy = false; expiresAt = 0;
  clearTimeout(expiryTimer);
  sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(EXPIRY_KEY);
  const retry = pending; pending = null; reset(); pending = retry;
  $('event-label').textContent = 'Rooted · Shared check-in';
  setBusy(false); status('Daily access ended or was denied. Ask a leader to enter their PIN again.');
}
function receiptCountdown() {
  clearTimeout(receiptTimer);
  if ($('receipt-screen').hidden || pending || receiptPaused) return;
  receiptTimer = setTimeout(() => { if (!pending && !receiptPaused && !$('receipt-screen').hidden) reset(); }, 3000);
}
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
let searchVersion = 0, searchTimer, searchController, bibleAnswer = null;
function cancelSearch() {
  searchVersion++; clearTimeout(searchTimer); searchController?.abort(); searchController = null;
  $('matches').replaceChildren(); $('matches').setAttribute('aria-busy', 'false');
}
function bibleStep() {
  $('bible-step').hidden = false; $('chapters-step').hidden = true;
  $('bible-yes').setAttribute('aria-pressed', String(bibleAnswer === true));
  $('bible-no').setAttribute('aria-pressed', String(bibleAnswer === false));
}
const screens = ['activation', 'search-screen', 'person-screen', 'pending-screen', 'receipt-screen'];
function status(message = '') { $('status').textContent = message; }
function screen(id) {
  for (const name of screens) $(name).hidden = name !== id;
  $('lock').hidden = !token;
  $('lock').disabled = false; pairedUI();
  clearTimeout(idle);
  clearTimeout(receiptTimer);
  if (!pending && ['person-screen', 'search-screen'].includes(id)) idle = setTimeout(reset, IDLE_MS);
  if (id === 'receipt-screen') receiptCountdown();
}
function reset() {
  if (pending || busy) return;
  receiptPaused = false; clearTimeout(receiptTimer);
  cancelSearch(); bibleAnswer = null; bibleStep();
  pinControl.clear();
  selected = null; $('query').value = ''; $('matches').replaceChildren(); $('search-note').textContent = '';
  $('person-name').textContent = ''; $('points').textContent = ''; $('components').replaceChildren();
  $('receipt-id').textContent = ''; $('receipt-note').textContent = ''; $('bible').checked = false;
  $('pending-id').textContent = ''; $('bible-summary').textContent = '';
  $('keep-open').textContent = 'Keep open'; $('keep-open').setAttribute('aria-pressed', 'false');
  $('chapters').value = ''; $('week').textContent = ''; $('person-note').textContent = '';
  status(); screen(token && context ? 'search-screen' : 'activation');
  if (token && context) $('query').focus();
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
async function api(action, payload = {}, requestId, signal) {
  if (leaderSession()) { await lockStation(); throw Object.assign(new Error('Leader browser'), { stale: true }); }
  if (!token || !Number.isFinite(expiresAt) || Date.now() >= expiresAt) { expireSession(); throw Object.assign(new Error('Expired'), { stale: true }); }
  const epoch = generation;
  const response = await fetch('/api/kiosk', {
    method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'X-Rooted-Device-Token': token },
    body: JSON.stringify({ action, payload, ...(requestId ? { request_id: requestId } : {}) }),
  });
  if (epoch !== generation || !token) throw Object.assign(new Error('Station locked'), { stale: true });
  if ([401, 403].includes(response.status) || Date.now() >= expiresAt) {
    expireSession(); throw Object.assign(new Error('Access denied'), { stale: true });
  }
  const data = await response.json();
  if (epoch !== generation || !token) throw Object.assign(new Error('Station locked'), { stale: true });
  if (!response.ok) {
    if ([401, 403].includes(response.status) || ['forbidden', 'leader_required_or_expired', 'event_closed', 'invalid_station'].includes(data.error)) {
      expireSession(); throw Object.assign(new Error('Access denied'), { stale: true });
    }
    throw Object.assign(new Error('Request failed'), { code: data.error });
  }
  return data;
}
function showPending() {
  $('pending-id').textContent = `Request: ${pending.request_id}`;
  screen('pending-screen');
}
function showReceipt(receipt, duplicate = false) {
  if (!receipt || !uuid.test(receipt.checkin_id) || !Number.isSafeInteger(receipt.earned_points) || !Array.isArray(receipt.components) || !receipt.components.every(c => c && typeof c.label === 'string' && Number.isSafeInteger(c.points))) throw new Error('Missing receipt');
  receiptPaused = false;
  $('keep-open').textContent = 'Keep open'; $('keep-open').setAttribute('aria-pressed', 'false');
  $('return-note').textContent = 'Returns to name search after 3 seconds without interaction. Choose Keep open for more reading time.';
  $('points').textContent = String(receipt.earned_points);
  $('receipt-screen').querySelector('h1').textContent = duplicate ? 'Already checked in.' : "You're here. Let's grow.";
  $('receipt-note').textContent = duplicate ? 'You were already checked in. These are the points from your saved receipt, not additional points.' : 'Your check-in is saved. These points come from your server receipt.';
  $('components').replaceChildren(...receipt.components.map(c => { const li = document.createElement('li'); li.textContent = `${c.label}: ${c.points}`; return li; }));
  $('receipt-id').textContent = `Receipt: ${receipt.checkin_id}`;
  screen('receipt-screen');
  $('receipt-screen').querySelector('h1').focus();
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
  } catch (e) {
    if (!e.stale && token && e.code === 'checkin_conflict') {
      try {
        const participantId = pending.payload.participant_id;
        const existing = await api('person', { participant_id: participantId });
        if (existing.person?.id !== participantId || existing.already_checked_in !== true) throw new Error('Unconfirmed conflict');
        showReceipt(existing.receipt, true);
        sessionStorage.removeItem(PENDING_KEY); pending = null;
        screen('receipt-screen'); status();
      } catch (readError) { if (!readError.stale && token) { showPending(); status(message(e)); } }
    } else if (!e.stale && token) { showPending(); status(message(e)); }
  }
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
  if (!pinControl.validate()) return;
  let pin = $('pin').value; pinControl.clear();
  setBusy(true); status('Unlocking station…'); const epoch = generation;
  try {
    const result = await stationApi('unlock', station, pin); pin = '';
    if (!/^[0-9a-f]{64}$/.test(result.device_token) || !uuid.test(result.event_id) || !Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) <= Date.now()) throw new Error('Invalid unlock');
    if (epoch !== generation || leaderSession()) { await stationApi('lock', result.device_token); return; }
    token = result.device_token; expiresAt = Date.parse(result.expires_at);
    sessionStorage.setItem(TOKEN_KEY, token); sessionStorage.setItem(EXPIRY_KEY, result.expires_at); scheduleExpiry();
    setBusy(false); await activate();
  } catch (err) { if (!err.stale) status(message(err)); }
  finally { pin = ''; setBusy(false); }
});
$('search-form').addEventListener('submit', e => e.preventDefault());
$('query').addEventListener('input', () => {
  cancelSearch(); status();
  const query = $('query').value.trim();
  $('search-note').textContent = query.length < 2 ? 'Type at least two letters to see matching names.' : 'Finding matching names…';
  if (query.length < 2 || busy || !token || $('search-screen').hidden) return;
  const version = searchVersion;
  searchTimer = setTimeout(() => searchNames(query, version), 300);
});
async function searchNames(query, version) {
  if (version !== searchVersion || !token || $('search-screen').hidden) return;
  const controller = new AbortController(); searchController = controller;
  $('matches').setAttribute('aria-busy', 'true');
  try {
    const data = await api('search', { query }, undefined, controller.signal);
    if (version !== searchVersion || $('search-screen').hidden) return;
    if (!Array.isArray(data.matches)) throw new Error('Invalid results');
    $('matches').replaceChildren(...data.matches.map(p => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'person-option'; button.textContent = p.name;
      button.addEventListener('click', () => selectPerson(p.id)); return button;
    }));
    $('search-note').textContent = data.truncated ? 'More names match. Type more of your name to narrow the search.' : data.matches.length ? 'Choose your name. If names are the same, ask a leader.' : 'No match found. Ask a leader to help.';
  } catch (err) { if (version === searchVersion && !err.stale && !controller.signal.aborted) $('search-note').textContent = message(err); }
  finally { if (version === searchVersion) { searchController = null; $('matches').setAttribute('aria-busy', 'false'); } }
}
async function selectPerson(id) {
  if (busy) return; cancelSearch(); setBusy(true); status('Checking your record…');
  try {
    const data = await api('person', { participant_id: id });
    if (!data.person || data.person.id !== id || typeof data.needs_leader !== 'boolean' || typeof data.already_checked_in !== 'boolean') throw new Error('Invalid person');
    if (data.already_checked_in) { showReceipt(data.receipt, true); status(); return; }
    selected = data.person; $('person-name').textContent = data.person.name;
    $('person-note').textContent = data.needs_leader ? 'Welcome! A leader needs to help with your first check-in. Please ask them before continuing.' : 'Two quick questions, then confirm your check-in.';
    $('checkin-form').hidden = data.needs_leader;
    $('chapters').value = String(data.prior_chapters);
    $('bible').checked = false;
    bibleAnswer = null; bibleStep();
    $('week').textContent = `Week beginning ${context.event.reading_week} · Already recorded: ${data.prior_chapters} chapters`;
    screen('person-screen'); status(); if (!data.needs_leader) $('bible-question').focus();
  } catch (e) { if (!e.stale) status(message(e)); }
  finally { setBusy(false); }
}
for (const [id, answer] of [['bible-yes', true], ['bible-no', false]]) $(id).addEventListener('click', () => {
  if (busy || !selected) return;
  bibleAnswer = answer; $('bible').checked = answer; bibleStep();
  $('bible-step').hidden = true; $('chapters-step').hidden = false;
  $('bible-summary').textContent = answer ? 'Bible: Yes, I brought it.' : 'Bible: No, not today.';
  status(); $('chapters').focus();
});
$('back-bible').addEventListener('click', () => { if (!busy) { bibleStep(); status(); $('bible-question').focus(); } });
$('checkin-form').addEventListener('submit', e => {
  e.preventDefault(); if (busy || pending || !selected || bibleAnswer === null || $('chapters-step').hidden || $('checkin-form').hidden) return;
  const chapters = Number($('chapters').value);
  if ($('chapters').value === '' || !Number.isInteger(chapters) || chapters < 0 || chapters > 100000) return status('Enter a whole number from 0 to 100000.');
  const intent = { event_id: context.event.id, request_id: crypto.randomUUID(), payload: { participant_id: selected.id, bible: $('bible').checked, chapters } };
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(intent)); }
  catch { return status('This browser cannot safely retain a retry. Ask a leader; nothing was submitted.'); }
  pending = intent; submitPending();
});
$('retry').addEventListener('click', submitPending);
$('back').addEventListener('click', reset); $('next').addEventListener('click', reset);
$('keep-open').addEventListener('click', () => {
  receiptPaused = !receiptPaused;
  $('keep-open').setAttribute('aria-pressed', String(receiptPaused));
  $('keep-open').textContent = receiptPaused ? 'Resume auto-return' : 'Keep open';
  $('return-note').textContent = receiptPaused ? 'Auto-return paused. Choose Done when you are ready.' : 'Returns to name search after 3 seconds without interaction.';
  receiptCountdown();
});
async function lockStation(forget = false) {
  const old = token; generation++; token = ''; context = null; busy = false;
  clearTimeout(expiryTimer); expiresAt = 0;
  sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(EXPIRY_KEY);
  if (forget) { localStorage.removeItem(STATION_KEY); station = ''; }
  pinControl.clear(); $('token').value = '';
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
  if (leaderSession()) { lockStation(); return; }
  if (Date.now() >= expiresAt) { expireSession(); return; }
  if (!$('receipt-screen').hidden) receiptCountdown();
  else if (!pending) { clearTimeout(idle); idle = setTimeout(reset, IDLE_MS); }
}
for (const name of ['pointerdown', 'keydown']) document.addEventListener(name, activity, { capture: true });
setInterval(() => { if (token && leaderSession()) lockStation(); else if (token && Date.now() >= expiresAt) expireSession(); }, 1000);
window.addEventListener('storage', () => {
  const saved = localStorage.getItem(STATION_KEY) || '';
  const changed = saved !== station;
  station = /^[0-9a-f]{64}$/.test(saved) ? saved : '';
  pairedUI(); if (token && (leaderSession() || changed)) lockStation();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) activity(); });
window.addEventListener('beforeunload', e => { if (pending) { e.preventDefault(); e.returnValue = ''; } });
try {
  station = localStorage.getItem(STATION_KEY) || '';
  if (!/^[0-9a-f]{64}$/.test(station)) station = '';
  if (enrollment && !leaderSession()) {
    if (!station) { $('token').value = enrollment; status('Station code scanned. Tap Remember this station, then enter a leader PIN.'); }
    else if (station !== enrollment) status('This device already remembers a different station. Ask a leader to forget it before scanning the new code.');
  } else if (invalidEnrollment) status('That station link is not valid. Ask a leader for a new QR code.');
  enrollment = '';
  token = sessionStorage.getItem(TOKEN_KEY) || '';
  expiresAt = Date.parse(sessionStorage.getItem(EXPIRY_KEY) || '');
  const saved = sessionStorage.getItem(PENDING_KEY);
  if (saved) {
    const p = JSON.parse(saved);
    if (!uuid.test(p.request_id) || !p.payload || !uuid.test(p.payload.participant_id) || typeof p.payload.bible !== 'boolean' || !Number.isInteger(p.payload.chapters) || p.payload.chapters < 0 || p.payload.chapters > 100000) throw new Error('Invalid saved retry');
    pending = { event_id: p.event_id, request_id: p.request_id, payload: { participant_id: p.payload.participant_id, bible: p.payload.bible, chapters: p.payload.chapters } };
  }
  if (token && (!station || leaderSession())) lockStation();
  else if (token && (!Number.isFinite(expiresAt) || Date.now() >= expiresAt)) expireSession();
  else if (/^[0-9a-f]{64}$/.test(token)) { scheduleExpiry(); activate(); } else { token = ''; screen('activation'); }
} catch {
  setBusy(true); status('Session storage is unavailable or an unfinished retry could not be restored. Ask a leader to verify any check-in before clearing this tab.');
}
