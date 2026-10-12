import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hasInstalledSearchProvider } from '../src/main/runtime/bundled-search.js';
import {
  RELAY_SEARCH_PLUGIN_ID,
  ensureRelaySearchPlugin,
  relaySearchPluginDir,
} from '../src/main/runtime/relay-search-plugin.js';

const roots: string[] = [];

/** 状态目录夹具：让 ensure 按与应用启动完全相同的方式落盘插件三件套。 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'installed-search-availability-'));
  roots.push(root);
  ensureRelaySearchPlugin(root);
  return { root, dir: relaySearchPluginDir(root) };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('installed relay search availability evidence', () => {
  it('accepts the app-written plugin (three files + manifest identity)', () => {
    const f = fixture();
    expect(hasInstalledSearchProvider(f.root)).toBe(true);
  });

  it.each([null, undefined, '/missing-fixture-state'])('fails closed without an active state dir: %s', (stateDir) => {
    expect(hasInstalledSearchProvider(stateDir)).toBe(false);
  });

  it('rejects a missing compiled entry', () => {
    const f = fixture();
    fs.rmSync(path.join(f.dir, 'index.mjs'));
    expect(hasInstalledSearchProvider(f.root)).toBe(false);
  });

  it('rejects a missing package manifest', () => {
    const f = fixture();
    fs.rmSync(path.join(f.dir, 'package.json'));
    expect(hasInstalledSearchProvider(f.root)).toBe(false);
  });

  it('rejects a foreign plugin carrying the same directory but a different contract', () => {
    const f = fixture();
    const manifest = JSON.parse(fs.readFileSync(path.join(f.dir, 'openclaw.plugin.json'), 'utf8')) as {
      contracts: { webSearchProviders: string[] };
    };
    manifest.contracts = { webSearchProviders: ['someone-else'] };
    fs.writeFileSync(path.join(f.dir, 'openclaw.plugin.json'), JSON.stringify(manifest));
    expect(hasInstalledSearchProvider(f.root)).toBe(false);
  });

  it('rejects a manifest without the startup activation and malformed manifests', () => {
    const f = fixture();
    const manifestPath = path.join(f.dir, 'openclaw.plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    delete manifest.activation;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(hasInstalledSearchProvider(f.root)).toBe(false);
    fs.writeFileSync(manifestPath, '{');
    expect(hasInstalledSearchProvider(f.root)).toBe(false);
    expect(RELAY_SEARCH_PLUGIN_ID).toBe('rongying-search');
  });
});
