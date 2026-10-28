import fs from 'node:fs';
import path from 'node:path';
import { LOBSTER_WINDOWS_STATE_PATCH_ID, patchLobsterWindowsStateSource } from './lobster-windows-state.mjs';

export const OFFICIAL_LOBSTER_INTEGRITY =
  'sha512-0DAcAzkwPPziCQeAjJJ5HyclQeu/zBlkqwhGjvvrDLw6sXjp2q6vTqrUjR0u4VMgBQTkLdWHDvltHyGYhL4u/Q==';
export const OFFICIAL_LOBSTER_RUNTIME_ENTRY = 'node_modules/openclaw/dist/extensions/lobster/dist/index.js';
const release = '2026.9.3';
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function officialLobsterPluginSpec(version) {
  if (version !== release) throw new Error('Official Lobster requires a reviewed host/Windows runtime version');
  return `@openclaw/lobster@${release}`;
}

export function bundleOfficialLobsterPlugin(stageRoot) {
  const host = path.join(stageRoot, 'node_modules/openclaw');
  officialLobsterPluginSpec(readJson(path.join(host, 'package.json')).version);
  const lock = readJson(path.join(stageRoot, 'node_modules/.package-lock.json'));
  const installed = lock.packages?.['node_modules/@openclaw/lobster'];
  if (installed?.version !== release || installed?.integrity !== OFFICIAL_LOBSTER_INTEGRITY)
    throw new Error('Official Lobster archive integrity is missing or changed');
  const plugin = path.join(stageRoot, 'node_modules/@openclaw/lobster');
  const metadata = readJson(path.join(plugin, 'package.json'));
  const manifest = readJson(path.join(plugin, 'openclaw.plugin.json'));
  if (metadata.name !== '@openclaw/lobster' || metadata.version !== release || manifest.id !== 'lobster')
    throw new Error('Official Lobster package identity changed');
  if (!manifest.contracts?.tools?.includes('lobster') || manifest.toolMetadata?.lobster?.optional !== true)
    throw new Error('Official Lobster optional tool contract changed');
  if (JSON.stringify(metadata.openclaw?.runtimeExtensions) !== JSON.stringify(['./dist/index.js']))
    throw new Error('Official Lobster compiled entry contract changed');
  const dependencies = { '@clawdbot/lobster': '2026.6.11', typebox: '1.3.18' };
  if (Object.keys(metadata.dependencies ?? {}).length !== 2)
    throw new Error('Official Lobster dependency contract changed');
  for (const [name, version] of Object.entries(dependencies)) {
    const dependency = readJson(path.join(plugin, 'node_modules', name, 'package.json'));
    if (metadata.dependencies[name] !== version || dependency.name !== name || dependency.version !== version)
      throw new Error(`Official Lobster bundled dependency changed: ${name}`);
  }
  const stateRelative = 'node_modules/@clawdbot/lobster/dist/src/state/store.js';
  const patchedState = patchLobsterWindowsStateSource(fs.readFileSync(path.join(plugin, stateRelative), 'utf8'));
  const destination = path.join(host, 'dist/extensions/lobster');
  if (fs.existsSync(destination)) throw new Error('Official Lobster destination already exists; use a fresh stage');
  if (!fs.existsSync(path.join(plugin, 'dist/index.js'))) throw new Error('Official Lobster compiled entry missing');
  fs.cpSync(plugin, destination, { recursive: true });
  fs.writeFileSync(path.join(destination, stateRelative), patchedState);
  if (!fs.existsSync(path.join(destination, 'LICENSE')))
    fs.copyFileSync(path.join(host, 'LICENSE'), path.join(destination, 'LICENSE'));
  return {
    entry: OFFICIAL_LOBSTER_RUNTIME_ENTRY,
    patchId: `official-lobster-${release}`,
    compatibilityPatch: LOBSTER_WINDOWS_STATE_PATCH_ID,
    integrity: OFFICIAL_LOBSTER_INTEGRITY,
  };
}
