import { afterEach, describe, expect, it, vi } from 'vitest';
import { getActiveRelayKey, setActiveRelayKey } from '../src/main/commercial/relay-key.js';
import {
  applyRelayConfig,
  setActiveRelayBaseUrl,
  type ApplyRelayConfigDeps,
} from '../src/main/commercial/relay-config.js';

/**
 * 活体 relay key 的内存持有者（2026-10-12 视频接入）。
 *
 * 这条修法的现场背景（写进测试防回退）：网关的 `config.get` 对 apiKey **脱敏**
 * （回读恒为 `__OPENCLAW_REDACTED__`），从快照读 key 的实现在真机上把占位符当凭据
 * 发了出去 —— 视频创建 401 `invalid relay key`，而 chat 一切正常。
 * 唯一以明文见到 key 的地方是 `applyRelayConfig` 的入参，所以写点必须在它里面。
 */

afterEach(() => setActiveRelayKey(null));

describe('relay-key 持有者', () => {
  it('默认 null；set/get 往返；null/空串清除', () => {
    setActiveRelayKey(null);
    expect(getActiveRelayKey()).toBeNull();
    setActiveRelayKey('rly_test_1');
    expect(getActiveRelayKey()).toBe('rly_test_1');
    setActiveRelayKey(null);
    expect(getActiveRelayKey()).toBeNull();
    setActiveRelayKey('');
    expect(getActiveRelayKey()).toBeNull();
    setActiveRelayKey('   ');
    expect(getActiveRelayKey()).toBeNull();
  });
});

describe('applyRelayConfig 是持有者的唯一写点', () => {
  const LOCAL = 'http://127.0.0.1:8791';
  const snapshot = {
    hash: 'h1',
    // 回读的 apiKey 是**脱敏占位符**（网关的真实行为，正是本条修法的由来）。
    config: { models: { providers: { clawrouter: { baseUrl: LOCAL, apiKey: '__OPENCLAW_REDACTED__' } } } },
  };

  function deps(patchConfig: ApplyRelayConfigDeps['patchConfig']): ApplyRelayConfigDeps {
    return {
      getConfig: vi.fn(async () => snapshot),
      patchConfig,
    };
  }

  afterEach(() => setActiveRelayBaseUrl(null));

  it('⭐ 成功写入后持有的是**入参那把明文 key**（不是快照里的脱敏占位符）', async () => {
    setActiveRelayBaseUrl(LOCAL); // 校验步要求 provider 指向活动基址（同 relay-endpoint ④ 的夹具）
    setActiveRelayKey(null);
    const patchConfig = vi.fn(async () => ({}));
    const result = await applyRelayConfig(deps(patchConfig), {
      relayKey: 'rly_real_key_987',
      deviceFingerprint: 'fp',
    });
    expect(result.configured).toBe(true);
    expect(getActiveRelayKey()).toBe('rly_real_key_987');
    expect(getActiveRelayKey()).not.toContain('REDACTED');
  });

  it('无 key 的调用（no-key 早退）清除持有者 —— 不留下一个"上一张卡的" key', async () => {
    setActiveRelayKey('rly_previous');
    const result = await applyRelayConfig(deps(vi.fn()), { relayKey: null, deviceFingerprint: 'fp' });
    expect(result.configured).toBe(false);
    expect(getActiveRelayKey()).toBeNull();
  });
});
