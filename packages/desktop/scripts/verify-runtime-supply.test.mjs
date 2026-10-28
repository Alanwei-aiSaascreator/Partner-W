import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRuntimeSupply, requiredRuntimePatches } from './verify-runtime-supply.mjs';
const fixture = () => ({
  runtimes: [{ platform: 'win32', arch: 'x64', version: '2026.9.3', patches: requiredRuntimePatches('2026.9.3') }],
});
test('accepts the current bundled Windows supply contract without claiming effective tools', () => {
  assert.equal(verifyRuntimeSupply(fixture()), undefined);
});
test('rejects each missing committed native or workflow supply marker', () => {
  for (const patch of requiredRuntimePatches('2026.9.3')) {
    const manifest = fixture();
    manifest.runtimes[0].patches = manifest.runtimes[0].patches.filter((value) => value !== patch);
    assert.throws(() => verifyRuntimeSupply(manifest), /required runtime patch/i);
  }
});
test('refuses incompatible Windows versions and manifests with no Windows x64 variant', () => {
  assert.throws(() => verifyRuntimeSupply({ runtimes: [] }), /Windows x64/i);
  assert.throws(() => verifyRuntimeSupply({ runtimes: [{ platform: 'linux', arch: 'x64' }] }), /Windows x64/i);
  const manifest = fixture();
  manifest.runtimes[0].version = '2026.9.4';
  assert.throws(() => verifyRuntimeSupply(manifest), /reviewed/i);
});
