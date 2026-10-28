import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-lobster-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = path.join(root, 'node_modules/@openclaw/lobster');
  const host = path.join(root, 'node_modules/openclaw');
  const write = (directory, metadata) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(metadata));
  };
  write(host, { name: 'openclaw', version: '2026.9.3' });
  fs.writeFileSync(path.join(host, 'LICENSE'), 'MIT attribution');
  write(plugin, {
    name: '@openclaw/lobster',
    version: '2026.9.3',
    dependencies: { '@clawdbot/lobster': '2026.6.11', typebox: '1.3.18' },
    openclaw: { runtimeExtensions: ['./dist/index.js'] },
  });
  write(path.join(plugin, 'node_modules/@clawdbot/lobster'), { name: '@clawdbot/lobster', version: '2026.6.11' });
  write(path.join(plugin, 'node_modules/typebox'), { name: 'typebox', version: '1.3.18' });
  fs.writeFileSync(
    path.join(plugin, 'openclaw.plugin.json'),
    JSON.stringify({ id: 'lobster', contracts: { tools: ['lobster'] }, toolMetadata: { lobster: { optional: true } } }),
  );
  fs.mkdirSync(path.join(plugin, 'dist'));
  fs.writeFileSync(path.join(plugin, 'dist/index.js'), 'export default {};');
  return { root, plugin, host };
}

test('requires the exact official archive integrity before any bundled-plugin mutation', async (t) => {
  const { bundleOfficialLobsterPlugin, OFFICIAL_LOBSTER_INTEGRITY } = await import('./bundled-lobster-runtime.mjs');
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.root, 'node_modules/.package-lock.json'),
    JSON.stringify({
      packages: {
        'node_modules/@openclaw/lobster': { version: '2026.9.3', integrity: `${OFFICIAL_LOBSTER_INTEGRITY}tampered` },
      },
    }),
  );
  assert.throws(() => bundleOfficialLobsterPlugin(f.root), /integrity/i);
  assert.equal(fs.existsSync(path.join(f.host, 'dist/extensions/lobster')), false);
});

test('rejects versions without a reviewed Windows embedded-runtime contract', async () => {
  const { officialLobsterPluginSpec } = await import('./bundled-lobster-runtime.mjs');
  assert.equal(officialLobsterPluginSpec('2026.9.3'), '@openclaw/lobster@2026.9.3');
  assert.throws(() => officialLobsterPluginSpec('2026.9.4'), /reviewed/i);
});
