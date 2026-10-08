import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { it, expect, vi, afterEach } from 'vitest';
const license = vi.hoisted(() => vi.fn());
vi.mock('../src/main/commercial/license.js', () => ({ readLicenseStatus: license }));
import { requireNativeTestBudget } from '../src/main/docgen/native-dispatch-guard';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function configure() {
  const folder = mkdtempSync(join(tmpdir(), 'native-paid-guard-'));
  roots.push(folder);
  const gateway = join(folder, 'openclaw.json'),
    cfg = join(folder, 'trial.json');
  writeFileSync(
    gateway,
    JSON.stringify({
      models: { providers: { clawrouter: { baseUrl: 'http://127.0.0.1:1234/relay', apiKey: 'fixture-not-a-key' } } },
    }),
  );
  writeFileSync(
    cfg,
    JSON.stringify({
      authorizedTest: true,
      licenseId: 'test-license',
      gatewayConfig: gateway,
      batchId: 'fixed-five-yuan-batch',
    }),
  );
  vi.stubEnv('ROYIN_NATIVE_TEST_CONFIG', cfg);
  license.mockResolvedValue({ ok: true, result: { licenseId: 'test-license' } });
}
it('blocks a missing authorized identity before any HTTP or model call', async () => {
  vi.stubEnv('ROYIN_NATIVE_TEST_CONFIG', '');
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(requireNativeTestBudget()).rejects.toThrow('native-test-account-unverified');
  expect(fetcher).not.toHaveBeenCalled();
});
it('accepts the same test license within a sane billed-user scope window (2026-10-06 widened)', async () => {
  configure();
  const good = {
    guardVersion: 'ppt-budget-v1',
    batchId: 'fixed-five-yuan-batch',
    batchCapMicros: '500000000',
    currency: 'CNY',
    unit: 'micros-cent',
    licenseHash: createHash('sha256').update('test-license').digest('hex'),
  };
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => good });
  vi.stubGlobal('fetch', fetcher);
  expect((await requireNativeTestBudget()).batchId).toBe(good.batchId);
  // ⚠️ 2026-10-06 放宽（真机 Gate 实证）：并发调用的保险化预占（2.019 元/笔）会顶破 5 元任务帽，
  //    批窗帽不再是"必须恰为 5 元"——改为**区间校验**（身份由 batchId+licenseHash 把关）。
  //    区间内的更大窗（如 20 元）必须放行：
  fetcher.mockResolvedValue({ ok: true, json: async () => ({ ...good, batchCapMicros: '2000000000' }) });
  expect((await requireNativeTestBudget()).batchCapMicros).toBe('2000000000');
  // 越界/非法值仍拒（保留"必须是真实配置的预算窗"本意）：
  for (const bad of ['0', '100000000001', 'abc']) {
    fetcher.mockResolvedValue({ ok: true, json: async () => ({ ...good, batchCapMicros: bad }) });
    await expect(requireNativeTestBudget()).rejects.toThrow('native-test-budget-guard-unavailable');
  }
  license.mockResolvedValue({ ok: true, result: { licenseId: 'customer-license' } });
  fetcher.mockClear();
  await expect(requireNativeTestBudget()).rejects.toThrow('native-test-account-mismatch');
  expect(fetcher).not.toHaveBeenCalled();
});
