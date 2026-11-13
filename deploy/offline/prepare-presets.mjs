/** Preserve shipped preset compositions while applying deployment-only tool limits. */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireInclude = createRequire(new URL('../../vendor/include/package.json', import.meta.url));
const { parseEntryYaml, stringifyEntryYaml } = requireInclude('./lib/index.js');

/** Read current shipped presets, retaining deferred Loader expressions and every other row. */
export async function presetPatches() {
  const patches = [];
  for (const id of ['standard', 'ptc', 'cordis']) {
    const source = new URL(`../../packages/bundle/web-app/presets/${id}.patch.yml`, import.meta.url);
    const rows = parseEntryYaml(await readFile(source, 'utf8'));
    const preset = rows.flatMap(row => row.insert ?? []).find(row => row.id === `preset-${id}`);
    if (!preset || !Array.isArray(preset.config?.plugins)) throw new Error(`Missing shipped preset ${id}`);
    const web = preset.config.plugins.filter(row => row.id === 'tool-web');
    if (web.length !== 1) throw new Error(`Expected one Web tool in preset ${id}`);
    web[0].config = { ...web[0].config, searchTimeoutMs: 370000, fetchTimeoutMs: 370000 };
    const browser = preset.config.plugins.filter(row => row.id === 'dsh-browser');
    if (browser.length > 1) throw new Error(`Expected at most one browser plugin in preset ${id}`);
    if (browser.length === 0) {
      preset.config.plugins.push({
        id: 'dsh-browser',
        name: '/opt/dsh-deps/dsh-browser/lib/index.js',
        config: {
          allowedOrigins: JSON.parse(process.env.DSH_BROWSER_ALLOWED_ORIGINS || '[]'),
          idleTimeoutMs: 900000,
        },
      });
    }
    patches.push({ id: preset.id, config: preset.config });
  }
  return patches;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(process.argv[2], stringifyEntryYaml(await presetPatches()), { mode: 0o600 });
}
