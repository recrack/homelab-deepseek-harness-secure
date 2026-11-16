/** Local-only HTTP fixtures exercise the collector wire protocol. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import PublicWebProvider, { collectorAddress, createEngineSearchProvider, createPublicProvider, validateCollectorResult } from './web-provider.mjs';

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

test('engine choices use DSH search providers and forward only the selected engine through the collector', async () => {
  const calls = [];
  const result = { sources: [], truncated: false };
  const collector = {
    available: () => true,
    search: (request, signal) => { calls.push({ request, signal }); return Promise.resolve(result); },
  };
  const controller = new AbortController();
  for (const engine of ['searxng', 'rustxng']) {
    const provider = createEngineSearchProvider(collector, engine);
    assert.equal(provider.id, `dsh-${engine}`);
    assert.equal(provider.available(), true);
    assert.strictEqual(await provider.search({ query: 'current weather', maxResults: 4 }, controller.signal), result);
    assert.deepEqual(calls.at(-1).request, { query: `${engine}: current weather`, maxResults: 4 });
    assert.equal(calls.at(-1).signal, controller.signal);
  }
  assert.throws(() => createEngineSearchProvider(collector, 'other'), /Unsupported local search engine/);
});

test('Cordis registration exposes all choices in the DSH provider lists and disposes them', () => {
  const search = [], fetch = [], disposers = [];
  const register = providers => provider => {
    providers.push(provider);
    return () => providers.splice(providers.indexOf(provider), 1);
  };
  const keys = ['DSH_COLLECTOR_URL', 'DSH_COLLECTOR_PROXY_TIMEOUT_MS', 'DSH_COLLECTOR_PROXY_MAX_BYTES'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.DSH_COLLECTOR_URL = 'http://172.30.0.3:8080';
  process.env.DSH_COLLECTOR_PROXY_TIMEOUT_MS = '360000';
  process.env.DSH_COLLECTOR_PROXY_MAX_BYTES = '8000000';
  try {
    new PublicWebProvider({
      web: { registerSearchProvider: register(search), registerFetchProvider: register(fetch) },
      effect: setup => { disposers.push(setup()); },
    });
    assert.deepEqual(search.map(({ id, title }) => [id, title]), [
      ['public-collector', 'SearXNG + RustXNG'],
      ['dsh-searxng', 'SearXNG'],
      ['dsh-rustxng', 'RustXNG'],
    ]);
    assert.deepEqual(fetch.map(({ id, title }) => [id, title]), [['public-collector', 'Approved public fetch']]);
  } finally {
    for (const dispose of disposers.reverse()) dispose();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
  assert.deepEqual(search, []);
  assert.deepEqual(fetch, []);
});

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
