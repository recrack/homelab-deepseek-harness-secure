/** Local-only HTTP fixtures exercise the collector wire protocol. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { collectorAddress, createPublicProvider, validateCollectorResult } from './web-provider.mjs';

async function fixture(t, handler, options = {}) {
  const seen = [];
  const server = createServer(async (request, response) => {
    let data = ''; for await (const chunk of request) data += chunk;
    seen.push({ path: request.url, headers: request.headers, body: JSON.parse(data) });
    handler(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const provider = createPublicProvider({ url: 'http://172.30.0.3:8080', request: (args, callback) => httpRequest({ ...args, hostname: '127.0.0.1', port: server.address().port }, callback), ...options });
  return { provider, seen };
}
const fetchResult = { url: 'https://example.com/', statusCode: 200, body: { kind: 'text', content: 'public' }, truncated: false };
function reply(response, value, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); }

test('explicit URL/query alone cross the collector boundary, without private context or auth', async t => {
  const { provider, seen } = await fixture(t, response => reply(response, fetchResult));
  assert.deepEqual(await provider.fetch({ url: 'https://example.com/', messages: ['private'], headers: { Authorization: 'secret' } }), fetchResult);
  assert.deepEqual(seen[0].body, { url: 'https://example.com/' });
  assert.equal(seen[0].headers.authorization, undefined); assert.equal(seen[0].headers.cookie, undefined);
  const search = await fixture(t, response => reply(response, { sources: [{ url: 'https://example.com/' }], truncated: false }));
  await search.provider.search({ query: '공개 검색', maxResults: 2, code: 'private', session: 'private' });
  assert.deepEqual(search.seen[0].body, { query: '공개 검색', maxResults: 2 });
  assert.equal(search.seen[0].path, '/search');
});

test('collector URL cannot select public DNS, credentials, a different port or arbitrary route', () => {
  assert.equal(collectorAddress('http://10.0.0.1:8080').hostname, '10.0.0.1');
  for (const url of ['https://172.30.0.3:8080', 'http://example.com:8080', 'http://8.8.8.8:8080', 'http://127.0.0.1:8080', 'http://172.30.0.3:8081', 'http://user:secret@172.30.0.3:8080', 'http://172.30.0.3:8080/other', 'http://172.30.0.3:8080/?x=y']) assert.throws(() => collectorAddress(url));
});

test('bounded and validated responses reject malformed JSON, foreign fields and redirects', async t => {
  for (const body of [{ ...fetchResult, extra: 'private' }, { ...fetchResult, body: { kind: 'binary', content: 'x' } }, { error: { code: 'APPROVAL_DENIED', message: 'Denied' } }]) {
    const { provider } = await fixture(t, response => reply(response, body));
    await assert.rejects(provider.fetch({ url: 'https://example.com/' }), { code: 'COLLECTOR_INVALID_RESPONSE' });
  }
  const oversized = await fixture(t, response => reply(response, fetchResult), { maxResponseBytes: 5 });
  await assert.rejects(oversized.provider.fetch({ url: 'https://example.com/' }), { code: 'COLLECTOR_RESPONSE_TOO_LARGE' });
  const redirect = await fixture(t, response => { response.writeHead(302, { Location: 'https://example.com/' }); response.end(); });
  await assert.rejects(redirect.provider.fetch({ url: 'https://example.com/' }), { code: 'COLLECTOR_INVALID_RESPONSE' });
  assert.throws(() => validateCollectorResult('search', { sources: [{ url: 'file:///private' }], truncated: false }));
});

test('structured denial is preserved without arbitrary upstream errors', async t => {
  const { provider } = await fixture(t, response => reply(response, { error: { code: 'APPROVAL_DENIED', message: 'User denied public retrieval' } }, 403));
  await assert.rejects(provider.fetch({ url: 'https://example.com/' }), { code: 'APPROVAL_DENIED', message: 'User denied public retrieval' });
});

test('cancellation and elapsed transport deadline terminate waiting HTTP requests', async t => {
  const { provider, seen } = await fixture(t, () => {}, { timeoutMs: 500 });
  const controller = new AbortController();
  const pending = provider.fetch({ url: 'https://example.com/' }, controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: 'WEB_ABORTED' });
  const expired = await fixture(t, () => {}, { timeoutMs: 10 });
  await assert.rejects(expired.provider.fetch({ url: 'https://example.com/' }), { code: 'COLLECTOR_TIMEOUT' });
  assert.equal(seen.length, 0);
});
