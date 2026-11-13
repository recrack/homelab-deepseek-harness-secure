/** Forward only explicit public retrieval arguments to the isolated approval collector. */
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { WebError } from '@deepseek-ai/dsh-web';

function invalid() { return new WebError('Public collector returned an invalid response', 'COLLECTOR_INVALID_RESPONSE'); }
function object(value, keys) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)); }
function httpUrl(value) {
  if (typeof value !== 'string' || value.length > 16384) return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}

/** Accept one fixed private IPv4 listener; DNS, redirects and credentials are never used. */
export function collectorAddress(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('DSH_COLLECTOR_URL must be a private IPv4 HTTP URL on port 8080'); }
  const parts = url.hostname.split('.').map(Number);
  if (url.protocol !== 'http:' || isIP(url.hostname) !== 4 || !(parts[0] === 10 || parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168) || url.port !== '8080' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('DSH_COLLECTOR_URL must be a private IPv4 HTTP URL on port 8080');
  return url;
}

/** Validate collector JSON at the process boundary before exposing it to a session. */
export function validateCollectorResult(operation, result) {
  if (operation === 'fetch') {
    if (!object(result, ['url', 'statusCode', 'body', 'truncated']) || !httpUrl(result.url) || !Number.isInteger(result.statusCode) || result.statusCode < 100 || result.statusCode > 599 || typeof result.truncated !== 'boolean' || !object(result.body, ['kind', 'content']) || !['html', 'text'].includes(result.body.kind) || typeof result.body.content !== 'string') throw invalid();
  } else {
    if (!object(result, ['sources', 'truncated', 'content']) || typeof result.truncated !== 'boolean' || result.content !== undefined && typeof result.content !== 'string' || !Array.isArray(result.sources) || result.sources.length > 100) throw invalid();
    for (const source of result.sources) if (!object(source, ['url', 'title', 'snippet', 'publishedAt']) || !httpUrl(source.url) || ['title', 'snippet', 'publishedAt'].some(key => source[key] !== undefined && typeof source[key] !== 'string')) throw invalid();
  }
  return result;
}

/** Build the provider with a fixed endpoint and bounded JSON transport, independent of proxy env. */
export function createPublicProvider({ url, timeoutMs = 360000, maxResponseBytes = 8000000, request = httpRequest }) {
  const endpoint = collectorAddress(url);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error('Invalid public collector transport limits');
  const execute = (operation, payload, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new WebError('Public retrieval cancelled', 'WEB_ABORTED'));
    const data = JSON.stringify(payload);
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    const abort = () => { outgoing.destroy(); finish(new WebError('Public retrieval cancelled', 'WEB_ABORTED')); };
    const outgoing = request({ hostname: endpoint.hostname, port: 8080, path: '/' + operation, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 || !response.headers['content-type']?.startsWith('application/json')) {
        response.destroy(); finish(invalid()); return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxResponseBytes) { response.destroy(); finish(new WebError('Public collector response exceeded its limit', 'COLLECTOR_RESPONSE_TOO_LARGE')); }
        else chunks.push(chunk);
      });
      response.on('error', () => finish(new WebError('Public collector response was interrupted', 'COLLECTOR_UNAVAILABLE')));
      response.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200) {
            if (!object(result, ['error']) || !object(result.error, ['code', 'message']) || typeof result.error.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(result.error.code) || typeof result.error.message !== 'string' || result.error.message.length > 500) throw invalid();
            throw new WebError(result.error.message, result.error.code);
          }
          finish(undefined, validateCollectorResult(operation, result));
        } catch (error) { finish(error instanceof WebError ? error : invalid()); }
      });
    });
    outgoing.on('error', () => finish(new WebError('Public collector could not be reached', 'COLLECTOR_UNAVAILABLE')));
    timer = setTimeout(() => { outgoing.destroy(); finish(new WebError('Public retrieval approval or request timed out', 'COLLECTOR_TIMEOUT')); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else outgoing.end(data);
  });
  return {
    id: 'public-collector', available: () => true,
    fetch: (request, signal) => execute('fetch', { url: request.url }, signal),
    search: (request, signal) => execute('search', { query: request.query, ...(request.maxResults === undefined ? {} : { maxResults: request.maxResults }) }, signal),
  };
}

/** Own both registrations through Cordis disposal. */
export default class PublicWebProvider {
  static inject = ['web'];
  constructor(ctx) {
    const provider = createPublicProvider({ url: process.env.DSH_COLLECTOR_URL, timeoutMs: Number(process.env.DSH_COLLECTOR_PROXY_TIMEOUT_MS ?? 360000), maxResponseBytes: Number(process.env.DSH_COLLECTOR_PROXY_MAX_BYTES ?? 8000000) });
    ctx.effect(() => ctx.web.registerFetchProvider(provider));
    ctx.effect(() => ctx.web.registerSearchProvider(provider));
  }
}
