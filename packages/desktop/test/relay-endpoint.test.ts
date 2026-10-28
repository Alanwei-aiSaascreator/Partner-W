import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GATEWAY_CONFIG_MAX_BYTES,
  TEST_BUDGET_CONFIG_MAX_BYTES,
  isControlledRelayBaseUrl,
  readCappedTextFile,
  resolveControlledRelayEndpoint,
  type ControlledEndpointDeps,
} from '../src/main/commercial/relay-endpoint.js';
import {
  RELAY_BASE_URL,
  RELAY_PROVIDER_ID,
  activeRelayBaseUrl,
  applyRelayConfig,
  buildRelayPatch,
  buildRelayRemovalPatch,
  relayProviderIds,
  setActiveRelayBaseUrl,
  type ApplyRelayConfigDeps,
} from '../src/main/commercial/relay-config.js';

/**
 * 受控配置出口的验收面（2026-10-03）。四个行为逐条钉住：
 *
 *   ① 默认生产值 —— env 没配时，基址与历史**逐字相同**；
 *   ② 测试模式本地 —— 配好 test-budget.json + 账号匹配 → 本机基址；
 *   ③ 账号不匹配拒绝 —— 卡不对就**拒绝**测试模式（回退生产 + 带原因）；
 *   ④ 重启不覆写 —— 写入侧写的是**活动基址**：env 还在，重写写回的就还是本地。
 *
 * ⚠️ 本文件会改 `relay-config` 的模块级活动基址 ⇒ **每个用例后必须复位**
 *    （afterEach），否则污染同文件后面的用例（跨文件有 vitest 的模块隔离兜底，
 *    但同文件内没有）。
 */

const VIRTUAL = path.resolve(process.cwd(), 'virtual-relay-endpoint');
const BUDGET_FILE = path.join(VIRTUAL, 'test-budget.json');
const GATEWAY_FILE = path.join(VIRTUAL, 'openclaw.json');
const LOCAL = 'http://127.0.0.1:8791';
const LICENSE = 'ROYIN-TEST-0001';

afterEach(() => {
  setActiveRelayBaseUrl(null);
  vi.restoreAllMocks();
});

function budgetJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    authorizedTest: true,
    licenseId: LICENSE,
    gatewayConfig: GATEWAY_FILE,
    batchId: 'ppt-nonprod-20261002',
    ...overrides,
  });
}

function modelJson(baseUrl: string = LOCAL): string {
  return JSON.stringify({ models: { providers: { clawrouter: { baseUrl, apiKey: 'rly_fixture' } } } });
}

function deps(files: Record<string, string>, licenseId: string | null = LICENSE): ControlledEndpointDeps {
  return {
    env: { ROYIN_NATIVE_TEST_CONFIG: BUDGET_FILE },
    readTextFile: (absPath, maxBytes) => {
      const text = files[absPath];
      if (text === undefined) throw new Error('fixture-missing');
      if (Buffer.byteLength(text) > maxBytes) throw new Error('fixture-too-large');
      return text;
    },
    readLicenseId: async () => licenseId,
  };
}

describe('resolveControlledRelayEndpoint（受控配置出口的裁决）', () => {
  it('① 没有测试配置 → 生产默认（与历史逐字相同）', async () => {
    const resolution = await resolveControlledRelayEndpoint({
      ...deps({}),
      env: {},
      // 没配时**一个文件都不许读**：读了就说明有无谓的 IO 依赖。
      readTextFile: () => {
        throw new Error('must-not-read');
      },
    });

    expect(resolution).toEqual({ baseUrl: RELAY_BASE_URL, source: 'production' });
  });

  it('env 指向相对路径 → 不认，直接生产默认', async () => {
    const resolution = await resolveControlledRelayEndpoint({
      ...deps({}),
      env: { ROYIN_NATIVE_TEST_CONFIG: 'relative/test-budget.json' },
      readTextFile: () => {
        throw new Error('must-not-read');
      },
    });

    expect(resolution).toEqual({ baseUrl: RELAY_BASE_URL, source: 'production' });
  });

  it('② 合法配置 + 账号匹配 → 本机基址（测试模式本地）', async () => {
    const resolution = await resolveControlledRelayEndpoint(
      deps({ [BUDGET_FILE]: budgetJson(), [GATEWAY_FILE]: modelJson() }),
    );

    expect(resolution).toEqual({ baseUrl: LOCAL, source: 'test-config' });
  });

  it('② 尾斜杠被归一化掉（写入/比较共用同一形状）', async () => {
    const resolution = await resolveControlledRelayEndpoint(
      deps({ [BUDGET_FILE]: budgetJson(), [GATEWAY_FILE]: modelJson(`${LOCAL}/`) }),
    );

    expect(resolution.baseUrl).toBe(LOCAL);
  });

  it('② gatewayConfig 里写生产地址也接受（白名单第一条，行为不变）', async () => {
    const resolution = await resolveControlledRelayEndpoint(
      deps({ [BUDGET_FILE]: budgetJson(), [GATEWAY_FILE]: modelJson(RELAY_BASE_URL) }),
    );

    expect(resolution).toEqual({ baseUrl: RELAY_BASE_URL, source: 'test-config' });
  });

  it('③ 账号不匹配 → 拒绝测试模式，回退生产 + reason', async () => {
    const resolution = await resolveControlledRelayEndpoint(
      deps({ [BUDGET_FILE]: budgetJson(), [GATEWAY_FILE]: modelJson() }, 'SOME-OTHER-LICENSE'),
    );

    expect(resolution).toEqual({ baseUrl: RELAY_BASE_URL, source: 'production', reason: 'account-mismatch' });
  });

  it('③ 读不到许可（没激活/读失败）同样按不匹配拒绝', async () => {
    const resolution = await resolveControlledRelayEndpoint(
      deps({ [BUDGET_FILE]: budgetJson(), [GATEWAY_FILE]: modelJson() }, null),
    );

    expect(resolution.reason).toBe('account-mismatch');
    expect(resolution.source).toBe('production');
  });

  it('authorizedTest 不为 true / 形状不对 → not-authorized', async () => {
    for (const bogus of [
      budgetJson({ authorizedTest: false }),
      budgetJson({ licenseId: '' }),
      budgetJson({ gatewayConfig: 'relative/openclaw.json' }),
    ]) {
      const resolution = await resolveControlledRelayEndpoint(
        deps({ [BUDGET_FILE]: bogus, [GATEWAY_FILE]: modelJson() }),
      );
      expect(resolution).toEqual({ baseUrl: RELAY_BASE_URL, source: 'production', reason: 'not-authorized' });
    }
  });

  it('配置文件读不到 / JSON 坏 → config-unreadable', async () => {
    const resolution = await resolveControlledRelayEndpoint(deps({ [BUDGET_FILE]: '{ not json' }));
    expect(resolution.reason).toBe('config-unreadable');
  });

  it('gatewayConfig 里没有 clawrouter provider → provider-unavailable', async () => {
    const noProvider = JSON.stringify({ models: { providers: {} } });
    const resolution = await resolveControlledRelayEndpoint(
      deps({ [BUDGET_FILE]: budgetJson(), [GATEWAY_FILE]: noProvider }),
    );
    expect(resolution.reason).toBe('provider-unavailable');
  });

  it('非白名单地址（外网主机）→ url-not-allowed（这条就是"受控"的边界）', async () => {
    const resolution = await resolveControlledRelayEndpoint(
      deps({ [BUDGET_FILE]: budgetJson(), [GATEWAY_FILE]: modelJson('https://evil.example.com/relay') }),
    );
    expect(resolution.reason).toBe('url-not-allowed');
    expect(resolution.baseUrl).toBe(RELAY_BASE_URL);
  });
});

describe('isControlledRelayBaseUrl（与 native-dispatch-guard 共用的白名单）', () => {
  it('生产 origin 与回环任意端口通过；其余全部拒绝', () => {
    expect(isControlledRelayBaseUrl('https://api.rongyinghudong.com/relay')).toBe(true);
    expect(isControlledRelayBaseUrl('https://api.rongyinghudong.com')).toBe(true);
    expect(isControlledRelayBaseUrl('http://127.0.0.1:8791')).toBe(true);
    expect(isControlledRelayBaseUrl('http://localhost:3000')).toBe(true);

    // ⚠️ 与旧判据逐字一致：**https 的回环不认**（本机 relay 就是明文 http）。
    expect(isControlledRelayBaseUrl('https://127.0.0.1:8791')).toBe(false);
    expect(isControlledRelayBaseUrl('http://api.rongyinghudong.com')).toBe(false);
    expect(isControlledRelayBaseUrl('https://evil.example.com/relay')).toBe(false);
    expect(isControlledRelayBaseUrl('not a url')).toBe(false);
  });
});

describe('relay-config 活动基址（受控出口的落地形态）', () => {
  it('默认 = 生产；set 后 = 本机（归一化）；null 恢复', () => {
    expect(activeRelayBaseUrl()).toBe(RELAY_BASE_URL);
    setActiveRelayBaseUrl(`${LOCAL}/`);
    expect(activeRelayBaseUrl()).toBe(LOCAL);
    setActiveRelayBaseUrl(null);
    expect(activeRelayBaseUrl()).toBe(RELAY_BASE_URL);
  });

  it('测试模式下：写入写本机基址、识别认本机基址、清理也认它', () => {
    setActiveRelayBaseUrl(LOCAL);

    const patch = buildRelayPatch({ relayKey: 'rly_abc', deviceFingerprint: 'fp' });
    const providers = (patch as never as { models: { providers: Record<string, Record<string, unknown>> } }).models
      .providers;
    expect(providers[RELAY_PROVIDER_ID].baseUrl).toBe(LOCAL);

    const ids = relayProviderIds({ config: { models: { providers: { clawrouter: { baseUrl: LOCAL } } } } });
    expect(ids.has(RELAY_PROVIDER_ID)).toBe(true);

    const removal = buildRelayRemovalPatch({
      config: { models: { providers: { clawrouter: { baseUrl: LOCAL, apiKey: 'rly_x' } } } },
    });
    expect(removal).not.toBeNull();
    expect((removal!.patch.models as { providers: Record<string, unknown> }).providers[RELAY_PROVIDER_ID]).toBeNull();
  });

  it('④ 重启不覆写：指向本机的快照上再跑一次写入，写回的仍是本机（不是生产）', async () => {
    setActiveRelayBaseUrl(LOCAL);

    // 「上一轮会话已经写下本机基址」的网关快照（回读的 key 是脱敏后的非空串）。
    const snapshot = {
      hash: 'h1',
      config: { models: { providers: { clawrouter: { baseUrl: LOCAL, apiKey: '__OPENCLAW_REDACTED__' } } } },
    };
    const raws: string[] = [];
    const patchConfig = vi.fn(async (params: { raw: string }) => {
      raws.push(params.raw);
      return {};
    });
    const deps: ApplyRelayConfigDeps = {
      getConfig: async () => snapshot,
      patchConfig,
    };

    const result = await applyRelayConfig(deps, { relayKey: 'rly_abc', deviceFingerprint: 'fp' });

    expect(result.configured).toBe(true);
    expect(raws).toHaveLength(1);
    expect(raws[0]).toContain(LOCAL);
    expect(raws[0]).not.toContain('api.rongyinghudong.com');
  });
});

describe('readCappedTextFile（限额读取）', () => {
  it('读得到正常文件；超限抛；不存在抛', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-endpoint-'));
    const file = path.join(dir, 'small.json');
    fs.writeFileSync(file, '{"ok":true}');

    expect(readCappedTextFile(file, 1024)).toBe('{"ok":true}');
    expect(() => readCappedTextFile(file, 2)).toThrow();
    expect(() => readCappedTextFile(path.join(dir, 'missing.json'), 1024)).toThrow();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('两个上限常量与 native-dispatch-guard 的同值（64KB / 1MB）', () => {
    expect(TEST_BUDGET_CONFIG_MAX_BYTES).toBe(64 * 1024);
    expect(GATEWAY_CONFIG_MAX_BYTES).toBe(1024 * 1024);
  });
});
