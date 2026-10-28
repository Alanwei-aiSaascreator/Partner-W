import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function origin(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
export function summarizeQr(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('QR response is invalid');
  const scalar = (value, allowed) => (allowed.includes(value) ? value : undefined);
  return {
    gatewayUrl: origin(payload.gatewayUrl),
    gatewayUrls: Array.isArray(payload.gatewayUrls) ? payload.gatewayUrls.map(origin).filter(Boolean) : undefined,
    auth: scalar(payload.auth, ['token', 'password', 'none', 'trusted-proxy']),
    access: scalar(payload.access, ['full', 'node', 'limited']),
    accessDowngraded: typeof payload.accessDowngraded === 'boolean' ? payload.accessDowngraded : undefined,
    urlSource: scalar(payload.urlSource, [
      'gateway.remote.url',
      'plugins.entries.device-pair.config.publicUrl',
      'gateway.tailscale.mode=serve',
      'gateway.tailscale.mode=funnel',
      'unknown',
    ]),
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--remote')) throw new Error('Invalid QR summary argument');
    const cli = fileURLToPath(new URL('../../../openclaw.mjs', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [cli, 'qr', ...(process.argv.includes('--remote') ? ['--remote'] : []), '--json'],
      { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
    );
    if (result.error || result.status !== 0) throw new Error('QR command failed');
    console.log(JSON.stringify(summarizeQr(JSON.parse(result.stdout)), null, 2));
  } catch {
    console.error('QR summary failed. Inspect the selected runtime and authentication outside agent-visible output.');
    process.exitCode = 1;
  }
}
