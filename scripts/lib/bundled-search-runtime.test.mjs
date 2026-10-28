import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const moduleUrl = new URL('./bundled-search-runtime.mjs', import.meta.url);

async function helper() {
  assert.ok(fs.existsSync(moduleUrl), 'official search plugin bundling support is missing');
  return import(moduleUrl.href);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-search-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = path.join(root, 'node_modules/openclaw');
  const plugin = path.join(root, 'node_modules/@openclaw/duckduckgo-plugin');
  fs.mkdirSync(path.join(host, 'dist/extensions'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(host, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.9.3' }));
  fs.writeFileSync(path.join(host, 'LICENSE'), 'MIT License\nCopyright (c) 2026 OpenClaw Foundation\n');
  const metadata = {
    name: '@openclaw/duckduckgo-plugin',
    version: '2026.9.3',
    type: 'module',
    openclaw: { extensions: ['./index.ts'], runtimeExtensions: ['./dist/index.js'] },
  };
  const manifest = { id: 'duckduckgo', contracts: { webSearchProviders: ['duckduckgo'] }, configSchema: {} };
  const save = () => {
    fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify(metadata));
    fs.writeFileSync(path.join(plugin, 'openclaw.plugin.json'), JSON.stringify(manifest));
  };
  save();
  fs.writeFileSync(path.join(plugin, 'README.md'), 'Official OpenClaw DuckDuckGo Plugin\n');
  fs.writeFileSync(path.join(plugin, 'dist/index.js'), "export { provider as default } from './provider.js';\n");
  fs.writeFileSync(path.join(plugin, 'dist/provider.js'), 'export const provider = {};\n');
  return { root, host, plugin, metadata, manifest, save };
}

test('bundles the exact official compiled package in the runtime discovery root and preserves attribution', async (t) => {
  const f = fixture(t);
  const { bundleOfficialSearchPlugin } = await helper();
  const result = bundleOfficialSearchPlugin(f.root);
  assert.equal(result.entry, 'node_modules/openclaw/dist/extensions/duckduckgo/dist/index.js');
  assert.equal(result.patchId, 'official-duckduckgo-2026.9.3');
  const destination = path.join(f.host, 'dist/extensions/duckduckgo');
  for (const file of ['package.json', 'openclaw.plugin.json', 'README.md', 'dist/index.js', 'dist/provider.js']) {
    assert.deepEqual(fs.readFileSync(path.join(destination, file)), fs.readFileSync(path.join(f.plugin, file)));
  }
  assert.deepEqual(fs.readFileSync(path.join(destination, 'LICENSE')), fs.readFileSync(path.join(f.host, 'LICENSE')));
});

test('rejects a plugin version different from the installed host before changing the bundle', async (t) => {
  const f = fixture(t);
  f.metadata.version = '2026.9.7';
  f.save();
  const { bundleOfficialSearchPlugin } = await helper();
  assert.throws(() => bundleOfficialSearchPlugin(f.root), /version mismatch/);
  assert.equal(fs.existsSync(path.join(f.host, 'dist/extensions/duckduckgo')), false);
});

test('rejects an undeclared search contract instead of marking search as installed', async (t) => {
  const f = fixture(t);
  f.manifest.contracts.webSearchProviders = [];
  f.save();
  const { bundleOfficialSearchPlugin } = await helper();
  assert.throws(() => bundleOfficialSearchPlugin(f.root), /search contract/);
});

test('requires the compiled runtime entry named by the official package', async (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.plugin, 'dist/index.js'));
  const { bundleOfficialSearchPlugin } = await helper();
  assert.throws(() => bundleOfficialSearchPlugin(f.root), /compiled runtime entry/);
});

test('rejects a foreign package identity', async (t) => {
  const f = fixture(t);
  f.metadata.name = '@someone/duckduckgo-plugin';
  f.save();
  const { bundleOfficialSearchPlugin } = await helper();
  assert.throws(() => bundleOfficialSearchPlugin(f.root), /official package identity/);
});

test('fails closed if a future plugin adds runtime dependencies that need a packaging review', async (t) => {
  const f = fixture(t);
  f.metadata.dependencies = { 'new-client': '1.0.0' };
  f.save();
  const { bundleOfficialSearchPlugin } = await helper();
  assert.throws(() => bundleOfficialSearchPlugin(f.root), /runtime dependencies/);
});

test('pins the registry package to the requested host version', async () => {
  const { officialSearchPluginSpec } = await helper();
  assert.equal(officialSearchPluginSpec('2026.9.3'), '@openclaw/duckduckgo-plugin@2026.9.3');
  assert.throws(() => officialSearchPluginSpec('latest'), /explicit release version/);
});
