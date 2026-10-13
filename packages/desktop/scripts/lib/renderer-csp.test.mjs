import test from 'node:test';
import assert from 'node:assert/strict';
import { PROD_CSP, rendererDevCsp } from './renderer-csp.mjs';

test('prod 策略：script 无 unsafe-inline、无 http 源', () => {
  const script = PROD_CSP.split('; ').find((d) => d.startsWith('script-src'));
  assert.equal(script, "script-src 'self'");
  assert.ok(!PROD_CSP.includes('http://'));
  assert.ok(!PROD_CSP.includes('ws://'));
});
test('prod 策略：实际用到的面都在白名单里', () => {
  for (const token of [
    'file:',
    'blob:',
    'data:',
    'clawwork-avatar:',
    'clawwork-asset:',
    "style-src 'self' 'unsafe-inline'",
  ])
    assert.ok(PROD_CSP.includes(token), token);
});
test('dev 只多 dev 源与 ws：其余指令与 prod 同文', () => {
  const dev = rendererDevCsp('http://localhost:5173');
  assert.ok(dev.includes('http://localhost:5173') && dev.includes('ws://localhost:5173'));
  for (const directive of [
    'media-src',
    'font-src',
    'frame-src',
    'object-src',
    'base-uri',
    'form-action',
    'frame-ancestors',
  ]) {
    const pick = (s) => s.split('; ').find((d) => d.startsWith(directive));
    assert.equal(pick(dev), pick(PROD_CSP), directive);
  }
});
