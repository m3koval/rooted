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
  if (!object(body) || !['context', 'search', 'person', 'checkin'].includes(body.action)) throw error(400, 'invalid_request');
  const mutation = body.action === 'checkin';
  if (!keys(body, mutation ? ['action', 'payload', 'request_id'] : ['action', 'payload'])) throw error(400, 'invalid_request');
  const p = body.payload;
  const valid = body.action === 'context' ? keys(p, [])
    : body.action === 'search' ? keys(p, ['query']) && text(p.query, 80) && !/[\u0000-\u001f\u007f]/.test(p.query)
    : body.action === 'person' ? keys(p, ['participant_id']) && uuid(p.participant_id)
    : keys(p, ['participant_id', 'bible', 'chapters']) && uuid(p.participant_id) && typeof p.bible === 'boolean' && integer(p.chapters) && uuid(body.request_id);
  if (!valid) throw error(400, 'invalid_request');
  return { p_action: body.action, p_payload: p, p_request_id: mutation ? body.request_id : null };
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

// Minimize success data even if a future RPC accidentally adds private fields.
function receipt(r) {
  if (!object(r) || !uuid(r.checkin_id) || !Number.isSafeInteger(r.earned_points) || !Array.isArray(r.components) || r.components.length > 8) throw error(502, 'unavailable');
  return { checkin_id: r.checkin_id, earned_points: r.earned_points, components: r.components.map(c => {
    if (!object(c) || !text(c.label, 80) || !Number.isSafeInteger(c.points)) throw error(502, 'unavailable');
    return { label: c.label, points: c.points };
  }) };
}
function person(p) {
  if (!object(p) || !uuid(p.id) || !text(p.name, 80)) throw error(502, 'unavailable');
  return { id: p.id, name: p.name };
}
function project(action, value, requestId) {
  if (!object(value)) throw error(502, 'unavailable');
  if (action === 'context') {
    const e = value.event, r = value.rates;
    if (!object(e) || !uuid(e.id) || !text(e.name, 100) || !text(e.date, 10) || !text(e.reading_week, 10) || !object(r) || !['attendance', 'bible', 'friend'].every(k => Number.isInteger(r[k]) && r[k] >= 0 && r[k] <= 1000)) throw error(502, 'unavailable');
    return { event: { id: e.id, name: e.name, date: e.date, reading_week: e.reading_week }, rates: { attendance: r.attendance, bible: r.bible, friend: r.friend } };
  }
  if (action === 'search') {
    if (!Array.isArray(value.matches) || value.matches.length > 8 || typeof value.truncated !== 'boolean') throw error(502, 'unavailable');
    return { matches: value.matches.map(person), truncated: value.truncated };
  }
  if (action === 'person') {
    if (typeof value.already_checked_in !== 'boolean' || typeof value.needs_leader !== 'boolean' || !integer(value.prior_chapters)) throw error(502, 'unavailable');
    return { person: person(value.person), already_checked_in: value.already_checked_in, needs_leader: value.needs_leader, prior_chapters: value.prior_chapters, receipt: value.receipt === null ? null : receipt(value.receipt) };
  }
  if (value.request_id !== requestId || value.action !== 'kiosk.checkin' || !object(value.result) || typeof value.result.duplicate !== 'boolean') throw error(502, 'unavailable');
  return { request_id: value.request_id, action: 'kiosk.checkin', result: { duplicate: value.result.duplicate, receipt: receipt(value.result.receipt) } };
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
      const token = req.headers['x-rooted-device-token'];
      if (typeof token !== 'string' || !TOKEN.test(token)) throw error(403, 'forbidden');
      charge('device:' + createHash('sha256').update(token).digest('hex'), 90);
      const body = await readBody(req);
      const args = validateBody(body);
      let base;
      try { base = new URL(env.SUPABASE_URL); } catch { throw error(503, 'unavailable'); }
      if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || (base.pathname !== '/' && base.pathname !== '') || !env.SUPABASE_SERVICE_ROLE_KEY) throw error(503, 'unavailable');
      const upstream = await fetchImpl(new URL('/rest/v1/rpc/rooted_kiosk', base), {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
        body: JSON.stringify({ p_token: token, ...args }),
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
      send(200, project(body.action, data, body.request_id));
    } catch (e) {
      if (e.status === 429) res.setHeader('Retry-After', '60');
      send(e.status || 503, { error: e.status ? e.code : 'unavailable' });
    }
  };
}
export default createHandler();
