/** Anonymous public retrieval, isolated from workspaces and released according to the operator's approval setting. */
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup, Resolver } from 'node:dns';
import { createRequire } from 'node:module';
import { BlockList, isIP } from 'node:net';
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http';
import { createLocalSearch } from './local-search.mjs';

/** Read deployment limits once; malformed limits fail before any listener opens. */
export function limitsFromEnvironment(env = process.env) {
  const defaults = { MAX_BODY: 8192, MAX_URL: 4096, MAX_QUERY: 1000, MAX_RESULTS: 10, MAX_PENDING: 32, APPROVAL_TIMEOUT_MS: 300000, MAX_RESPONSE_BYTES: 5000000, MAX_BODY_CHARS: 524288, TIMEOUT_MS: 30000, MAX_REDIRECTS: 5 };
  const limits = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = Number(env[`DSH_COLLECTOR_${key}`] ?? fallback);
    if (!Number.isSafeInteger(value) || value < (key === 'MAX_REDIRECTS' ? 0 : 1) || value > 2147483647) throw new Error(`Invalid collector limit ${key}`);
    limits[key] = value;
  }
  if (limits.MAX_PENDING > 32) throw new Error('Collector approval queue must not exceed 32');
  return limits;
}

function failure(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }

const nonPublic = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) nonPublic.addSubnet(address, prefix);

function publicIPv4(address) {
  return isIP(address) === 4 && !nonPublic.check(address);
}

// Check the addresses handed to the connection, so a second DNS lookup cannot change the destination.
function makePublicLookup(server) {
  const resolver = server === undefined ? undefined : new Resolver({ timeout: 2500, tries: 2 });
  if (resolver !== undefined) {
    if (!publicIPv4(server)) throw new Error('DSH_COLLECTOR_DNS_SERVER must be a public IPv4 address');
    resolver.setServers([server]);
  }
  return (hostname, options, callback) => {
    const resolved = (error, addresses) => {
      if (error) return callback(error);
      if (addresses.length === 0 || addresses.some(({ address }) => !publicIPv4(address))) {
        return callback(failure('DESTINATION_BLOCKED', 'Public retrieval requires a public IPv4 destination', 403));
      }
      if (options.all) return callback(null, addresses);
      return callback(null, addresses[0].address, 4);
    };
    if (resolver === undefined) return lookup(hostname, { all: true, family: 4 }, resolved);
    resolver.resolve4(hostname, (error, addresses) => resolved(error, addresses?.map(address => ({ address, family: 4 }))));
  };
}

/** Validate only the public request fields; never accept headers, accounts, or upload bodies. */
export function validatePayload(route, value, limits) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw failure('INVALID_REQUEST', 'Expected a JSON object');
  const allowed = route === '/fetch' ? ['url'] : ['query', 'maxResults'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw failure('INVALID_REQUEST', 'Unexpected request field');
  if (route === '/fetch') {
    if (typeof value.url !== 'string' || !value.url.length || value.url.length > limits.MAX_URL) throw failure('INVALID_URL', 'URL length is invalid');
    let url;
    try { url = new URL(value.url); } catch { throw failure('INVALID_URL', 'Expected an HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure('INVALID_URL', 'Expected a credential-free HTTP(S) URL');
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const address = hostname.replace(/^\[|\]$/g, '');
    if (isIP(address) && !publicIPv4(address)) throw failure('DESTINATION_BLOCKED', 'Public retrieval requires a public IPv4 destination', 403);
    if (hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com')) throw failure('DESTINATION_BLOCKED', 'DeepSeek domains are blocked', 403);
    return Object.freeze({ url: value.url });
  }
  if (typeof value.query !== 'string' || !value.query.trim() || value.query.length > limits.MAX_QUERY) throw failure('INVALID_QUERY', 'Query length is invalid');
  const maxResults = value.maxResults ?? limits.MAX_RESULTS;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > limits.MAX_RESULTS) throw failure('INVALID_REQUEST', 'Result count is invalid');
  return Object.freeze({ query: value.query, maxResults });
}

const PAGE = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'"><title>외부 검색 승인</title><style>body{font:16px system-ui;max-width:850px;margin:40px auto;padding:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere}article{border:1px solid #888;padding:16px;margin:16px 0}button{margin-right:12px;padding:8px}</style><h1>외부 검색 승인</h1><p>아래 검색어 또는 URL만 외부 공개 사이트로 보냅니다. 코드·대화·로그는 첨부하지 않습니다.</p><p id="status"></p><main></main><script>
const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);const headers={Authorization:'Bearer '+token};let busy=false;
async function refresh(){if(busy)return;busy=true;try{const r=await fetch('/requests',{headers});if(!r.ok)throw Error('승인 토큰을 확인하세요');const rows=await r.json();document.querySelector('main').replaceChildren();document.querySelector('#status').textContent=rows.length?'전송 내용을 확인한 뒤 승인하세요.':'대기 중인 요청이 없습니다.';for(const row of rows){const article=document.createElement('article'),pre=document.createElement('pre');pre.textContent=JSON.stringify({operation:row.operation,...row.payload},null,2);article.append(pre);for(const [action,label]of [['allow','허용'],['deny','거부']]){const button=document.createElement('button');button.textContent=label;button.onclick=async()=>{button.disabled=true;try{await fetch('/requests/'+row.id+'/'+action,{method:'POST',headers});}finally{await refresh();}};article.append(button);}document.querySelector('main').append(article);}}catch(e){document.querySelector('#status').textContent=e.message;}finally{busy=false;}}
refresh();setInterval(refresh,1500);</script></html>`;

/** Create both HTTP listeners; dependencies can be replaced by a local fake in tests. */
export function createCollector({ provider, search, token, limits = limitsFromEnvironment(), autoApproveSearch = false }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('CONTROL_TOKEN must contain at least 32 characters');
  if (!provider || typeof provider.fetch !== 'function') throw new Error('HTTP fetch provider is required');
  if (typeof autoApproveSearch !== 'boolean') throw new Error('Search auto-approval setting must be a boolean');
  const pending = new Map(), active = new Set();
  let closing = false;
  const send = (response, status, body) => {
    if (response.destroyed || response.writableEnded) return;
    const data = JSON.stringify(body);
    response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', 'Connection': 'close' });
    response.end(data);
  };
  const readJson = async request => {
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json' || request.headers['transfer-encoding']) throw failure('INVALID_REQUEST', 'Expected bounded application/json');
    let size = 0, chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limits.MAX_BODY) throw failure('REQUEST_TOO_LARGE', 'Request body is too large', 413);
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('INVALID_REQUEST', 'Invalid JSON'); }
  };
  const approve = (operation, payload, signal) => {
    if (autoApproveSearch) return Promise.resolve();
    return new Promise((resolve, reject) => {
      if (pending.size >= limits.MAX_PENDING) return reject(failure('QUEUE_FULL', 'Approval queue is full', 429));
      const id = randomUUID();
      const finish = error => {
        clearTimeout(timer); signal.removeEventListener('abort', abort); pending.delete(id);
        error ? reject(error) : resolve();
      };
      const abort = () => finish(failure('REQUEST_CANCELLED', 'Request was cancelled', 499));
      const timer = setTimeout(() => finish(failure('APPROVAL_TIMEOUT', 'Approval expired', 408)), limits.APPROVAL_TIMEOUT_MS);
      pending.set(id, { operation, payload, finish });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  };
  const api = createServer(async (request, response) => {
    const controller = new AbortController(); active.add(controller);
    response.on('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      if (closing) throw failure('CLOSING', 'Collector is stopping', 503);
      if (request.method !== 'POST' || !['/fetch', '/search'].includes(request.url)) throw failure('NOT_FOUND', 'Unknown operation', 404);
      if (request.url === '/search' && typeof search !== 'function') throw failure('LOCAL_SEARCH_UNAVAILABLE', 'Configure private local search engines before searching', 503);
      const payload = validatePayload(request.url, await readJson(request), limits);
      await approve(request.url.slice(1), payload, controller.signal);
      controller.signal.throwIfAborted();
      const result = request.url === '/fetch'
        ? await provider.fetch(payload, controller.signal)
        : await search(payload, controller.signal);
      send(response, 200, result);
    } catch (error) {
      send(response, error.status ?? 502, { error: { code: error.code ?? 'RETRIEVAL_FAILED', message: error.status ? error.message : 'Public retrieval failed or was blocked' } });
    } finally { controller.abort(); active.delete(controller); }
  });
  const control = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' }); response.end(PAGE); return;
    }
    const supplied = Buffer.from(request.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Approval token required' } });
    if (request.method === 'GET' && request.url === '/requests') return send(response, 200, [...pending].map(([id, item]) => ({ id, operation: item.operation, payload: item.payload })));
    const match = /^\/requests\/([a-f0-9-]+)\/(allow|deny)$/.exec(request.url ?? '');
    if (request.method !== 'POST' || !match || request.headers['transfer-encoding'] || Number(request.headers['content-length'] ?? 0) !== 0) return send(response, 400, { error: { code: 'INVALID_REQUEST', message: 'Expected an empty approval action' } });
    const item = pending.get(match[1]);
    if (!item) return send(response, 404, { error: { code: 'NOT_FOUND', message: 'Pending request not found' } });
    item.finish(match[2] === 'deny' ? failure('APPROVAL_DENIED', 'User denied public retrieval', 403) : undefined);
    send(response, 200, { ok: true });
  });
  for (const server of [api, control]) { server.requestTimeout = limits.TIMEOUT_MS; server.headersTimeout = Math.min(10000, limits.TIMEOUT_MS); }
  return { api, control, async close() {
    closing = true;
    for (const controller of active) controller.abort();
    await Promise.all([api, control].map(server => new Promise((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    })));
  } };
}

/** Start the collector only through its DSH profile, with disposal owned by Cordis. */
export default class PublicCollector {
  constructor(ctx) {
    const limits = limitsFromEnvironment();
    const autoApproveSearchValue = process.env.DSH_AUTO_APPROVE_SEARCH ?? '0';
    if (autoApproveSearchValue !== '0' && autoApproveSearchValue !== '1') throw new Error('DSH_AUTO_APPROVE_SEARCH must be 0 or 1');
    const { Agent, getGlobalDispatcher, setGlobalDispatcher } = createRequire(import.meta.resolve('@deepseek-ai/dsh-web-fetch-http'))('undici');
    const dispatcher = new Agent({ connect: { lookup: makePublicLookup(process.env.DSH_COLLECTOR_DNS_SERVER) } });
    const userAgent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';
    const provider = new HttpFetchProvider({ maxResponseBytes: limits.MAX_RESPONSE_BYTES, maxBodyChars: limits.MAX_BODY_CHARS, timeoutMs: limits.TIMEOUT_MS, maxRedirects: limits.MAX_REDIRECTS, userAgent });
    const search = process.env.DSH_SEARXNG_URL || process.env.DSH_RUSTXNG_URL
      ? createLocalSearch({ searxngUrl: process.env.DSH_SEARXNG_URL, rustxngUrl: process.env.DSH_RUSTXNG_URL, timeoutMs: limits.TIMEOUT_MS, maxBytes: limits.MAX_RESPONSE_BYTES }) : undefined;
    const collector = createCollector({ provider, search, token: process.env.CONTROL_TOKEN, limits, autoApproveSearch: autoApproveSearchValue === '1' });
    ctx.effect(async () => {
      const previous = getGlobalDispatcher();
      setGlobalDispatcher(dispatcher);
      const close = async () => {
        setGlobalDispatcher(previous);
        await collector.close();
        await dispatcher.destroy();
      };
      try {
        for (const [server, port] of [[collector.api, 8080], [collector.control, 8081]]) await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '0.0.0.0', resolve); });
      } catch (error) { await close(); throw error; }
      return close;
    });
  }
}
