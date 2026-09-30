import assert from 'node:assert/strict';
import { test } from 'node:test';

test('QR diagnostics retain only route origins and bounded non-secret fields', async () => {
  const { summarizeQr } = await import('./qr-summary-cli.mjs');
  const summary = summarizeQr({
    gatewayUrl: 'wss://user:password@demo.example/gateway?token=secret#code',
    gatewayUrls: ['ws://127.0.0.1:18789'],
    auth: 'token',
    access: 'full',
    accessDowngraded: true,
    urlSource: 'gateway.remote.url',
    setupCode: 'SECRET-SETUP',
    token: 'SECRET-TOKEN',
  });
  assert.equal(summary.gatewayUrl, 'wss://demo.example');
  assert.equal(summary.auth, 'token');
  assert.equal(summary.access, 'full');
  assert.equal(summary.urlSource, 'gateway.remote.url');
  assert.equal(summary.accessDowngraded, true);
  assert.ok(!JSON.stringify(summary).match(/password|secret|SECRET|SETUP|TOKEN/));
  assert.throws(() => summarizeQr('raw output'), /invalid/);
});
