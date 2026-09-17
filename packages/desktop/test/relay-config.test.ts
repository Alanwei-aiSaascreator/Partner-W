import { describe, expect, it, vi } from 'vitest';
import {
  RELAY_BASE_URL,
  RELAY_PROVIDER_ID,
  applyRelayConfig,
  buildRelayRemovalPatch,
  buildRelayPatch,
  removeRelayConfig,
  type ApplyRelayConfigDeps,
} from '../src/main/commercial/relay-config.js';

/** `getConfig()` 返回的形态：真正的配置在 `.config` 下（ConfigSnapshot）。 */
function snapshot(config: Record<string, unknown>, hash = 'h1') {
  return { hash, config, raw: '', path: '' };
}

describe('buildRelayPatch', () => {
  it('写入 clawrouter 的 baseUrl / apiKey / 设备指纹头', () => {
    const patch = buildRelayPatch({ relayKey: 'rly_abc', deviceFingerprint: 'fp123' });
    const provider = (patch as never as { models: { providers: Record<string, Record<string, unknown>> } }).models
      .providers[RELAY_PROVIDER_ID];

    expect(provider.baseUrl).toBe(RELAY_BASE_URL);
    expect(provider.apiKey).toBe('rly_abc');
    expect(provider.headers).toEqual({ 'X-ClawRouter-Project-Id': 'fp123' });
  });

  // ⚠️ 反向断言，别删。
  //
  // `api: 'openai-completions'` **看着像合理字段**（它确实是 openclaw 的合法 core API 名），
  // 但规范形状里没有它 —— 传输协议由 catalog 里每个模型的 capability 逐条决定
  // （llm.chat → openai-completions、llm.messages → anthropic-messages……）。
  // 在 provider 上写死会把「按模型选传输」压成「整个 provider 一个传输」，
  // 将来 catalog 里加一个别的路线的模型就会**静默走错**。
  // 只删正向断言不够：不加这条，将来有人「顺手补上」时会重新引入。
  it('patch 里不得出现 api 字段（传输由 catalog 的 capability 决定）', () => {
    const patch = buildRelayPatch({ relayKey: 'rly_abc', deviceFingerprint: 'fp' });
    const provider = (patch as never as { models: { providers: Record<string, Record<string, unknown>> } }).models
      .providers[RELAY_PROVIDER_ID];

    expect(provider).not.toHaveProperty('api');
    expect(Object.keys(provider)).not.toContain('api');
  });

  it('缺 relayKey 时不构造 patch —— 宁可不写，也不写半个配置', () => {
    // 写一个空 apiKey 会让网关去调一个必然 401 的地址，
    // 用户看到的是一堆失败的模型调用，比「没配置」更难排查。
    expect(buildRelayPatch({ relayKey: '', deviceFingerprint: 'fp' })).toBeNull();
    expect(buildRelayPatch({ relayKey: null, deviceFingerprint: 'fp' })).toBeNull();
    expect(buildRelayPatch({ relayKey: undefined, deviceFingerprint: 'fp' })).toBeNull();
  });

  it('缺设备指纹时仍然写配置，只是不带那个头（它不参与放行）', () => {
    const patch = buildRelayPatch({ relayKey: 'rly_abc', deviceFingerprint: '' });
    const provider = (patch as never as { models: { providers: Record<string, Record<string, unknown>> } }).models
      .providers[RELAY_PROVIDER_ID];

    expect(provider.headers).toEqual({});
  });

  describe('plugins.allow', () => {
    it('现有配置有 plugins.allow 时，把 clawrouter 加进去并保留原有项', () => {
      // 官方文档原话：If your configuration sets plugins.allow,
      // add clawrouter to that list before enabling it.
      const patch = buildRelayPatch({
        relayKey: 'rly_abc',
        deviceFingerprint: 'fp',
        existingConfig: snapshot({ plugins: { allow: ['deepseek', 'kimi'] } }),
      });
      const plugins = (patch as never as { plugins: { allow: string[] } }).plugins;

      expect(plugins.allow).toContain(RELAY_PROVIDER_ID);
      expect(plugins.allow).toContain('deepseek');
      expect(plugins.allow).toContain('kimi');
    });

    it('现有配置没有 plugins.allow 时**不创建**它', () => {
      // 凭空加一个 allow 名单会把其他插件挡在外面 —— 那是灾难，不是配置。
      const patch = buildRelayPatch({
        relayKey: 'rly_abc',
        deviceFingerprint: 'fp',
        existingConfig: snapshot({ plugins: { entries: { kimi: { enabled: true } } } }),
      });

      expect((patch as never as { plugins?: { allow?: unknown } }).plugins?.allow).toBeUndefined();
    });

    it('已包含 clawrouter 时不重复添加', () => {
      const patch = buildRelayPatch({
        relayKey: 'rly_abc',
        deviceFingerprint: 'fp',
        existingConfig: snapshot({ plugins: { allow: [RELAY_PROVIDER_ID] } }),
      });
      const plugins = (patch as never as { plugins: { allow: string[] } }).plugins;

      expect(plugins.allow.filter((x) => x === RELAY_PROVIDER_ID)).toHaveLength(1);
    });
  });

  describe('agents.defaults.model.primary', () => {
    it('未设置且解析到了模型时写入', () => {
      const patch = buildRelayPatch({
        relayKey: 'rly_abc',
        deviceFingerprint: 'fp',
        existingConfig: snapshot({ agents: { defaults: {} } }),
        defaultModel: 'clawrouter/bailian/deepseek-v4-flash',
      });
      const primary = (patch as never as { agents: { defaults: { model: { primary: string } } } }).agents.defaults.model
        .primary;

      expect(primary).toBe('clawrouter/bailian/deepseek-v4-flash');
    });

    it('已设置时**不动它** —— 激活是新增能力，不是重设用户偏好', () => {
      const patch = buildRelayPatch({
        relayKey: 'rly_abc',
        deviceFingerprint: 'fp',
        existingConfig: snapshot({ agents: { defaults: { model: { primary: 'deepseek/deepseek-v4-flash' } } } }),
        defaultModel: 'clawrouter/bailian/deepseek-v4-flash',
      });

      expect((patch as never as { agents?: unknown }).agents).toBeUndefined();
    });

    it('没解析到模型时不写（宁可让用户自己选，也不写一个猜的 ref）', () => {
      const patch = buildRelayPatch({
        relayKey: 'rly_abc',
        deviceFingerprint: 'fp',
        existingConfig: snapshot({ agents: { defaults: {} } }),
        defaultModel: null,
      });

      expect((patch as never as { agents?: unknown }).agents).toBeUndefined();
    });
  });
});

describe('fetchFirstRelayModel', () => {
  // ref 是**两段**：clawrouter / <catalog 里的 model id>。
  // catalog 里的 provider id（bailian）**不进 ref**。
  //
  // ⚠️ 这是 dev 端到端实测出来的（2026-09-11 起真网关列模型，
  // 得到的是 `clawrouter/deepseek-v4-flash`）。我原先照官方文档的三段例子
  // （clawrouter/openai/gpt-5.5）拼错了 —— 文档那句是「refs retain the
  // upstream namespace」，它那边的 model id 本身就带命名空间。
  const CATALOG = {
    providers: [{ id: 'bailian', models: [{ id: 'deepseek-v4-flash' }, { id: 'qwen3.6-plus' }] }],
  };

  it('拼出两段的模型 ref，不含 catalog 的 provider id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => CATALOG })),
    );
    const { fetchFirstRelayModel } = await import('../src/main/commercial/relay-config.js');

    expect(await fetchFirstRelayModel('rly_abc')).toBe('clawrouter/deepseek-v4-flash');
    vi.unstubAllGlobals();
  });

  it('拿不到就返回 null，不抛', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    const { fetchFirstRelayModel } = await import('../src/main/commercial/relay-config.js');

    expect(await fetchFirstRelayModel('rly_abc')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('catalog 结构不对时返回 null，不拼出半个 ref', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ providers: [{ id: 'bailian', models: [] }] }) })),
    );
    const { fetchFirstRelayModel } = await import('../src/main/commercial/relay-config.js');

    expect(await fetchFirstRelayModel('rly_abc')).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('relay credential removal', () => {
  const relayEntry = { baseUrl: `${RELAY_BASE_URL}/`, apiKey: '__OPENCLAW_REDACTED__' };
  const personalEntry = { baseUrl: 'https://example.test/v1', apiKey: '__OPENCLAW_REDACTED__' };

  it('builds a narrow merge patch that removes only relay-owned values', () => {
    const removal = buildRelayRemovalPatch(
      snapshot({
        models: { providers: { oldRelayName: relayEntry, personal: personalEntry } },
        plugins: { allow: ['oldRelayName', RELAY_PROVIDER_ID, 'personal-plugin'] },
        agents: { defaults: { model: { primary: 'oldRelayName/deepseek-v4-flash' } } },
        unrelated: { secret: '__OPENCLAW_REDACTED__' },
      }),
    );

    expect(removal).toEqual({
      patch: {
        models: { providers: { oldRelayName: null } },
        plugins: { allow: ['personal-plugin'] },
        agents: { defaults: { model: { primary: null } } },
      },
      replacePaths: ['plugins.allow'],
    });
    expect(JSON.stringify(removal)).not.toContain('unrelated');
    expect(JSON.stringify(removal)).not.toContain('example.test');
  });

  it('preserves a default model that does not belong to the removed provider', () => {
    const removal = buildRelayRemovalPatch(
      snapshot({
        models: { providers: { oldRelayName: relayEntry } },
        agents: { defaults: { model: { primary: 'personal/model' } } },
      }),
    );

    expect(removal?.patch).toEqual({ models: { providers: { oldRelayName: null } } });
    expect(removal?.replacePaths).toEqual([]);
  });

  /**
   * ⚠️ 真实世界形状：网关里的 clawrouter provider **带一个 `models` 数组**
   * （2026-09-17 实机：`config.patch would remove entries from array path(s):
   * models.providers.clawrouter.models`）。
   *
   * 网关的规则（`dist/patch-replace-paths-*.mjs` 的 `collectBaseArrayPaths`）：
   * 只要补丁把某个**对象**整个置 null，就必须把该子树下**每一个数组路径**列进
   * `replacePaths`，否则整条 patch 被拒 —— 而这里被拒的后果不是"少清一点"，
   * 是**每秒重试一次、永远清不掉**（见 relay-cleanup 的重试策略）。
   */
  it('declares array paths under a removed provider so the gateway accepts the patch', () => {
    const removal = buildRelayRemovalPatch(
      snapshot({
        models: {
          providers: {
            oldRelayName: {
              baseUrl: `${RELAY_BASE_URL}/`,
              apiKey: '__OPENCLAW_REDACTED__',
              models: [{ id: 'deepseek-v4-flash' }, { id: 'qwen3.5-27b' }],
            },
            personal: personalEntry,
          },
        },
      }),
    );

    expect(removal?.patch).toEqual({ models: { providers: { oldRelayName: null } } });
    expect(removal?.replacePaths).toEqual(['models.providers.oldRelayName.models']);
  });

  it('walks nested arrays under the removed provider, like the gateway does', () => {
    const removal = buildRelayRemovalPatch(
      snapshot({
        models: {
          providers: {
            oldRelayName: {
              baseUrl: `${RELAY_BASE_URL}/`,
              models: [{ id: 'a', aliases: ['a-1'] }],
              hooks: { retries: [] },
            },
          },
        },
      }),
    );

    // 与网关 `collectBaseArrayPaths` 逐字一致：**遇到数组就停**，不往元素里递归
    // （元素内部由另一条 `collectDestructiveIdKeyedArrayEntryPatchPaths` 负责，
    //   只在"就地修改 id 数组"时才算 —— 我们这里是整棵子树删除）。
    expect(removal?.replacePaths).toEqual([
      'models.providers.oldRelayName.models',
      'models.providers.oldRelayName.hooks.retries',
    ]);
  });

  it('returns null when there is no relay residue', () => {
    expect(buildRelayRemovalPatch(snapshot({ models: { providers: { personal: personalEntry } } }))).toBeNull();
  });

  it('patches with null deletion and verifies the relay provider is gone', async () => {
    const getConfig = vi
      .fn()
      .mockResolvedValueOnce(snapshot({ models: { providers: { oldRelayName: relayEntry } } }, 'old-hash'))
      .mockResolvedValueOnce(snapshot({ models: { providers: { personal: personalEntry } } }, 'new-hash'));
    const patchConfig = vi.fn(async () => ({ ok: true }));

    const result = await removeRelayConfig({ getConfig, patchConfig });

    expect(result).toEqual({ ok: true, cleaned: true });
    expect(patchConfig).toHaveBeenCalledWith({
      baseHash: 'old-hash',
      raw: JSON.stringify({ models: { providers: { oldRelayName: null } } }),
      replacePaths: [],
    });
  });
});

describe('applyRelayConfig', () => {
  const INPUT = { relayKey: 'rly_abc', deviceFingerprint: 'fp123' };

  function deps(overrides: Partial<ApplyRelayConfigDeps> = {}): ApplyRelayConfigDeps & {
    getConfig: ReturnType<typeof vi.fn>;
    patchConfig: ReturnType<typeof vi.fn>;
  } {
    return {
      // 默认模拟「网关确实把配置写进去了」——回读能看到它。
      getConfig: vi.fn(async () =>
        snapshot({
          models: { providers: { [RELAY_PROVIDER_ID]: { baseUrl: RELAY_BASE_URL, apiKey: 'rly_abc' } } },
        }),
      ),
      patchConfig: vi.fn(async () => ({ ok: true })),
      ...overrides,
    } as never;
  }

  it('写入成功后回读校验，configured 为 true', async () => {
    const d = deps();
    const res = await applyRelayConfig(d, INPUT);

    expect(res.ok).toBe(true);
    expect(res.configured).toBe(true);
    expect(d.patchConfig).toHaveBeenCalledTimes(1);
    // 回读：getConfig 至少被调用两次（写前后各一次）
    expect(d.getConfig.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('回读发现网关没真的写上时，configured 为 false 而不是假装成功', async () => {
    // 写入「成功」但网关没生效 —— 只信 patchConfig 的返回就会漏掉这种情况。
    const d = deps({
      getConfig: vi.fn(async () => snapshot({ models: { providers: {} } })),
    });
    const res = await applyRelayConfig(d, INPUT);

    expect(res.configured).toBe(false);
    expect(res.errorCode).toBe('verify-failed');
  });

  // ⭐ 这条钉的是**真实网关的形状**，不是理想形状。
  //
  // 打包态 E2E 实测（2026-09-13）：网关 `config.get` 回读到的 raw 里是
  // `"token": "__OPENCLAW_REDACTED__"` —— **秘密是脱敏的**。原先的校验拿 apiKey
  // 和真 key 比，于是**永远 verify-failed**：配置明明已经写进网关的
  // `openclaw.json`（同一轮 E2E 里逐字节确认过），调用方却以为没配上。
  it('⭐ 回读被**脱敏**（apiKey=__OPENCLAW_REDACTED__）仍算配置成功', async () => {
    const d = deps({
      getConfig: vi.fn(async () =>
        snapshot({
          models: { providers: { [RELAY_PROVIDER_ID]: { baseUrl: RELAY_BASE_URL, apiKey: '__OPENCLAW_REDACTED__' } } },
        }),
      ),
    });
    const res = await applyRelayConfig(d, INPUT);

    expect(res.configured).toBe(true);
    expect(res.errorCode).toBeUndefined();
  });

  it('⭐ provider 在、但**没带 key** ⇒ 不算成功（空凭证等于没配上）', async () => {
    const d = deps({
      getConfig: vi.fn(async () =>
        snapshot({ models: { providers: { [RELAY_PROVIDER_ID]: { baseUrl: RELAY_BASE_URL, apiKey: '' } } } }),
      ),
    });
    const res = await applyRelayConfig(d, INPUT);

    expect(res.configured).toBe(false);
    expect(res.errorCode).toBe('verify-failed');
  });

  it('乐观锁冲突时重读快照重试', async () => {
    let calls = 0;
    const d = deps({
      getConfig: vi.fn(async () =>
        // 第一次给旧 hash，第二次给新 hash；且第二次起回读能看到写入结果
        calls === 0
          ? snapshot({}, 'stale')
          : snapshot(
              { models: { providers: { [RELAY_PROVIDER_ID]: { baseUrl: RELAY_BASE_URL, apiKey: 'rly_abc' } } } },
              'fresh',
            ),
      ),
      patchConfig: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('config hash conflict');
        return { ok: true };
      }),
    });
    const res = await applyRelayConfig(d, INPUT);

    expect(res.configured).toBe(true);
    expect(d.patchConfig).toHaveBeenCalledTimes(2);
  });

  it('schema 拒绝**不重试** —— 重试无用，只会白等', async () => {
    const d = deps({
      patchConfig: vi.fn(async () => {
        throw new Error('invalid config: unknown field "api"');
      }),
    });
    const res = await applyRelayConfig(d, INPUT);

    expect(res.configured).toBe(false);
    expect(res.errorCode).toBe('rejected');
    expect(d.patchConfig).toHaveBeenCalledTimes(1);
  });

  it('缺 relayKey 时不碰网关，直接返回未配置', async () => {
    const d = deps();
    const res = await applyRelayConfig(d, { relayKey: null, deviceFingerprint: 'fp' });

    expect(res.configured).toBe(false);
    expect(res.errorCode).toBe('no-key');
    expect(d.patchConfig).not.toHaveBeenCalled();
  });

  it('读配置失败时不抛，返回 transport 错误码', async () => {
    const d = deps({
      getConfig: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    const res = await applyRelayConfig(d, INPUT);

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('transport');
  });

  it('日志里不得出现 relay key', async () => {
    const events: Array<Record<string, unknown>> = [];
    const d = deps({
      getConfig: vi.fn(async () => snapshot({ models: { providers: { clawrouter: { apiKey: 'rly_abc' } } } })),
      patchConfig: vi.fn(async () => ({ ok: true })),
      log: (_e, data) => events.push(data),
    });
    await applyRelayConfig(d, INPUT);

    // patchConfig 的入参里必然有 key（那是要写进去的东西），但**日志**里不能有。
    const logged = JSON.stringify(events);
    expect(logged).not.toContain('rly_abc');
  });
});
