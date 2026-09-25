// Isolated projection surface: deliberately no leader SDK, session, or contact data.
import { enhancePin } from './src/pin-input.js';
let enrollment = /^#station=([a-f0-9]{64})$/.exec(location.hash)?.[1] || '';
const invalidLink = !!(location.hash || location.search) && (!enrollment || !!location.search);
if (location.hash || location.search) history.replaceState(null, '', location.pathname);
if (invalidLink) enrollment = '';
const $ = id => document.getElementById(id);
const pin = enhancePin($('pin'));
const STATION = 'rooted.kiosk.station.v1', DEVICE = 'rooted.display.device.v1', EXPIRY = 'rooted.display.expires.v1';
const validCode = value => /^[a-f0-9]{64}$/.test(value || '');
let station = '', token = '', expires = 0, generation = 0, busy = false, request = null, timer, expiryTimer, rows = [], page = 0;
const status = text => { $('status').textContent = text; };
function leaderSession() {
  try { return [localStorage, sessionStorage].some(s => Object.keys(s).some(k => /^sb-.+-auth-token(?:\.\d+)?$/.test(k))); } catch { return true; }
}
function gate() {
  const blocked = leaderSession();
  $('leader-warning').hidden = !blocked; $('pair-form').hidden = blocked || !!station;
  $('activate-form').hidden = blocked || !station; $('forget').hidden = !station;
  $('activation').hidden = !!token; $('board').hidden = !token; $('lock').hidden = !token && !busy;
  $('activate-form').querySelector('button').disabled = busy;
}
function clear(message) {
  generation++; request?.abort(); request = null; clearTimeout(timer); clearTimeout(expiryTimer);
  token = ''; expires = 0; busy = false; rows = []; page = 0;
  $('chart').replaceChildren(); $('attendance').textContent = ''; $('event-label').textContent = ''; $('updated').textContent = ''; $('page-label').textContent = ''; $('empty').hidden = true;
  pin.clear(); $('station').value = '';
  try { sessionStorage.removeItem(DEVICE); sessionStorage.removeItem(EXPIRY); } catch { /* In-memory state is already cleared. */ }
  gate(); status(message);
}
async function stationApi(action, value, secret) {
  const response = await fetch('/api/station', { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', [action === 'unlock' ? 'X-Rooted-Station' : 'X-Rooted-Device']: value }, body: JSON.stringify({ action, ...(action === 'unlock' ? { pin: secret } : {}) }) });
  const data = await response.json();
  if (!response.ok || data.ok !== true) throw Object.assign(new Error('Station request failed'), { code: data.error });
  return data;
}
async function lock() {
  const old = token; clear('Screen locked.'); const epoch = generation;
  try { if (old) await stationApi('lock', old); }
  catch { if (epoch === generation) status('Screen cleared locally. Server revocation is not confirmed; ask a leader to revoke this device.'); }
}
function allowed() {
  if (leaderSession()) { clear('Use a separate browser profile with no leader sign-in.'); return false; }
  if (!token || !Number.isFinite(expires) || Date.now() >= expires) { clear('Daily access ended. Ask a leader to enter their PIN again.'); return false; }
  return true;
}
function scheduleExpiry() {
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => { if (Date.now() >= expires) clear('Daily access ended. Ask a leader to enter their PIN again.'); else scheduleExpiry(); }, Math.min(Math.max(expires - Date.now(), 0), 2147483647));
}
function renderRows() {
  const pages = Math.max(1, Math.ceil(rows.length / 10)); page = Math.min(page, pages - 1);
  const maximum = rows[0]?.points || 0;
  $('chart').replaceChildren(...rows.slice(page * 10, page * 10 + 10).map(p => {
    const li = document.createElement('li'); li.className = 'row';
    const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = p.rank;
    const track = document.createElement('div'); track.className = 'track';
    const bar = document.createElement('span'); bar.className = 'bar'; bar.style.width = `${maximum > 0 ? Math.max(0, Math.min(100, p.points / maximum * 100)) : 0}%`; bar.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span'); name.className = 'name'; name.textContent = p.name; name.title = p.name;
    track.append(bar, name);
    if (p.present) { const dot = document.createElement('span'); dot.className = 'presence-dot'; dot.setAttribute('role', 'img'); dot.setAttribute('aria-label', 'Here tonight'); track.append(dot); }
    const points = document.createElement('span'); points.className = 'points'; points.textContent = p.points.toLocaleString();
    li.append(rank, track, points); return li;
  }));
  $('page-label').textContent = `Page ${page + 1} of ${pages}`;
  $('previous').disabled = page === 0; $('next').disabled = page >= pages - 1;
  $('empty').hidden = rows.length !== 0;
}
function render(data) {
  if (!data.event || typeof data.event.name !== 'string' || typeof data.event.date !== 'string' || !Number.isSafeInteger(data.attendance_count) || data.attendance_count < 0 || !Number.isFinite(Date.parse(data.updated_at)) || !Array.isArray(data.participants) || !data.participants.every(p => p && typeof p.id === 'string' && typeof p.name === 'string' && Number.isSafeInteger(p.points) && typeof p.present === 'boolean')) throw new Error('Invalid display response');
  // Project only the allowlisted fields even if a server response gains other properties.
  rows = data.participants.map(({ id, name, points, present }) => ({ id, name, points, present })).sort((a,b) => b.points - a.points || a.name.localeCompare(b.name));
  rows.forEach((p,i) => { p.rank = i && rows[i - 1].points === p.points ? rows[i - 1].rank : i + 1; });
  $('event-label').textContent = `${data.event.name} · ${data.event.date}`;
  $('attendance').textContent = data.attendance_count.toLocaleString();
  $('updated').textContent = `Last server update: ${new Date(data.updated_at).toLocaleString()}`;
  renderRows(); gate(); status('');
}
async function poll() {
  if (request || document.hidden || !token) return;
  if (!allowed()) return;
  clearTimeout(timer); const epoch = generation; const controller = new AbortController(); request = controller;
  try {
    const response = await fetch('/api/display', { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]), headers: { 'Content-Type': 'application/json', 'X-Rooted-Device-Token': token }, body: JSON.stringify({ action: 'display', payload: {} }) });
    if (epoch !== generation) return;
    if ([401,403].includes(response.status)) { clear('Display access expired or was revoked. Ask a leader to enter their PIN again.'); return; }
    const data = await response.json(); if (epoch !== generation || !allowed()) return;
    if (['forbidden','leader_required_or_expired','event_closed','invalid_station','device_expired','device_revoked'].includes(data.error)) { clear('Display access ended. Ask a leader to enter their PIN again.'); return; }
    if (!response.ok || data.error) throw new Error('Display request failed');
    render(data);
  } catch { if (epoch === generation) status($('updated').textContent ? 'Connection interrupted — showing the last confirmed update. Retrying…' : 'No server update received. Check the connection; retrying…'); }
  finally {
    if (request === controller) request = null;
    if (epoch === generation && token && !document.hidden) timer = setTimeout(poll, 15000);
  }
}
$('pair-form').addEventListener('submit', e => {
  e.preventDefault(); if (leaderSession() || busy) return gate();
  const value = $('station').value.trim(); $('station').value = '';
  if (!validCode(value)) return status('Enter the exact 64-character station setup code from a leader.');
  try { localStorage.setItem(STATION, value); station = value; gate(); status('Station remembered. A leader PIN is required to show the board.'); } catch { status('Browser storage is unavailable. Enable storage before setting up the display.'); }
});
$('activate-form').addEventListener('submit', async e => {
  e.preventDefault(); if (busy || leaderSession() || !station) return gate(); if (!pin.validate()) return;
  let secret = $('pin').value; pin.clear(); busy = true; gate(); status('Unlocking display…'); const epoch = generation;
  try {
    const data = await stationApi('unlock', station, secret); secret = '';
    if (epoch !== generation || leaderSession()) { if (validCode(data.device_token)) await stationApi('lock', data.device_token); return; }
    if (!validCode(data.device_token) || !Number.isFinite(Date.parse(data.expires_at)) || Date.parse(data.expires_at) <= Date.now()) throw new Error('Invalid unlock');
    token = data.device_token; expires = Date.parse(data.expires_at);
    sessionStorage.setItem(DEVICE, token); sessionStorage.setItem(EXPIRY, data.expires_at);
    scheduleExpiry(); gate(); status('Waiting for the first server update…'); await poll();
  } catch (err) {
    if (epoch === generation) {
      if (token) clear('Unable to store display access. Enable browser storage and unlock again.');
      else status(err.code === 'invalid_pin' ? 'That PIN was not accepted. Try again.' : err.code === 'locked' ? 'Too many attempts. Wait 15 minutes before trying again.' : 'Display could not be unlocked. Check the connection or ask a leader for a valid station and PIN.');
    }
  } finally { secret = ''; if (epoch === generation) { busy = false; gate(); } }
});
$('lock').addEventListener('click', lock);
$('forget').addEventListener('click', () => { lock(); try { localStorage.removeItem(STATION); station = ''; gate(); } catch { status('Screen cleared, but the station could not be forgotten in browser storage.'); } });
$('previous').addEventListener('click', () => { if (token && allowed()) { page = Math.max(0, page - 1); renderRows(); } });
$('next').addEventListener('click', () => { if (token && allowed()) { page++; renderRows(); } });
$('fullscreen').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch { status('Full screen is unavailable here. Use your browser or device’s screen-sharing controls.'); } });
document.addEventListener('fullscreenchange', () => { $('fullscreen').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'; });
document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer); else if (token && allowed()) poll(); });
window.addEventListener('online', () => { if (token) poll(); });
window.addEventListener('offline', () => { if (token) status('Offline — showing only the last confirmed update.'); });
window.addEventListener('storage', () => {
  try { const saved = localStorage.getItem(STATION) || ''; if (saved !== station || leaderSession()) { clear('Browser access changed. Unlock again in a separate display profile.'); station = validCode(saved) ? saved : ''; } gate(); } catch { clear('Browser storage is unavailable.'); }
});
setInterval(() => { if ((token || busy) && leaderSession()) clear('Use a separate browser profile with no leader sign-in.'); else if (token && Date.now() >= expires) clear('Daily access ended. Ask a leader to enter their PIN again.'); }, 1000);
window.addEventListener('pagehide', () => { generation++; request?.abort(); request = null; clearTimeout(timer); $('chart').replaceChildren(); rows = []; });
window.addEventListener('pageshow', e => { if (e.persisted) { if (token && allowed()) poll(); else gate(); } });
try {
  const saved = localStorage.getItem(STATION); station = validCode(saved) ? saved : '';
  if (enrollment && !leaderSession()) {
    if (!station) { $('station').value = enrollment; status('Station link received. Remember this station, then enter a leader PIN.'); }
    else if (station !== enrollment) status('A different station is already remembered. Forget it before setting up another.');
  } else if (invalidLink) status('Invalid station link. Ask a leader for a display setup link.');
  enrollment = '';
  const savedToken = sessionStorage.getItem(DEVICE), savedExpiry = Date.parse(sessionStorage.getItem(EXPIRY));
  if (validCode(savedToken) && station && !leaderSession() && savedExpiry > Date.now()) { token = savedToken; expires = savedExpiry; scheduleExpiry(); gate(); poll(); }
  else { if (savedToken) clear('Ask a leader to unlock this display.'); gate(); }
} catch { clear('Browser storage is unavailable. Enable storage before using the display.'); }
