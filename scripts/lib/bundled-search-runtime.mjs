import fs from 'node:fs';
import path from 'node:path';

export const OFFICIAL_SEARCH_PLUGIN_ID = 'duckduckgo';
export const OFFICIAL_SEARCH_PACKAGE = '@openclaw/duckduckgo-plugin';
export const OFFICIAL_SEARCH_RUNTIME_ENTRY = 'node_modules/openclaw/dist/extensions/duckduckgo/dist/index.js';

export function officialSearchPluginSpec(version) {
  if (!/^\d{4}\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
    throw new Error('official search plugin requires an explicit release version');
  }
  return `${OFFICIAL_SEARCH_PACKAGE}@${version}`;
}

function validatePlugin(plugin, version) {
  const metadata = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'openclaw.plugin.json'), 'utf8'));
  if (metadata.name !== OFFICIAL_SEARCH_PACKAGE || manifest.id !== OFFICIAL_SEARCH_PLUGIN_ID) {
    throw new Error('official package identity mismatch for search plugin');
  }
  if (metadata.version !== version) throw new Error('official search plugin version mismatch');
  if (!manifest.contracts?.webSearchProviders?.includes(OFFICIAL_SEARCH_PLUGIN_ID)) {
    throw new Error('official search plugin search contract is missing');
  }
  if (Object.keys(metadata.dependencies ?? {}).length > 0) {
    throw new Error('official search plugin runtime dependencies changed; review packaging before bundling');
  }
  if (
    metadata.openclaw?.runtimeExtensions?.length !== 1 ||
    metadata.openclaw.runtimeExtensions[0] !== './dist/index.js' ||
    !fs.existsSync(path.join(plugin, 'dist/index.js'))
  ) {
    throw new Error('official search plugin compiled runtime entry is missing');
  }
}

export function bundleOfficialSearchPlugin(stageRoot) {
  const host = path.join(stageRoot, 'node_modules/openclaw');
  const version = JSON.parse(fs.readFileSync(path.join(host, 'package.json'), 'utf8')).version;
  officialSearchPluginSpec(version);
  const plugin = path.join(stageRoot, 'node_modules/@openclaw/duckduckgo-plugin');
  const destination = path.join(host, 'dist/extensions/duckduckgo');
  validatePlugin(plugin, version);
  if (fs.existsSync(destination)) validatePlugin(destination, version);
  fs.cpSync(plugin, destination, { recursive: true });
  if (!fs.existsSync(path.join(destination, 'LICENSE'))) {
    fs.copyFileSync(path.join(host, 'LICENSE'), path.join(destination, 'LICENSE'));
  }
  return { entry: OFFICIAL_SEARCH_RUNTIME_ENTRY, patchId: `official-duckduckgo-${version}` };
}
