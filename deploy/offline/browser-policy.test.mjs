import assert from 'node:assert/strict';
import { test } from 'node:test';
import LocalBrowserPolicy from './browser-policy.mjs';

test('browser requests stay on origin and teardown unregisters the transform', () => {
  let transform;
  let disposed = false;
  let cleanup;
  new LocalBrowserPolicy({
    effect: callback => { cleanup = callback(); },
    webServer: { tapIndex: callback => { transform = callback; return () => { disposed = true; }; } },
  });
  const html = transform('<html><head><title>DSH</title></head><body></body></html>');
  assert.match(html, /connect-src 'self';/);
  assert.match(html, /img-src 'self' data: blob:;/);
  assert.match(html, /x-dns-prefetch-control/);
  assert.throws(() => transform('<body></body>'), /requires an HTML head/);
  cleanup();
  assert.equal(disposed, true);
});
