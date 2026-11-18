/** Real loopback engine checks; no public network or model requests. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createLocalSearch, localSearchAddress } from './local-search.mjs';
import { createCollector } from './collector.mjs';

const token = 'test-control-token-with-at-least-32-characters';

async function engine(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('only the selected approved query is sent; combined results alternate and deduplicate', async t => {
  const calls = [];
  const make = name => engine(t, (req, res) => {
    calls.push({ name, url: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: [{ url: 'https://example.com/shared', title: 'Shared', content: 'Public snippet' }, { url: `https://example.com/${name}`, title: name }] }));
  });
  const search = createLocalSearch({ searxngUrl: await make('searxng'), rustxngUrl: await make('rustxng') });
  const result = await search({ query: '한글 documentation', maxResults: 2 });
  assert.deepEqual(result.sources.map(row => row.url), ['https://example.com/shared', 'https://example.com/searxng']);
  assert.equal(result.truncated, true);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    const url = new URL(call.url, 'http://local');
    assert.equal(url.searchParams.get('q'), '한글 documentation');
    assert.deepEqual([...url.searchParams.keys()], ['q', 'format', 'max_results']);
    assert.equal(call.cookie, undefined); assert.equal(call.authorization, undefined);
  }
  await search({ query: 'rustxng: public text', maxResults: 1 });
  assert.equal(calls.length, 3); assert.equal(calls[2].name, 'rustxng');
  assert.equal(new URL(calls[2].url, 'http://local').searchParams.get('q'), 'public text');
  await assert.rejects(search({ query: 'searxng: ', maxResults: 1 }), /empty/);
});

test('configuration rejects public, credential-bearing, named and redirected endpoints', () => {
  for (const value of ['https://127.0.0.1/', 'http://example.com/', 'http://8.8.8.8/', 'http://user:pass@127.0.0.1/', 'http://127.0.0.1/search', 'http://127.0.0.1/?q=x']) assert.throws(() => localSearchAddress(value));
  assert.equal(localSearchAddress('http://172.22.0.2:8080').hostname, '172.22.0.2');
});

test('empty result sets succeed while malformed responses fail', async t => {
  const empty = await engine(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"results":[]}'); });
  const result = await createLocalSearch({ searxngUrl: empty, rustxngUrl: empty })({ query: 'searxng: test', maxResults: 1 });
  assert.deepEqual(result.sources, []);
  assert.equal(result.content, 'No results from search engines: searxng');
  for (const response of [{ status: 302, body: '{}' }, { status: 200, body: 'invalid' }, { status: 200, body: '{"results":[{"url":"file:///secret","title":"bad"}]}' }, { status: 200, body: '{"results":[{"url":"https://example.com","title":3}]}' }]) {
    let calls = 0;
    const url = await engine(t, (req, res) => { calls++; res.writeHead(response.status, { 'Content-Type': 'application/json', Location: 'https://example.com/' }); res.end(response.body); });
    const search = createLocalSearch({ searxngUrl: url, rustxngUrl: url });
    await assert.rejects(search({ query: 'searxng: test', maxResults: 1 }), /Local search/);
    assert.equal(calls, 1);
  }
});

test('a failed engine does not discard results from the other engine', async t => {
  const failed = await engine(t, (_req, res) => { res.writeHead(503); res.end(); });
  const healthy = await engine(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"results":[{"url":"https://example.com/healthy","title":"Healthy result"}]}'); });
  const search = createLocalSearch({ searxngUrl: failed, rustxngUrl: healthy });
  const result = await search({ query: 'test', maxResults: 2 });
  assert.deepEqual(result.sources, [{ url: 'https://example.com/healthy', title: 'Healthy result' }]);
  assert.equal(result.content, 'Search engines: searxng, rustxng. Unavailable: searxng');
});

test('all failed engines report safe engine-specific failures', async t => {
  const failed = await engine(t, (_req, res) => { res.writeHead(503); res.end(); });
  const search = createLocalSearch({ searxngUrl: failed, rustxngUrl: failed });
  await assert.rejects(search({ query: 'private search text', maxResults: 1 }), error => {
    assert.equal(error.code, 'SEARCH_UNAVAILABLE');
    assert.match(error.message, /searxng \(Local search engine returned an unexpected response\)/);
    assert.match(error.message, /rustxng \(Local search engine returned an unexpected response\)/);
    assert.doesNotMatch(error.message, /private search text/);
    return true;
  });
});

test('oversized, timed out and cancelled engines terminate requests', async t => {
  const large = await engine(t, (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('x'.repeat(100)); });
  await assert.rejects(createLocalSearch({ searxngUrl: large, rustxngUrl: large, maxBytes: 10 })({ query: 'searxng: test', maxResults: 1 }), /Local search/);
  const hanging = await engine(t, () => {});
  const search = createLocalSearch({ searxngUrl: hanging, rustxngUrl: hanging, timeoutMs: 30 });
  await assert.rejects(search({ query: 'searxng: test', maxResults: 1 }), /Local search/);
  const abort = new AbortController();
  const result = search({ query: 'searxng: test', maxResults: 1 }, abort.signal);
  abort.abort(); await assert.rejects(result, /cancelled/);
});

test('collector returns healthy engine results when its sibling fails', async t => {
  const failing = await engine(t, (_req, res) => { res.writeHead(500); res.end(); });
  const healthy = await engine(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"results":[{"url":"https://example.com/healthy","title":"Healthy result"}]}'); });
  const collector = createCollector({ token, provider: { fetch: async () => { throw new Error('Fetch must not run'); } }, search: createLocalSearch({ searxngUrl: failing, rustxngUrl: healthy }) });
  for (const server of [collector.api, collector.control]) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => collector.close());
  const resultPromise = fetch(`http://127.0.0.1:${collector.api.address().port}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'public test', maxResults: 2 }) });
  let requests = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`http://127.0.0.1:${collector.control.address().port}/requests`, { headers: { Authorization: 'Bearer ' + token } });
    requests = await response.json();
    if (requests.length) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(requests.length, 1);
  await fetch(`http://127.0.0.1:${collector.control.address().port}/requests/${requests[0].id}/allow`, { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  const result = await resultPromise;
  assert.equal(result.status, 200);
  assert.deepEqual((await result.json()).sources, [{ url: 'https://example.com/healthy', title: 'Healthy result' }]);
});
