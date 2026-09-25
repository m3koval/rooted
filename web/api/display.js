import { createHash } from 'node:crypto';

// Server-only: never import this module into the browser bundle.
export const config = { api: { bodyParser: false } };
const MAX_REQUEST = 1024, MAX_RESPONSE = 1048576, MAX_PARTICIPANTS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, expected) => object(v) && Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));
const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const uuid = v => typeof v === 'string' && UUID.test(v);
const error = (status, code) => Object.assign(new Error(code), { status, code });
export function validateBody(body) {
  if (!keys(body, ['action', 'payload']) || body.action !== 'display' || !keys(body.payload, [])) throw error(400, 'invalid_request');
}
export function project(value) {
  const e = value?.event;
  if (!object(value) || !object(e) || !uuid(e.id) || !text(e.name, 100) || typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)
    || !Number.isSafeInteger(value.attendance_count) || value.attendance_count < 0
    || !Array.isArray(value.participants) || value.participants.length > MAX_PARTICIPANTS
    || typeof value.updated_at !== 'string' || value.updated_at.length > 40
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.updated_at)
    || !Number.isFinite(Date.parse(value.updated_at))) throw error(502, 'unavailable');
  const ids = new Set();
  const participants = value.participants.map(p => {
    if (!object(p) || !uuid(p.id) || !text(p.name, 80) || !Number.isSafeInteger(p.points) || typeof p.present !== 'boolean' || ids.has(p.id)) throw error(502, 'unavailable');
    ids.add(p.id);
    return { id: p.id, name: p.name, points: p.points, present: p.present };
  });
  if (participants.filter(p => p.present).length !== value.attendance_count) throw error(502, 'unavailable');
  // Explicit allowlist drops any future private fields at every nesting level.
  return { event: { id: e.id, name: e.name, date: e.date }, attendance_count: value.attendance_count, participants, updated_at: value.updated_at };
}
async function readBody(req) {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > MAX_REQUEST)) throw error(413, 'request_too_large');
  let raw;
  if (req.body !== undefined) {
    raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    if (raw.length > MAX_REQUEST) throw error(413, 'request_too_large');
  } else {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > MAX_REQUEST) throw error(413, 'request_too_large');
      chunks.push(bytes);
    }
    raw = Buffer.concat(chunks);
  }
  try { return JSON.parse(raw.toString('utf8')); } catch { throw error(400, 'invalid_request'); }
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
    for (const [key, value] of Object.entries({ 'Cache-Control': 'no-store, max-age=0', 'CDN-Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })) res.setHeader(key, value);
    const send = (status, data) => { res.statusCode = status; res.end(JSON.stringify(data)); };
    try {
      charge('global', 600);
      const ip = env.VERCEL === '1' ? req.headers['x-vercel-forwarded-for'] || req.socket?.remoteAddress : req.socket?.remoteAddress;
      charge('ip:' + createHash('sha256').update(String(ip || 'unknown')).digest('hex'), 120);
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw error(405, 'method_not_allowed'); }
      if (typeof req.url !== 'string' || req.url.includes('?')) throw error(400, 'invalid_request');
      const host = req.headers.host;
      if (typeof host !== 'string' || !/^[a-z0-9.-]+(?::\d+)?$/i.test(host)) throw error(403, 'forbidden');
      const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
      const expected = env.DISPLAY_ORIGIN || env.KIOSK_ORIGIN || `${local && env.NODE_ENV !== 'production' ? 'http' : 'https'}://${host}`;
      if (req.headers.origin !== expected || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) throw error(403, 'forbidden');
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '') || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) throw error(415, 'unsupported_media_type');
      const token = req.headers['x-rooted-device-token'];
      if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw error(403, 'forbidden');
      charge('device:' + createHash('sha256').update(token).digest('hex'), 90);
      validateBody(await readBody(req));
      let base;
      try { base = new URL(env.SUPABASE_URL); } catch { throw error(503, 'unavailable'); }
      if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/' || !env.SUPABASE_SERVICE_ROLE_KEY) throw error(503, 'unavailable');
      const upstream = await fetchImpl(new URL('/rest/v1/rpc/rooted_display', base), {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify({ p_token: token }),
      });
      const reader = upstream.body?.getReader();
      if (!reader) throw error(502, 'unavailable');
      const decoder = new TextDecoder(); let raw = '', size = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE) { await reader.cancel(); throw error(502, 'unavailable'); }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
      let data; try { data = JSON.parse(raw); } catch { throw error(502, 'unavailable'); }
      if (!upstream.ok) {
        if (data?.code === '42501' || data?.code === '22023') throw error(403, 'leader_required_or_expired');
        throw error(502, 'unavailable');
      }
      send(200, project(data));
    } catch (e) {
      if (e.status === 429) res.setHeader('Retry-After', '60');
      send(e.status || 503, { error: e.status ? e.code : 'unavailable' });
    }
  };
}
export default createHandler();
