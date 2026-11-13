/** Check deployment changes without copying the shipped preset definitions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presetPatches } from './prepare-presets.mjs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

test('minimal standard preset retains shipped plugin configuration', async () => {
  const requireInclude = createRequire(new URL('../../vendor/include/package.json', import.meta.url));
  const { parseEntryYaml } = requireInclude('./lib/index.js');
  const parse = async path => parseEntryYaml(await readFile(new URL(path, import.meta.url), 'utf8'));
  const shipped = (await parse('../../packages/bundle/web-app/presets/standard.patch.yml'))[0].insert[0].config.plugins;
  const local = (await presetPatches()).find(row => row.id === 'preset-standard').config.plugins;
  const browser = local.find(row => row.id === 'dsh-browser');
  assert.equal(browser.name, '/opt/dsh-deps/dsh-browser/lib/index.js');
  assert.deepEqual(browser.config.allowedOrigins, []);
  for (const row of local.filter(row => !['tool-web', 'dsh-browser'].includes(row.id))) {
    const original = shipped.find(candidate => candidate.id === row.id);
    assert.ok(original, row.id);
    assert.deepEqual(row.config, original.config, row.id);
  }
});

test('historical PTC and Cordis presets keep tools and wait for external approval', async () => {
  const patches = await presetPatches();
  assert.deepEqual(patches.map(row => row.id), ['preset-standard', 'preset-ptc', 'preset-cordis']);
  for (const patch of patches) {
    const rows = patch.config.plugins;
    assert.ok(rows.some(row => row.id === 'tool-bash'));
    assert.ok(rows.some(row => row.id === 'delegation'));
    const web = rows.find(row => row.id === 'tool-web');
    assert.equal(web.config.searchTimeoutMs, 370000);
    assert.equal(web.config.fetchTimeoutMs, 370000);
    assert.deepEqual(rows.find(row => row.id === 'tool-pwsh').disabled, { __jsExpr: "process.platform !== 'win32'" });
    assert.deepEqual(rows.find(row => row.id === 'dsh-browser').config.allowedOrigins, []);
  }
});
