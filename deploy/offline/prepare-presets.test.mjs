/** Check deployment changes without copying the shipped preset definitions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presetPatches } from './prepare-presets.mjs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

test('offline presets keep Plugin Manager tools disabled without a Host provider', async () => {
  const patches = await presetPatches();
  for (const patch of patches) {
    const pluginManagerTool = patch.config.plugins.find(row => row.id === 'tool-plugin-manager');
    assert.equal(pluginManagerTool?.disabled, true, patch.id);
  }
});

test('browser tools are only mounted for a selected plugin', async () => {
  const requireInclude = createRequire(new URL('../../vendor/include/package.json', import.meta.url));
  const { parseEntryYaml } = requireInclude('./lib/index.js');
  const parse = async path => parseEntryYaml(await readFile(new URL(path, import.meta.url), 'utf8'));
  const shipped = (await parse('../../packages/bundle/web-app/presets/standard.patch.yml'))[0].insert[0].config.plugins;
  const inactive = (await presetPatches()).find(row => row.id === 'preset-standard').config.plugins;
  assert.equal(inactive.some(row => row.id === 'dsh-browser'), false);

  const local = (await presetPatches(['dsh-browser'])).find(row => row.id === 'preset-standard').config.plugins;
  const browser = local.find(row => row.id === 'dsh-browser');
  assert.equal(browser.name, '/opt/homelab-dsh-plugins/packages/dsh-browser/lib/index.js');
  assert.deepEqual(browser.isolate, { zsevenBrowserDriver: true });
  assert.equal(browser.config.engine, 'chromium');
  assert.deepEqual(browser.config.allowedOrigins, []);
  for (const row of local.filter(row => !['tool-web', 'dsh-browser', 'persona'].includes(row.id))) {
    const original = shipped.find(candidate => candidate.id === row.id);
    assert.ok(original, row.id);
    assert.deepEqual(row.config, original.config, row.id);
  }
});

test('Camoufox selection is passed into each generated preset without changing the default', async () => {
  const previous = process.env.DSH_BROWSER_ENGINE;
  process.env.DSH_BROWSER_ENGINE = 'camoufox';
  try {
    const patches = await presetPatches(['dsh-browser']);
    for (const patch of patches) {
      assert.equal(patch.config.plugins.find(row => row.id === 'dsh-browser').config.engine, 'camoufox', patch.id);
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_BROWSER_ENGINE;
    else process.env.DSH_BROWSER_ENGINE = previous;
  }
});

test('historical PTC and Cordis presets keep tools and wait for external approval', async () => {
  const patches = await presetPatches(['dsh-browser']);
  assert.deepEqual(patches.map(row => row.id), ['preset-standard', 'preset-ptc', 'preset-cordis']);
  for (const patch of patches) {
    const rows = patch.config.plugins;
    assert.ok(rows.some(row => row.id === 'tool-bash'));
    assert.ok(rows.some(row => row.id === 'delegation'));
    const persona = rows.find(row => row.id === 'persona');
    assert.match(persona.config.suffix, /launch announcement/, patch.id);
    const web = rows.find(row => row.id === 'tool-web');
    assert.equal(web.config.searchTimeoutMs, 370000);
    assert.equal(web.config.fetchTimeoutMs, 370000);
    assert.deepEqual(rows.find(row => row.id === 'tool-pwsh').disabled, { __jsExpr: "process.platform !== 'win32'" });
    const browser = rows.find(row => row.id === 'dsh-browser');
    assert.deepEqual(browser.config.allowedOrigins, []);
    assert.deepEqual(browser.isolate, { zsevenBrowserDriver: true });
  }
});

test('rejects plugin ids outside the offline catalog', async () => {
  await assert.rejects(presetPatches(['unknown']), /Invalid active offline plugin ids/);
});

test('accepts each Open Artifacts feature ID without adding a custom preset row', async () => {
  const ids = [
    'dsh-claude-slides',
    'dsh-claude-design',
    'dsh-claude-design-system',
    'dsh-claude-data',
    'dsh-claude-motion',
    'dsh-claude-whiteboard',
  ];
  const patches = await presetPatches(ids);
  assert.deepEqual(patches.map(patch => patch.id), ['preset-standard', 'preset-ptc', 'preset-cordis']);
  for (const patch of patches) assert.equal(patch.config.plugins.some(row => ids.includes(row.id)), false);
});

test('Hermes preset only enables browser tools when the persisted selection includes them', async () => {
  const requireInclude = createRequire(new URL('../../vendor/include/package.json', import.meta.url));
  const { parseEntryYaml } = requireInclude('./lib/index.js');
  const rows = parseEntryYaml(await readFile(new URL('./hermes.patch.yml', import.meta.url), 'utf8'));
  const preset = rows.flatMap(row => row.insert ?? []).find(row => row.id === 'preset-hermes-qwen');
  const browser = preset.config.plugins.find(row => row.id === 'dsh-browser');
  assert.equal(browser.name, '/opt/homelab-dsh-plugins/packages/dsh-browser/lib/index.js');
  assert.deepEqual(browser.isolate, { zsevenBrowserDriver: true });
  assert.equal(browser.config.engine.__jsExpr, "process.env.DSH_BROWSER_ENGINE || 'chromium'");
  assert.equal(browser.disabled.__jsExpr, "JSON.parse(process.env.DSH_OFFLINE_ACTIVE_PLUGINS || '[]').includes('dsh-browser') === false");
});
