import { createHash } from 'node:crypto';

// This module is server-only. Never import it from a browser entry point.
export const config = { api: { bodyParser: false } };
const MAX_BYTES = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9a-f]{64}$/;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, expected) => object(v) && Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));
const integer = v => Number.isInteger(v) && v >= 0 && v <= 100000;
const text = (v, max = 200) => typeof v === 'string' && v.length <= max;
const uuid = v => typeof v === 'string' && UUID.test(v);
const error = (status, code) => Object.assign(new Error(code), { status, code });

export function validateBody(body) {
  if (!object(body) || !['unlock', 'lock'].includes(body.action)) throw error(400, 'invalid_request');
  if (body.action === 'unlock') {
    if (!keys(body, ['action', 'pin']) || typeof body.pin !== 'string' || !/^[0-9]{6}$/.test(body.pin)) throw error(400, 'invalid_request');
    return { p_pin: body.pin };
  }
  if (!keys(body, ['action'])) throw error(400, 'invalid_request');
  return {};
}

async function readBody(req) {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > MAX_BYTES)) throw error(413, 'request_too_large');
  // Some Node adapters parse before invocation. Check their parsed result too.
  if (req.body !== undefined) {
    const raw = Buffer.isBuffer(req.body) ? req.body : typeof req.body === 'string' ? Buffer.from(req.body) : Buffer.from(JSON.stringify(req.body));
    if (raw.length > MAX_BYTES) throw error(413, 'request_too_large');
    try { return JSON.parse(raw.toString('utf8')); } catch { throw error(400, 'invalid_request'); }
  }
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > MAX_BYTES) throw error(413, 'request_too_large');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw error(400, 'invalid_request'); }
}

// Only documented failure codes may cross the server boundary.
const SAFE_ERRORS = new Set(['invalid_station', 'invalid_pin', 'locked', 'event_closed']);
function project(action, value) {
  if (!object(value) || typeof value.ok !== 'boolean') throw error(502, 'unavailable');
  if (!value.ok) return { ok: false, error: SAFE_ERRORS.has(value.error) ? value.error : 'unavailable', ...(SAFE_ERRORS.has(value.error) && Number.isInteger(value.retry_after_seconds) && value.retry_after_seconds >= 0 && value.retry_after_seconds <= 900 ? { retry_after_seconds: value.retry_after_seconds } : {}) };
  if (action === 'lock') return { ok: true };
  if (typeof value.device_token !== 'string' || !TOKEN.test(value.device_token) || !uuid(value.event_id) || typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at))) throw error(502, 'unavailable');
  return { ok: true, device_token: value.device_token, expires_at: value.expires_at, event_id: value.event_id };
}

export function createHandler({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const buckets = new Map();
  function charge(key, limit) {
    const time = now();
    if (buckets.size >= 4096) for (const [k, b] of buckets) if (time >= b.until) buckets.delete(k);
    let b = buckets.get(key);
    if (!b || time >= b.until) {
      if (!b && buckets.size >= 4096) throw error(429, 'rate_limited');
      b = { until: time + 60000, count: 0 }; buckets.set(key, b);
    }
    if (++b.count > limit) throw error(429, 'rate_limited');
  }
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status, data) => { res.statusCode = status; res.end(JSON.stringify(data)); };
    try {
      charge('global', 600);
      // Vercel overwrites this header. Outside Vercel use the socket, not caller-supplied X-Forwarded-For.
      const ip = env.VERCEL === '1' ? req.headers['x-vercel-forwarded-for'] || req.socket?.remoteAddress : req.socket?.remoteAddress;
      charge('ip:' + createHash('sha256').update(String(ip || 'unknown')).digest('hex'), 120);
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw error(405, 'method_not_allowed'); }
      if (typeof req.url !== 'string' || req.url.includes('?')) throw error(400, 'invalid_request');
      const host = req.headers.host;
      if (typeof host !== 'string' || !/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) throw error(403, 'forbidden');
      const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
      const expected = env.KIOSK_ORIGIN || `${local && env.NODE_ENV !== 'production' ? 'http' : 'https'}://${host}`;
      if (req.headers.origin !== expected || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) throw error(403, 'forbidden');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '') || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) throw error(415, 'unsupported_media_type');
      const body = await readBody(req);
      const args = validateBody(body);
      const token = req.headers[body.action === 'unlock' ? 'x-rooted-station' : 'x-rooted-device'];
      if (typeof token !== 'string' || !TOKEN.test(token)) throw error(403, 'forbidden');
      charge('device:' + createHash('sha256').update(token).digest('hex'), body.action === 'unlock' ? 12 : 90);
      let base;
      try { base = new URL(env.SUPABASE_URL); } catch { throw error(503, 'unavailable'); }
      if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || (base.pathname !== '/' && base.pathname !== '') || !env.SUPABASE_SERVICE_ROLE_KEY) throw error(503, 'unavailable');
      const upstream = await fetchImpl(new URL(body.action === 'unlock' ? '/rest/v1/rpc/rooted_station_unlock' : '/rest/v1/rpc/rooted_station_lock', base), {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify(body.action === 'unlock' ? { p_station_token: token, ...args } : { p_token: token }),
      });
      // Upstream data is bounded independently; never forward database error text.
      const reader = upstream.body?.getReader(); let raw = ''; let size = 0;
      if (!reader) throw error(502, 'unavailable');
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 32768) { await reader.cancel(); throw error(502, 'unavailable'); }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
      let data; try { data = JSON.parse(raw); } catch { throw error(502, 'unavailable'); }
      if (!upstream.ok) {
        if (data?.code === '42501') throw error(403, 'leader_required_or_expired');
        if (data?.code === '23505') throw error(409, 'checkin_conflict');
        if (data?.code === '22023' || data?.code === '23514') throw error(400, 'invalid_request');
        throw error(502, 'unavailable');
      }
      send(200, project(body.action, data));
    } catch (e) {
      if (e.status === 429) res.setHeader('Retry-After', '60');
      send(e.status || 503, { error: e.status ? e.code : 'unavailable' });
    }
  };
}
export default createHandler();
