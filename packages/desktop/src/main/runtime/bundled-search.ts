import fs from 'node:fs';
import path from 'node:path';

export function hasBundledSearchProvider(deployedRoot: string | null | undefined): boolean {
  if (!deployedRoot) return false;
  try {
    const host = path.join(deployedRoot, 'node_modules/openclaw');
    const plugin = path.join(host, 'dist/extensions/duckduckgo');
    const metadata = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'openclaw.plugin.json'), 'utf8'));
    const hostMetadata = JSON.parse(fs.readFileSync(path.join(host, 'package.json'), 'utf8'));
    return (
      hostMetadata.name === 'openclaw' &&
      typeof hostMetadata.version === 'string' &&
      metadata.name === '@openclaw/duckduckgo-plugin' &&
      metadata.version === hostMetadata.version &&
      metadata.openclaw?.runtimeExtensions?.length === 1 &&
      metadata.openclaw.runtimeExtensions[0] === './dist/index.js' &&
      manifest.id === 'duckduckgo' &&
      manifest.contracts?.webSearchProviders?.includes('duckduckgo') === true &&
      fs.statSync(path.join(plugin, 'dist/index.js')).isFile()
    );
  } catch {
    return false;
  }
}
