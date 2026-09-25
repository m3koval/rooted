import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler, project, validateBody } from '../api/display.js';
const id = '11111111-1111-4111-8111-111111111111';
const token = 'a'.repeat(64);
const env = { NODE_ENV: 'production', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-server-secret', DISPLAY_ORIGIN: 'https://rooted.example' };
const good = () => ({ event: { id, name: 'Fictional Event', date: '2026-09-25' }, attendance_count: 1, participants: [{ id, name: 'Fictional Child', points: 35, present: true }], updated_at: '2026-09-25T18:00:00.123456+00:00' });
const body = { action: 'display', payload: {} };
const headers = { host: 'rooted.example', origin: 'https://rooted.example', 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-rooted-device-token': token };
async function invoke(handler, changes = {}) {
  const req = { method: 'POST', url: '/api/display', headers: { ...headers, ...changes.headers }, body, socket: { remoteAddress: '127.0.0.1' }, ...changes };
  req.headers = { ...headers, ...changes.headers };
  const res = { headers: {}, setHeader(k,v) { this.headers[k] = v; }, end(v) { this.body = JSON.parse(v); } };
  await handler(req, res);
  assert.equal(res.headers['Cache-Control'], 'no-store, max-age=0');
  assert.equal(res.headers['CDN-Cache-Control'], 'no-store');
  assert.equal(res.headers['Vercel-CDN-Cache-Control'], 'no-store');
  assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
  return res;
}
function fixture(data = good(), status = 200) {
  const calls = [];
  const handler = createHandler({ env, fetchImpl: async (...args) => { calls.push(args); return new Response(JSON.stringify(data), { status }); } });
  return { handler, calls };
}
test('service-only RPC request and minimized response contract', async () => {
  const input = good(); input.secret = 'private'; input.event.secret = 'private'; input.participants[0].date_of_birth = '2012-01-01'; input.participants[0].parent_guardian_email = 'private@example.invalid';
  const { handler, calls } = fixture(input);
  const r = await invoke(handler);
  assert.equal(r.statusCode, 200); assert.deepEqual(r.body, good());
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0][0]), 'https://example.supabase.co/rest/v1/rpc/rooted_display');
  assert.deepEqual(JSON.parse(calls[0][1].body), { p_token: token });
  assert.equal(calls[0][1].headers.Authorization, 'Bearer test-server-secret');
  assert.equal(calls[0][1].cache, 'no-store'); assert.equal(calls[0][1].redirect, 'error');
  assert.ok(calls[0][1].signal instanceof AbortSignal);
});
for (const [label, changes, status] of [
  ['GET', { method: 'GET' }, 405], ['OPTIONS', { method: 'OPTIONS' }, 405],
  ['query token', { url: '/api/display?token=secret' }, 400],
  ['cross origin', { headers: { origin: 'https://evil.example' } }, 403],
  ['no origin', { headers: { origin: undefined } }, 403],
  ['cross-site metadata', { headers: { 'sec-fetch-site': 'cross-site' } }, 403],
  ['missing device', { headers: { 'x-rooted-device-token': undefined } }, 403],
  ['malformed device', { headers: { 'x-rooted-device-token': 'bad' } }, 403],
  ['wrong content type', { headers: { 'content-type': 'text/plain' } }, 415],
  ['compressed body', { headers: { 'content-encoding': 'gzip' } }, 415],
  ['oversized declared body', { headers: { 'content-length': '1025' } }, 413],
  ['oversized parsed body', { body: ' '.repeat(1025) }, 413],
  ['malformed JSON', { body: '{' }, 400], ['null', { body: null }, 400],
  ['array', { body: [] }, 400], ['extra top-level', { body: { ...body, event_id: id } }, 400],
  ['extra payload', { body: { action: 'display', payload: { event_id: id } } }, 400],
  ['mutating action', { body: { action: 'checkin', payload: {} } }, 400],
]) test(`reject ${label} before network`, async () => {
  const { handler, calls } = fixture(); const r = await invoke(handler, changes);
  assert.equal(r.statusCode, status); assert.equal(calls.length, 0);
});
for (const code of ['42501', '22023']) test(`authorization SQLSTATE ${code} clears authority with 403`, async () => {
  const { handler } = fixture({ code, message: 'SECRET DATABASE CONTENT', details: 'PRIVATE' }, 400);
  const r = await invoke(handler); assert.equal(r.statusCode, 403); assert.deepEqual(r.body, { error: 'leader_required_or_expired' });
});
test('upstream errors never leak details', async () => {
  const { handler } = fixture({ code: 'XX000', message: 'SECRET' }, 500);
  assert.deepEqual((await invoke(handler)).body, { error: 'unavailable' });
});
for (const [label, mutate] of [
  ['bad points', v => v.participants[0].points = '35'], ['unsafe points', v => v.participants[0].points = 2 ** 54],
  ['bad presence', v => v.participants[0].present = 'true'], ['count mismatch', v => v.attendance_count = 2],
  ['bad timestamp', v => v.updated_at = 'yesterday'], ['duplicate ids', v => v.participants.push(v.participants[0])],
  ['bad event', v => v.event.id = 'bad'], ['oversized name', v => v.participants[0].name = 'x'.repeat(81)],
  ['roster bound', v => v.participants = Array(2001).fill(v.participants[0])],
]) test(`fail closed on ${label}`, async () => {
  const value = good(); mutate(value); const { handler } = fixture(value);
  const r = await invoke(handler); assert.equal(r.statusCode, 502); assert.deepEqual(r.body, { error: 'unavailable' });
});
test('zero and negative points retained', () => {
  for (const points of [0, -3]) { const v = good(); v.participants[0].points = points; assert.equal(project(v).participants[0].points, points); }
  validateBody(body);
});
test('streamed request limit enforced', async () => {
  const { handler, calls } = fixture(); const stream = Readable.from([' '.repeat(1025)]);
  stream.method='POST'; stream.url='/api/display'; stream.headers=headers;
  const res = { setHeader() {}, end(v) { this.body=JSON.parse(v); } };
  await handler(stream,res); assert.equal(res.statusCode,413); assert.equal(calls.length,0);
});
test('streamed upstream limit enforced', async () => {
  const handler = createHandler({ env, fetchImpl: async () => new Response(' '.repeat(1048577)) });
  const r = await invoke(handler); assert.equal(r.statusCode,502);
});
test('network failure is generic unavailable', async () => {
  const handler = createHandler({ env, fetchImpl: async () => { throw new Error('SECRET'); } });
  const r = await invoke(handler); assert.equal(r.statusCode,503); assert.deepEqual(r.body,{ error: 'unavailable' });
});
test('device rate cap and retry header', async () => {
  const { handler, calls } = fixture();
  for (let i=0;i<90;i++) assert.equal((await invoke(handler)).statusCode,200);
  const r = await invoke(handler); assert.equal(r.statusCode,429); assert.equal(r.headers['Retry-After'],'60'); assert.equal(calls.length,90);
});
test('missing server configuration fails closed', async () => {
  const handler = createHandler({ env: { ...env, SUPABASE_SERVICE_ROLE_KEY: '' }, fetchImpl: () => { throw Error('must not fetch'); } });
  assert.equal((await invoke(handler)).statusCode,503);
});
