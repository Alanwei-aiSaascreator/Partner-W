import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  getRuntimeBootstrapStatus,
  publishRuntimeBootstrapStatus,
  resetRuntimeBootstrapStatus,
} from '../src/main/runtime/bootstrap-status.js';
const source = fs.readFileSync(fileURLToPath(new URL('../src/main/index.ts', import.meta.url)), 'utf8');
const start = source.indexOf('const runtimeResult = await bootstrapWithRetry({');
const terminal = 'if (runtimeResult.code !== PORTABLE_STATE_MIGRATION_BLOCKED) initAllGateways();';
const end = source.indexOf(terminal, start) + terminal.length;
if (start < 0 || end < terminal.length) throw new Error('Actual main boot section is unavailable');
const code = ts.transpileModule('(async () => {' + source.slice(start, end) + '})();', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
beforeEach(() => resetRuntimeBootstrapStatus());
async function runMainSection(result: { ok: boolean; code?: string; reason?: string }) {
  const send = vi.fn(() => false);
  const gateways = vi.fn();
  const dialog = { showMessageBox: vi.fn(async () => ({})) };
  const completion: Promise<void> = vm.runInNewContext(code, {
    bootstrapWithRetry: async () => result,
    publishRuntimeBootstrapStatus,
    getRuntimeBootstrapStatus,
    getMainWindow: () => null,
    sendToWindow: send,
    initAllGateways: gateways,
    GATEWAY_PORT_OCCUPIED: 'runtime.gateway-port-occupied',
    PORTABLE_STATE_MIGRATION_BLOCKED: 'runtime.portable-state-migration-blocked',
    GATEWAY_WS_PORT: 18789,
    buildPortBusyCopy: () => ({ title: 'busy', message: 'busy', detail: 'busy', button: 'ok' }),
    dialog,
  });
  await completion;
  return { send, gateways, dialog };
}
it('publishes a successful actual main boot for push and late snapshot readers', async () => {
  const { send, gateways, dialog } = await runMainSection({ ok: true });
  expect(getRuntimeBootstrapStatus()).toEqual({ ok: true });
  expect(send).toHaveBeenCalledExactlyOnceWith(null, 'runtime-status', { ok: true });
  expect(gateways).toHaveBeenCalledTimes(1);
  expect(dialog.showMessageBox).not.toHaveBeenCalled();
});
it.each([
  ['runtime.gateway-port-occupied', 'port-occupied'],
  ['runtime.gateway-process-exited', 'process-exited'],
  ['runtime.gateway-ready-timeout', 'ready-timeout'],
  ['runtime.portable-state-migration-blocked', 'state-migration-blocked'],
  ['runtime.other', 'unknown'],
])('keeps %s failure public and does not leak the raw reason', async (code, reason) => {
  const { send, gateways } = await runMainSection({ ok: false, code, reason: 'private path and credential fixture' });
  expect(getRuntimeBootstrapStatus()).toEqual({ ok: false, reason });
  expect(send).toHaveBeenCalledExactlyOnceWith(null, 'runtime-status', { ok: false, reason });
  expect(JSON.stringify(send.mock.calls)).not.toContain('private path');
  expect(gateways).toHaveBeenCalledTimes(code === 'runtime.portable-state-migration-blocked' ? 0 : 1);
});
