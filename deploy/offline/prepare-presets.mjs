/** Preserve shipped preset compositions while applying deployment-only tool limits. */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireInclude = createRequire(new URL('../../vendor/include/package.json', import.meta.url));
const { parseEntryYaml, stringifyEntryYaml } = requireInclude('./lib/index.js');
const pluginIds = new Set(['dsh-browser', 'dsh-context', 'dsh-claude-artifacts', 'dsh-claude-design', 'dsh-crew']);

/** Read current shipped presets, retaining deferred Loader expressions and every other row. */
export async function presetPatches(activePluginIds = []) {
  if (!Array.isArray(activePluginIds) || activePluginIds.some(id => typeof id !== 'string' || !pluginIds.has(id))) {
    throw new Error('Invalid active offline plugin ids');
  }
  const browserEnabled = activePluginIds.includes('dsh-browser');
  const patches = [];
  for (const id of ['standard', 'ptc', 'cordis']) {
    const source = new URL(`../../packages/bundle/web-app/presets/${id}.patch.yml`, import.meta.url);
    const rows = parseEntryYaml(await readFile(source, 'utf8'));
    const preset = rows.flatMap(row => row.insert ?? []).find(row => row.id === `preset-${id}`);
    if (!preset || !Array.isArray(preset.config?.plugins)) throw new Error(`Missing shipped preset ${id}`);
    const web = preset.config.plugins.filter(row => row.id === 'tool-web');
    if (web.length !== 1) throw new Error(`Expected one Web tool in preset ${id}`);
    web[0].config = { ...web[0].config, searchTimeoutMs: 370000, fetchTimeoutMs: 370000 };
    const pluginManagerTool = preset.config.plugins.filter(row => row.id === 'tool-plugin-manager');
    if (pluginManagerTool.length !== 1) throw new Error(`Expected one Plugin Manager tool in preset ${id}`);
    pluginManagerTool[0].disabled = true;
    const browser = preset.config.plugins.filter(row => row.id === 'dsh-browser');
    if (browser.length > 1) throw new Error(`Expected at most one browser plugin in preset ${id}`);
    if (browserEnabled && browser.length === 0) {
      preset.config.plugins.push({
        id: 'dsh-browser',
        name: '/opt/homelab-dsh-plugins/packages/dsh-browser/lib/index.js',
        config: {
          allowedOrigins: JSON.parse(process.env.DSH_BROWSER_ALLOWED_ORIGINS || '[]'),
          idleTimeoutMs: 900000,
        },
      });
    } else if (browserEnabled) {
      browser[0].name = '/opt/homelab-dsh-plugins/packages/dsh-browser/lib/index.js';
      browser[0].config = {
        ...browser[0].config,
        allowedOrigins: JSON.parse(process.env.DSH_BROWSER_ALLOWED_ORIGINS || '[]'),
        idleTimeoutMs: browser[0].config?.idleTimeoutMs ?? 900000,
      };
    } else if (browser.length === 1) {
      preset.config.plugins = preset.config.plugins.filter(row => row.id !== 'dsh-browser');
    }
    if (browserEnabled) {
      const browserPlugin = preset.config.plugins.find(row => row.id === 'dsh-browser');
      browserPlugin.isolate = { ...browserPlugin.isolate, zsevenBrowserDriver: true };
    }
    patches.push({ id: preset.id, config: preset.config });
  }
  return patches;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const activePluginIds = JSON.parse(process.env.DSH_OFFLINE_ACTIVE_PLUGINS || '[]');
  await writeFile(process.argv[2], stringifyEntryYaml(await presetPatches(activePluginIds)), { mode: 0o600 });
}
