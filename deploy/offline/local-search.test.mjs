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

test('bad responses and either failed engine fail visibly without another search fallback', async t => {
  for (const response of [{ status: 302, body: '{}' }, { status: 200, body: 'invalid' }, { status: 200, body: '{"results":[]}' }, { status: 200, body: '{"results":[{"url":"file:///secret","title":"bad"}]}' }, { status: 200, body: '{"results":[{"url":"https://example.com","title":3}]}' }]) {
    let calls = 0;
    const url = await engine(t, (req, res) => { calls++; res.writeHead(response.status, { 'Content-Type': 'application/json', Location: 'https://example.com/' }); res.end(response.body); });
    const search = createLocalSearch({ searxngUrl: url, rustxngUrl: url });
    await assert.rejects(search({ query: 'searxng: test', maxResults: 1 }), /Local search/);
    assert.equal(calls, 1);
  }
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

test('collector cancels the other engine when one engine fails', async t => {
  let started, closed;
  const ready = new Promise(resolve => { started = resolve; });
  const ended = new Promise(resolve => { closed = resolve; });
  const hanging = await engine(t, (req, res) => { res.on('close', closed); started(); });
  const failing = await engine(t, async (req, res) => { await ready; res.writeHead(500); res.end(); });
  const collector = createCollector({ token, provider: { fetch: async () => { throw new Error('Fetch must not run'); } }, search: createLocalSearch({ searxngUrl: failing, rustxngUrl: hanging }) });
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
  assert.equal(result.status, 502);
  let timer;
  try { await Promise.race([ended, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Sibling request was not cancelled')), 1000); })]); }
  finally { clearTimeout(timer); }
});
