import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../util/json-file.js';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Enable the verified supplied default, while keeping explicit plugin/tool policies intact. */
export function ensureBundledWorkflowTools(deployedRoot: string, stateDir: string): boolean {
  const marker = path.join(deployedRoot, 'manifest.json');
  if (!fs.existsSync(marker)) return false;
  const manifest = read(marker);
  const variants = record(manifest) && Array.isArray(manifest.runtimes) ? manifest.runtimes : [];
  const supplied = variants.some(
    (variant: unknown) =>
      record(variant) &&
      Array.isArray(variant.patches) &&
      variant.patches.includes('official-lobster-2026.9.3') &&
      variant.patches.includes('rongying-lobster-windows-state-v1'),
  );
  if (!supplied) return false;
  const plugin = path.join(deployedRoot, 'node_modules/openclaw/dist/extensions/lobster');
  const entry = path.join(plugin, 'dist/index.js');
  if (!fs.existsSync(entry) || !fs.lstatSync(entry).isFile() || fs.statSync(entry).size === 0)
    throw new Error('Required compiled Lobster plugin is missing');
  const metadata = read(path.join(plugin, 'package.json'));
  const contract = read(path.join(plugin, 'openclaw.plugin.json'));
  if (
    !record(metadata) ||
    metadata.name !== '@openclaw/lobster' ||
    metadata.version !== '2026.9.3' ||
    !record(contract) ||
    contract.id !== 'lobster' ||
    !record(contract.contracts) ||
    !Array.isArray(contract.contracts.tools) ||
    !contract.contracts.tools.includes('lobster')
  )
    throw new Error('Required Lobster plugin identity or tool contract changed');
  const configPath = path.join(stateDir, 'openclaw.json');
  if (!fs.existsSync(configPath)) return false;
  const config = read(configPath);
  if (!record(config)) throw new Error('Owned gateway configuration must be an object');
  if (config.plugins !== undefined && !record(config.plugins)) throw new Error('Gateway plugin policy is invalid');
  const plugins = record(config.plugins) ? config.plugins : {};
  if (plugins.enabled === false) return false;
  if (Array.isArray(plugins.deny) && plugins.deny.includes('lobster')) return false;
  if (Array.isArray(plugins.allow) && !plugins.allow.includes('lobster')) return false;
  if (plugins.entries !== undefined && !record(plugins.entries)) throw new Error('Gateway plugin entries are invalid');
  const entries = record(plugins.entries) ? plugins.entries : {};
  if (entries.lobster !== undefined && !record(entries.lobster)) throw new Error('Gateway Lobster entry is invalid');
  const lobster = record(entries.lobster) ? entries.lobster : {};
  if (lobster.enabled !== undefined) return false;
  writeJsonAtomic(configPath, {
    ...config,
    plugins: { ...plugins, entries: { ...entries, lobster: { ...lobster, enabled: true } } },
  });
  return true;
}
