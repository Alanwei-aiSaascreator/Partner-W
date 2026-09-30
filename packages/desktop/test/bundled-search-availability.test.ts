import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

async function helper() {
  expect(fs.existsSync(new URL('../src/main/runtime/bundled-search.ts', import.meta.url))).toBe(true);
  return import('../src/main/runtime/bundled-search.js');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-search-availability-'));
  roots.push(root);
  const host = path.join(root, 'node_modules/openclaw');
  const plugin = path.join(host, 'dist/extensions/duckduckgo');
  fs.mkdirSync(path.join(plugin, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(host, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.3' }));
  const metadata = {
    name: '@openclaw/duckduckgo-plugin',
    version: '2026.9.3',
    openclaw: { runtimeExtensions: ['./dist/index.js'] },
  };
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify(metadata));
  fs.writeFileSync(
    path.join(plugin, 'openclaw.plugin.json'),
    JSON.stringify({ id: 'duckduckgo', contracts: { webSearchProviders: ['duckduckgo'] } }),
  );
  fs.writeFileSync(path.join(plugin, 'dist/index.js'), 'export default {};');
  return { root, plugin, metadata };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('official bundled search availability evidence', () => {
  it('accepts the exact installed official provider and compiled entry', async () => {
    const f = fixture();
    const { hasBundledSearchProvider } = await helper();
    expect(hasBundledSearchProvider(f.root)).toBe(true);
  });

  it.each([null, undefined, '/missing-fixture-runtime'])(
    'fails closed without an active deployed root: %s',
    async (root) => {
      const { hasBundledSearchProvider } = await helper();
      expect(hasBundledSearchProvider(root)).toBe(false);
    },
  );

  it('rejects a missing compiled entry', async () => {
    const f = fixture();
    fs.rmSync(path.join(f.plugin, 'dist/index.js'));
    const { hasBundledSearchProvider } = await helper();
    expect(hasBundledSearchProvider(f.root)).toBe(false);
  });

  it('rejects a foreign package with the same plugin id', async () => {
    const f = fixture();
    f.metadata.name = '@someone/duckduckgo-plugin';
    fs.writeFileSync(path.join(f.plugin, 'package.json'), JSON.stringify(f.metadata));
    const { hasBundledSearchProvider } = await helper();
    expect(hasBundledSearchProvider(f.root)).toBe(false);
  });

  it('rejects a different plugin version and malformed manifests', async () => {
    const f = fixture();
    f.metadata.version = '2026.9.7';
    fs.writeFileSync(path.join(f.plugin, 'package.json'), JSON.stringify(f.metadata));
    const { hasBundledSearchProvider } = await helper();
    expect(hasBundledSearchProvider(f.root)).toBe(false);
    fs.writeFileSync(path.join(f.plugin, 'package.json'), '{');
    expect(hasBundledSearchProvider(f.root)).toBe(false);
  });
});
