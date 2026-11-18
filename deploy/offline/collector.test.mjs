/** Collector protocol checks use local listeners and an injected provider; no public requests. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createCollector, limitsFromEnvironment, validatePayload } from './collector.mjs';

const token = 'test-control-token-with-at-least-32-characters';
function call(port, path, { method = 'GET', body, authorized = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path, method, headers: {
      ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
      ...(authorized ? { Authorization: 'Bearer ' + token } : {}),
    } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject); req.end(data);
  });
}
async function setup(t, options = {}) {
  const calls = [];
  const collector = createCollector({ token, provider: { async fetch(payload, signal) {
    calls.push(payload); assert.equal(signal.aborted, false);
    return { url: payload.url, statusCode: 200, body: { kind: 'text', content: 'public fixture' }, truncated: false };
  } }, ...options });
  for (const server of [collector.api, collector.control]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => collector.close());
  return { collector, calls, api: collector.api.address().port, control: collector.control.address().port };
}
async function pending(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await call(port, '/requests', { authorized: true });
    if (result.body.length) return result.body[0];
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('No approval request appeared');
}

test('only the exact frozen URL leaves after explicit approval; no context fields accepted', async t => {
  const { api, control, calls } = await setup(t);
  const url = 'https://example.com/?q=%ED%95%9C%EA%B8%80&value=user-selected';
  const result = call(api, '/fetch', { method: 'POST', body: { url } });
  const row = await pending(control);
  assert.deepEqual(row.payload, { url }); assert.equal(row.operation, 'fetch'); assert.equal(calls.length, 0);
  assert.equal((await call(control, '/requests')).status, 401);
  assert.equal((await call(control, `/requests/${row.id}/allow`, { method: 'POST', authorized: true })).status, 200);
  assert.equal((await result).status, 200); assert.deepEqual(calls, [{ url }]);
  for (const field of ['headers', 'cookies', 'body', 'code', 'messages', 'authorization']) {
    const rejected = await call(api, '/fetch', { method: 'POST', body: { url, [field]: 'private' } });
    assert.equal(rejected.status, 400);
  }
  assert.equal(calls.length, 1);
});

test('local search runs only after approval and rejects private context fields', async t => {
  const searched = [];
  const { api, control } = await setup(t, { search: async payload => {
    searched.push(payload); return { sources: [{ url: 'https://example.com/', title: 'Public' }], truncated: false };
  } });
  const result = call(api, '/search', { method: 'POST', body: { query: 'rustxng: public documentation', maxResults: 2 } });
  const row = await pending(control);
  assert.equal(searched.length, 0);
  await call(control, `/requests/${row.id}/allow`, { method: 'POST', authorized: true });
  assert.equal((await result).status, 200);
  assert.deepEqual(searched, [{ query: 'rustxng: public documentation', maxResults: 2 }]);
  for (const field of ['code', 'messages', 'logs', 'headers', 'cookies']) assert.equal((await call(api, '/search', { method: 'POST', body: { query: 'public', [field]: 'PRIVATE' } })).status, 400);
  assert.equal(searched.length, 1);
});

test('auto-approval skips search only; public fetch still requires approval', async t => {
  const searched = [];
  const { api, control, calls } = await setup(t, {
    autoApproveSearch: true,
    search: async payload => {
      searched.push(payload);
      return { sources: [{ url: 'https://example.com/', title: 'Public result' }], truncated: false };
    },
  });
  const search = await call(api, '/search', { method: 'POST', body: { query: 'public query', maxResults: 1 } });
  assert.equal(search.status, 200);
  assert.deepEqual(searched, [{ query: 'public query', maxResults: 1 }]);
  assert.deepEqual((await call(control, '/requests', { authorized: true })).body, []);

  const fetch = call(api, '/fetch', { method: 'POST', body: { url: 'https://example.com/' } });
  const row = await pending(control);
  assert.equal(row.operation, 'fetch');
  assert.deepEqual(calls, []);
  await call(control, `/requests/${row.id}/allow`, { method: 'POST', authorized: true });
  assert.equal((await fetch).status, 200);
  assert.deepEqual(calls, [{ url: 'https://example.com/' }]);
});

test('denied, expired and cancelled requests send nothing and leave no queue entry', async t => {
  const { api, control, calls } = await setup(t, { search: async () => { throw new Error('Denied search must not run'); }, limits: { ...limitsFromEnvironment({}), APPROVAL_TIMEOUT_MS: 100 } });
  let result = call(api, '/search', { method: 'POST', body: { query: '공개 문서 검색', maxResults: 2 } });
  let row = await pending(control);
  assert.equal((await call(control, `/requests/${row.id}/deny`, { method: 'POST', authorized: true })).status, 200);
  assert.equal((await result).body.error.code, 'APPROVAL_DENIED');
  result = call(api, '/fetch', { method: 'POST', body: { url: 'https://example.com/' } });
  await pending(control);
  assert.equal((await result).body.error.code, 'APPROVAL_TIMEOUT');
  assert.deepEqual((await call(control, '/requests', { authorized: true })).body, []);
  assert.deepEqual(calls, []);
});

test('strict limits reject credentials and unknown values before queueing', () => {
  const limits = limitsFromEnvironment({});
  for (const input of [{ url: 'https://user:secret@example.com/' }, { url: 'file:///private' }, { url: 'x' }, { url: 'https://example.com', headers: {} }]) assert.throws(() => validatePayload('/fetch', input, limits));
  for (const input of [{ query: '' }, { query: 'x', maxResults: 11 }, { query: 'x', maxResults: 0 }, { query: 'x', messages: [] }]) assert.throws(() => validatePayload('/search', input, limits));
  assert.throws(() => limitsFromEnvironment({ DSH_COLLECTOR_TIMEOUT_MS: '0' }));
  assert.throws(() => createCollector({ token: 'short', provider: { fetch() {} } }));
  assert.throws(() => createCollector({ token, provider: {} }), /fetch provider is required/);
  assert.throws(() => createCollector({ token, provider: { fetch() {} }, autoApproveSearch: '1' }), /boolean/);
});

test('queue capacity and complete lifecycle cancellation keep network untouched', async t => {
  const { collector, api, control, calls } = await setup(t, { limits: { ...limitsFromEnvironment({}), MAX_PENDING: 1 } });
  const result = call(api, '/fetch', { method: 'POST', body: { url: 'https://example.com' } }).catch(error => error);
  await pending(control);
  assert.equal((await call(api, '/fetch', { method: 'POST', body: { url: 'https://example.com/other' } })).body.error.code, 'QUEUE_FULL');
  await collector.close(); await result;
  assert.deepEqual(calls, []);
});

test('DeepSeek domains are rejected before they enter the approval queue or fetch provider', async t => {
  const { api, control, calls } = await setup(t);
  for (const url of ['https://deepseek.com/', 'https://api.deepseek.com/v1/chat/completions', 'https://www.deepseek.com/', 'https://api.deepseek.com./']) {
    assert.equal((await call(api, '/fetch', { method: 'POST', body: { url } })).status, 403);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual((await call(control, '/requests', { authorized: true })).body, []);
});

test('search without configured local engines fails without queuing or fetching publicly', async t => {
  const { api, control, calls } = await setup(t);
  const result = await call(api, '/search', { method: 'POST', body: { query: 'public documentation' } });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'LOCAL_SEARCH_UNAVAILABLE');
  assert.deepEqual((await call(control, '/requests', { authorized: true })).body, []);
  assert.deepEqual(calls, []);
});

test('client disconnect cancels a pending approval before public retrieval', async t => {
  const { api, control, calls } = await setup(t);
  const data = JSON.stringify({ url: 'https://example.com/' });
  const client = request({ host: '127.0.0.1', port: api, path: '/fetch', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } });
  client.on('error', () => {}); client.end(data);
  await pending(control); client.destroy();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await call(control, '/requests', { authorized: true })).body.length) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.deepEqual((await call(control, '/requests', { authorized: true })).body, []);
  assert.deepEqual(calls, []);
});

test('approved search sends only its displayed query to the selected local provider', async t => {
  const searched = [];
  const { api, control, calls } = await setup(t, { search: async payload => {
    searched.push(payload);
    return { sources: [{ url: 'https://example.com/', title: 'Public result' }], truncated: false };
  } });
  const query = '공개 문서 & API';
  const result = call(api, '/search', { method: 'POST', body: { query, maxResults: 1 } });
  const row = await pending(control);
  assert.deepEqual(row.payload, { query, maxResults: 1 }); assert.deepEqual(calls, []);
  await call(control, `/requests/${row.id}/allow`, { method: 'POST', authorized: true });
  assert.equal((await result).status, 200);
  assert.deepEqual(searched, [{ query, maxResults: 1 }]);
  assert.deepEqual(calls, []);
});
