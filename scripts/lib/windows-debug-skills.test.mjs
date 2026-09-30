import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

test('Windows debug guides use the bundled decoder/interpreter and built-in Node inspector instead of absent installers', async () => {
  const { patchWindowsDebugSkill } = await import('./windows-debug-skills.mjs');
  const node = '---\nname: node-inspect-debugger\n---\nlegacy npm jq tsx commands\n';
  const patched = patchWindowsDebugSkill(
    'node-inspect-debugger',
    node,
    createHash('sha256').update(node).digest('hex'),
  );
  assert.ok(patched.includes('scripts/inspector.mjs'));
  assert.ok(!patched.match(/npm --|\| jq|--import tsx|kill -SIGUSR1/));
  const python = 'python3 -c "import debugpy" || python3 -m pip install debugpy';
  const result = patchWindowsDebugSkill('python-debugpy', python, createHash('sha256').update(python).digest('hex'));
  assert.ok(result.includes('debugpy.__version__'));
  assert.ok(!result.includes('pip install'));
  const connect = "openclaw qr --json | jq '{gatewayUrl, gatewayUrls, auth, access, accessDowngraded, urlSource}'";
  const summary = patchWindowsDebugSkill('node-connect', connect, createHash('sha256').update(connect).digest('hex'));
  assert.ok(summary.includes('scripts/qr-summary.mjs'));
  assert.ok(!summary.includes('| jq'));
  assert.throws(() => patchWindowsDebugSkill('python-debugpy', python), /hash/);
});
