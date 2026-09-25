import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler, validateBody } from '../web/api/kiosk.js';

const token = 'a'.repeat(64), id = '11111111-1111-4111-8111-111111111111';
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-server-only-key', NODE_ENV: 'production' };
const context = { event: { id, name: 'Event', date: '2026-09-25', reading_week: '2026-09-21' }, rates: { attendance: 5, bible: 2, friend: 10 } };
const receipt = { checkin_id: id, earned_points: 8, components: [{ label: 'Attendance', points: 5 }, { label: 'Bible reading', points: 3 }] };
function request(options = {}) {
  const { raw, headers, ...rest } = options;
  const req = Readable.from(raw === undefined ? [] : [raw]);
  Object.assign(req, { method: 'POST', url: '/api/kiosk', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'rooted.example', origin: 'https://rooted.example', 'content-type': 'application/json', 'x-rooted-device-token': token, 'sec-fetch-site': 'same-origin', ...headers }, ...rest });
  if (raw === undefined && !Object.hasOwn(rest, 'body')) req.body = { action: 'context', payload: {} };
  return req;
}
async function invoke(handler, req = request()) {
  const headers = {}; let text;
  const res = { setHeader: (k, v) => headers[k.toLowerCase()] = v, end: v => text = v };
  await handler(req, res);
  assert.equal(headers['cache-control'], 'no-store, max-age=0');
  assert.equal(headers['vercel-cdn-cache-control'], 'no-store');
  assert.equal(headers['access-control-allow-origin'], undefined);
  return { status: res.statusCode, data: JSON.parse(text), headers };
}
function setup(result = context, upstreamStatus = 200) {
  const calls = [];
  const handler = createHandler({ env, fetchImpl: async (url, options) => { calls.push({ url: String(url), ...options }); return new Response(JSON.stringify(result), { status: upstreamStatus }); } });
  return { handler, calls };
}
test('context calls ONLY fixed RPC with server credential and header capability', async () => {
  const { handler, calls } = setup({ ...context, admin_profiles: ['must-not-leak'] });
  const r = await invoke(handler); assert.equal(r.status, 200); assert.deepEqual(r.data, context);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://example.supabase.co/rest/v1/rpc/rooted_kiosk');
  assert.deepEqual(JSON.parse(calls[0].body), { p_token: token, p_action: 'context', p_payload: {}, p_request_id: null });
  assert.equal(calls[0].headers.Authorization, 'Bearer test-server-only-key');
  assert.equal(JSON.stringify(r.data).includes('test-server-only-key'), false);
});
for (const [label, options, expected] of [
  ['GET', { method: 'GET' }, 405],
  ['missing origin', { headers: { origin: undefined } }, 403],
  ['cross origin', { headers: { origin: 'https://evil.example' } }, 403],
  ['cross site metadata', { headers: { 'sec-fetch-site': 'cross-site' } }, 403],
  ['query tokens forbidden', { url: `/api/kiosk?token=${token}` }, 400],
  ['missing token', { headers: { 'x-rooted-device-token': undefined } }, 403],
  ['uppercase token', { headers: { 'x-rooted-device-token': 'A'.repeat(64) } }, 403],
  ['duplicate token header', { headers: { 'x-rooted-device-token': [token, token] } }, 403],
  ['short token', { headers: { 'x-rooted-device-token': 'abc' } }, 403],
  ['wrong media', { headers: { 'content-type': 'text/plain' } }, 415],
  ['compressed', { headers: { 'content-encoding': 'gzip' } }, 415],
  ['declared oversize', { headers: { 'content-length': '8193' } }, 413],
  ['stream oversize', { raw: ' '.repeat(8193) }, 413],
  ['parsed oversize', { body: { action: 'search', payload: { query: 'x'.repeat(9000) } } }, 413],
  ['invalid JSON', { raw: '{' }, 400],
  ['leader action', { body: { action: 'kiosk.issue', payload: {} } }, 400],
  ['admin collection', { body: { action: 'context', payload: { collection: 'admin_profiles' } } }, 400],
  ['body token forbidden', { body: { action: 'context', payload: {}, token } }, 400],
  ['read request uuid forbidden', { body: { action: 'context', payload: {}, request_id: id } }, 400],
]) test(`reject ${label} without upstream call`, async () => {
  const { handler, calls } = setup(); const r = await invoke(handler, request(options));
  assert.equal(r.status, expected); assert.equal(calls.length, 0);
});
test('strict UUID, chapter, payload and search validation', () => {
  const valid = { action: 'checkin', request_id: id, payload: { participant_id: id, bible: true, chapters: 0 } };
  assert.equal(validateBody(valid).p_request_id, id);
  for (const invalid of [
    { ...valid, request_id: 'not-uuid' }, { ...valid, request_id: null },
    ...['3', true, -1, 1.2, 100001, null].map(chapters => ({ ...valid, payload: { ...valid.payload, chapters } })),
    { ...valid, payload: { ...valid.payload, event_id: id } },
    { ...valid, payload: { ...valid.payload, bible: 'true' } },
    { action: 'search', payload: { query: 'x'.repeat(81) } },
    { action: 'search', payload: { query: 'x\n' } },
    { action: 'person', payload: { participant_id: 'x' } },
    { action: 'context', payload: [] },
  ]) assert.throws(() => validateBody(invalid));
});
test('streamed body is parsed and checkin receipt is projected', async () => {
  const body = { action: 'checkin', request_id: id, payload: { participant_id: id, bible: true, chapters: 3 } };
  const result = { action: 'kiosk.checkin', request_id: id, result: { duplicate: false, receipt: { ...receipt, secret: 'hidden' } }, secret: 'hidden' };
  const { handler, calls } = setup(result);
  const r = await invoke(handler, request({ raw: JSON.stringify(body) }));
  assert.equal(r.status, 200); assert.deepEqual(r.data.result.receipt, receipt);
  assert.equal(JSON.parse(calls[0].body).p_request_id, id);
});
test('search and person project name-only fields', async () => {
  const search = setup({ matches: [{ id, name: 'Test Name', parent_guardian_email: 'private' }], truncated: false });
  const a = await invoke(search.handler, request({ body: { action: 'search', payload: { query: 'Te' } } }));
  assert.deepEqual(a.data, { matches: [{ id, name: 'Test Name' }], truncated: false });
  const p = setup({ person: { id, name: 'Test Name', date_of_birth: 'private' }, already_checked_in: false, needs_leader: true, prior_chapters: 0, receipt: null, profile: 'private' });
  const b = await invoke(p.handler, request({ body: { action: 'person', payload: { participant_id: id } } }));
  assert.equal(b.data.needs_leader, true); assert.equal(JSON.stringify(b.data).includes('private'), false);
});
test('safe errors do not echo DB detail, service key or capability', async () => {
  for (const [code, status] of [['42501', 403], ['23505', 409], ['22023', 400], ['XX000', 502]]) {
    const { handler } = setup({ code, message: `${token} ${env.SUPABASE_SERVICE_ROLE_KEY} private profile` }, 400);
    const r = await invoke(handler); assert.equal(r.status, status); assert.deepEqual(Object.keys(r.data), ['error']);
    assert.equal(JSON.stringify(r.data).includes(token), false);
  }
});
test('network failure and invalid success cannot fabricate a receipt', async () => {
  const h = createHandler({ env, fetchImpl: async () => { throw new Error('secret network detail'); } });
  assert.deepEqual((await invoke(h)).data, { error: 'unavailable' });
  assert.equal((await invoke(setup({ ok: true }).handler)).status, 502);
});
test('missing environment fails closed', async () => {
  let called = false;
  const h = createHandler({ env: {}, fetchImpl: () => { called = true; } });
  assert.equal((await invoke(h)).status, 503); assert.equal(called, false);
});
test('per-device limiting and window recovery', async () => {
  let time = 1000, count = 0;
  const h = createHandler({ env, now: () => time, fetchImpl: async () => { count++; return new Response(JSON.stringify(context)); } });
  for (let i = 0; i < 90; i++) assert.equal((await invoke(h)).status, 200);
  const limited = await invoke(h); assert.equal(limited.status, 429); assert.equal(limited.headers['retry-after'], '60'); assert.equal(count, 90);
  time += 60001; assert.equal((await invoke(h)).status, 200);
});
test('per-IP limit also bounds attempts with changing invalid capabilities', async () => {
  const { handler, calls } = setup();
  for (let i = 0; i < 120; i++) assert.equal((await invoke(handler, request({ headers: { 'x-rooted-device-token': 'bad' } }))).status, 403);
  assert.equal((await invoke(handler)).status, 429); assert.equal(calls.length, 0);
});
