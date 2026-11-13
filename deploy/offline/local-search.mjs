/** Query fixed local engines with approved text; never attach agent context or credentials. */
import { request } from 'node:http';
import { isIP } from 'node:net';

function failure(message) { return Object.assign(new Error(message), { code: 'SEARCH_UNAVAILABLE', status: 502 }); }

/** Accept only a fixed HTTP listener on a loopback or RFC1918 IPv4 address. */
export function localSearchAddress(value) {
  const url = new URL(value);
  const [a, b] = url.hostname.split('.').map(Number);
  if (url.protocol !== 'http:' || isIP(url.hostname) !== 4 || !(a === 127 || a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Search engine must be a fixed private IPv4 HTTP listener');
  return url;
}

function readResults(endpoint, query, maxResults, signal, timeoutMs, maxBytes) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ q: query, format: 'json', max_results: String(maxResults) });
    const req = request({ hostname: endpoint.hostname, port: endpoint.port || 80, path: '/search?' + params, method: 'GET', signal, headers: { Accept: 'application/json' } }, response => {
      if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('application/json')) {
        response.destroy(); reject(failure('Local search engine returned an unexpected response')); return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) response.destroy(failure('Local search response exceeded its limit'));
        else chunks.push(chunk);
      });
      response.on('error', () => reject(failure('Local search response was interrupted')));
      response.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!Array.isArray(data.results)) throw failure('Local search returned invalid JSON results');
          const sources = data.results.map(row => {
            if (!row || typeof row.url !== 'string' || typeof row.title !== 'string' || row.content !== undefined && typeof row.content !== 'string') throw failure('Local search returned invalid result fields');
            const url = new URL(row.url);
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw failure('Local search returned an invalid result URL');
            return { url: url.href, title: row.title.slice(0, 1000), ...(row.content === undefined ? {} : { snippet: row.content.slice(0, 2000) }) };
          });
          if (!sources.length) throw failure('Local search returned no results');
          resolve(sources);
        } catch { reject(failure('Local search returned invalid or empty results')); }
      });
    });
    const timer = setTimeout(() => req.destroy(failure('Local search timed out')), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => reject(failure(signal?.aborted ? 'Local search cancelled' : 'Local search connection failed')));
    req.end();
  });
}

/** Search both engines, or select one with `searxng:` / `rustxng:` in the approved query. */
export function createLocalSearch({ searxngUrl, rustxngUrl, timeoutMs = 30000, maxBytes = 5000000 }) {
  const endpoints = { searxng: localSearchAddress(searxngUrl), rustxng: localSearchAddress(rustxngUrl) };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid local search limits');
  return async ({ query, maxResults }, signal) => {
    const choice = /^(searxng|rustxng):\s*/i.exec(query);
    const names = choice ? [choice[1].toLowerCase()] : Object.keys(endpoints);
    const text = choice ? query.slice(choice[0].length) : query;
    if (!text.trim()) throw Object.assign(new Error('Search text must not be empty'), { code: 'INVALID_QUERY', status: 400 });
    const batches = await Promise.all(names.map(name => readResults(endpoints[name], text, maxResults, signal, timeoutMs, maxBytes)));
    const sources = [], seen = new Set();
    // Alternate ranks so one engine cannot occupy the entire result budget.
    for (let rank = 0; rank < Math.max(...batches.map(rows => rows.length)); rank++) for (const rows of batches) {
      const row = rows[rank];
      if (row && !seen.has(row.url)) { seen.add(row.url); sources.push(row); }
    }
    return { sources: sources.slice(0, maxResults), truncated: sources.length > maxResults, content: 'Search engines: ' + names.join(', ') };
  };
}
