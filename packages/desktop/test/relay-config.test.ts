import { describe, expect, it, vi } from 'vitest';
import {
  webSearchEnabled,
  RELAY_BASE_URL,
  RELAY_PROVIDER_ID,
  applyRelayConfig,
  buildRelayRemovalPatch,
  buildRelayRemovalShrinkPatch,
  buildRelayPatch,
  relayPatchReplacePaths,
  removeRelayConfig,
  relayProviderIds,
  type ApplyRelayConfigDeps,
} from '../src/main/commercial/relay-config.js';
import { RELAY_SEARCH_ENABLED_MODEL_IDS } from '@clawwork/core';

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

      // ⚠️ 判据收窄到 `model`（原先是"整个 agents 不出现"）：
      //    `agents.defaults` 现在还带**联网那张按模型的表**（见文件末尾那组），
      //    所以"整个 agents 不存在"不再成立 —— 但这条测的**本意**是"不许动 primary"，
      //    收窄后反而更准：联网表在不在，与"有没有重设用户偏好"是两件事。
      expect((patch as never as { agents: { defaults: { model?: unknown } } }).agents.defaults.model).toBeUndefined();
    });

    it('没解析到模型时不写（宁可让用户自己选，也不写一个猜的 ref）', () => {
      const patch = buildRelayPatch({
        relayKey: 'rly_abc',
        deviceFingerprint: 'fp',
        existingConfig: snapshot({ agents: { defaults: {} } }),
        defaultModel: null,
      });

      expect((patch as never as { agents: { defaults: { model?: unknown } } }).agents.defaults.model).toBeUndefined();
    });
  });
});

/**
 * 文生图的**最小接线**（2026-09-27）。
 *
 * 复用随包运行时自带的 `openai` 图像 provider，不写插件：把它的 baseUrl 指到我们 relay
 * 的 OpenAI 形状适配端点，再用 `agents.defaults.mediaModels.image.primary` 选中模型。
 *
 * ⚠️ 路径与形状是**从运行时代码里读出来的**，不是从文档推的（本仓栽过一次：
 *    往配置里写一个 schema 不认的键会让**整份配置被判非法**）。
 *    运行时里的依据：`doctor-config-flow` 自己就在写
 *    `agents.defaults.mediaModels.image = { primary: 'google/gemini-3-pro-image-preview' }`。
 */
/**
 * 图片：内置 openai provider 的接线 —— **默认不写**，且只动**我们自己的**那一份。
 *
 * （`src/renderer/**` 有"生产代码不写注释"的规矩，所以设计说明放这里。）
 *
 * ## 两条各自独立、都缺不得的规矩
 *
 * ① **默认 false**：没有明确证据表明服务端图片能力已启用时，一个键都不写。
 *    「先写好开关、服务端以后再说」在这里是**有害**的：写进去之后运行时会认为
 *    "openai provider 已配置"，于是真的会去打我们的 relay，拿到 503 ——
 *    用户看到的是一个**存在但总是失败**的能力，比"没有这个能力"难查得多。
 *
 * ② **严格所有权**：只有「模型 ref 精确等于我们的」**且**「baseUrl 精确等于我们 relay 的 /v1」
 *    时才允许改或清。只按 `openai/` 前缀判断是不够的 ——
 *    用户自己配的 `openai/gpt-image-1` 也带这个前缀，会被我们**覆盖成 qwen-image-1**，
 *    那是把用户手上本来能用的能力换成了一个内测能力，而且他没同意。
 *
 * 聊天那一侧（`agents.defaults.model`、catalog 注入、clawrouter）**逐字不动**。
 */
describe('图片：内置 openai provider 的接线（默认关 + 严格所有权）', () => {
  const providersOf = (patch: unknown): Record<string, Record<string, unknown>> =>
    (patch as { models: { providers: Record<string, Record<string, unknown>> } }).models.providers;
  // ⚠️ 容缺：这条路径**正常就会缺字段**（"什么都没写"是很多用例的预期结果）。
  //    写成直接点下去的话，用例失败时报的是 TypeError，而不是"它到底写了什么"。
  const imagePrimaryOf = (patch: unknown): unknown =>
    (patch as { agents?: { defaults?: { mediaModels?: { image?: { primary?: unknown } } } } })?.agents?.defaults
      ?.mediaModels?.image?.primary;
  const openaiProviderOf = (patch: unknown): Record<string, unknown> | undefined => providersOf(patch).openai;

  /** 一份"我们已经写过"的配置：两个键都是我们写的值。 */
  const ourOwned = (): unknown =>
    snapshot({
      models: { providers: { clawrouter: { baseUrl: RELAY_BASE_URL }, openai: { baseUrl: `${RELAY_BASE_URL}/v1` } } },
      agents: { defaults: { mediaModels: { image: { primary: 'openai/qwen-image-1' } } } },
    });

  // ── ① 默认不写 ────────────────────────────────────────────────────────

  it('⭐ 默认（没给接线证据）⇒ openai provider 与 mediaModels **一个都不写**', () => {
    const patch = buildRelayPatch({ relayKey: 'rly_abc', deviceFingerprint: 'fp' });

    expect(openaiProviderOf(patch), '默认不该写 openai provider').toBeUndefined();
    expect(imagePrimaryOf(patch), '默认不该写 mediaModels').toBeUndefined();
    // 聊天那条照旧要写 —— 默认关的只是图片
    expect(providersOf(patch)[RELAY_PROVIDER_ID].baseUrl).toBe(RELAY_BASE_URL);
  });

  it('⭐ 显式给 false 也一样不写（开关是白的，不是"没传就真"）', () => {
    const patch = buildRelayPatch({ relayKey: 'rly_abc', deviceFingerprint: 'fp', imageGenerationWired: false });
    expect(openaiProviderOf(patch)).toBeUndefined();
    expect(imagePrimaryOf(patch)).toBeUndefined();
  });

  it('没有 relayKey ⇒ 整条 patch 为 null（也就不写图片配置）', () => {
    expect(buildRelayPatch({ relayKey: null, deviceFingerprint: 'fp', imageGenerationWired: true })).toBeNull();
  });

  // ── ② 接线打开之后写什么 ──────────────────────────────────────────────

  it('接线打开 + 配置是干净的 ⇒ 写入 baseUrl（带 /v1）、同一个 relay key、同一个设备头', () => {
    const patch = buildRelayPatch({ relayKey: 'rly_abc', deviceFingerprint: 'fp123', imageGenerationWired: true });
    const provider = openaiProviderOf(patch);

    // ⚠️ `/v1` 不能少：OpenAI 形状的客户端自己在后面接 `/images/generations`，
    //    少一段的请求会打到 `/relay/images/generations` —— 404，而且不解释。
    //    （运行时合同测试实测过：它**不会**自己补这一段。）
    expect(provider?.baseUrl).toBe(`${RELAY_BASE_URL}/v1`);
    expect(provider?.apiKey).toBe('rly_abc');
    expect(provider?.headers).toEqual({ 'X-ClawRouter-Project-Id': 'fp123' });
    expect(imagePrimaryOf(patch)).toBe('openai/qwen-image-1');
  });

  it('⭐⭐ 用户自己配的 `openai/别的模型` + 第三方 baseUrl ⇒ **一个字都不动**', () => {
    // 这条是这一版修掉的真缺陷：原来只按 `openai/` 前缀判断"这是我们的"，
    // 于是用户手上的 gpt-image-1 会被**覆盖**成 qwen-image-1。
    const patch = buildRelayPatch({
      relayKey: 'rly_abc',
      deviceFingerprint: 'fp',
      imageGenerationWired: true,
      existingConfig: snapshot({
        models: { providers: { openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'user-key' } } },
        agents: { defaults: { mediaModels: { image: { primary: 'openai/gpt-image-1' } } } },
      }),
    });

    expect(openaiProviderOf(patch), '不许覆盖用户的第三方 baseUrl').toBeUndefined();
    expect(imagePrimaryOf(patch), '不许把用户的图片模型换成我们的').toBeUndefined();
  });

  it('⭐ baseUrl 是我们的、但模型不是我们的 ⇒ 仍然不动（所有权要**两条同时**成立）', () => {
    const patch = buildRelayPatch({
      relayKey: 'rly_abc',
      deviceFingerprint: 'fp',
      imageGenerationWired: true,
      existingConfig: snapshot({
        models: { providers: { openai: { baseUrl: `${RELAY_BASE_URL}/v1` } } },
        agents: { defaults: { mediaModels: { image: { primary: 'openai/用户自己挑的' } } } },
      }),
    });
    expect(imagePrimaryOf(patch)).toBeUndefined();
  });

  it('⭐ 用户用的是**别的 provider** 的图片模型 ⇒ 不动', () => {
    const patch = buildRelayPatch({
      relayKey: 'rly_abc',
      deviceFingerprint: 'fp',
      imageGenerationWired: true,
      existingConfig: snapshot({
        agents: { defaults: { mediaModels: { image: { primary: 'google/gemini-3-pro-image-preview' } } } },
      }),
    });
    expect(imagePrimaryOf(patch)).toBeUndefined();
  });

  it('配置本来就是我们的 ⇒ 可以更新（内测期模型换了要跟着换）', () => {
    const patch = buildRelayPatch({
      relayKey: 'rly_abc',
      deviceFingerprint: 'fp',
      imageGenerationWired: true,
      existingConfig: ourOwned(),
    });
    expect(imagePrimaryOf(patch)).toBe('openai/qwen-image-1');
    expect(openaiProviderOf(patch)?.apiKey).toBe('rly_abc');
  });

  // ── ③ 绝不动聊天 ──────────────────────────────────────────────────────

  it('⭐⭐ 聊天那一侧**逐字不变**：默认模型、catalog 注入、clawrouter 都不受影响', () => {
    const patch = buildRelayPatch({
      relayKey: 'rly_abc',
      deviceFingerprint: 'fp',
      imageGenerationWired: true,
      existingConfig: snapshot({
        agents: { defaults: { model: { primary: 'clawrouter/deepseek-v4-flash' } } },
        models: { providers: { openai: { baseUrl: 'https://api.openai.com/v1' } } },
      }),
    });
    const defaults = (patch as { agents: { defaults: Record<string, unknown> } }).agents.defaults;

    expect(defaults.model, '不改用户的聊天默认模型').toBeUndefined();
    expect(providersOf(patch)[RELAY_PROVIDER_ID].baseUrl).toBe(RELAY_BASE_URL);
    expect(defaults.models).toEqual({
      'clawrouter/qwen-turbo': { params: { extra_body: { enable_search: true } } },
      'clawrouter/qwen-plus': { params: { extra_body: { enable_search: true } } },
      'clawrouter/qwen3.7-flash': { params: { extra_body: { enable_search: true } } },
    });
  });

  // ── ④ 注销 / 换卡：只清我们自己的 ─────────────────────────────────────

  it('⭐ 注销时**同时**清掉 openai provider 与图像模型指向（少一个的后果很具体）', () => {
    // 少了后半句：provider 没了、`mediaModels.image.primary` 还指着 `openai/qwen-image-1`，
    // 网关会去找一个**不存在**的 provider —— 而本仓栽过一次"配置整体被判非法"。
    const removal = buildRelayRemovalPatch(ourOwned());

    expect(removal).not.toBeNull();
    const providers = (removal!.patch.models as { providers: Record<string, unknown> }).providers;
    expect(providers.clawrouter).toBeNull();
    expect(providers.openai).toBeNull();
    expect(
      (removal!.patch.agents as { defaults: { mediaModels: { image: { primary: unknown } } } }).defaults.mediaModels
        .image.primary,
    ).toBeNull();
  });

  it('⭐⭐ 注销时，用户自己那份 openai 配置**一个字节都不许动**', () => {
    // 用户既有 openai 聊天配置、又有自己的图片模型 —— 清卡不该把它们连根拔掉。
    const removal = buildRelayRemovalPatch(
      snapshot({
        models: {
          providers: {
            clawrouter: { baseUrl: RELAY_BASE_URL },
            openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'user-key' },
          },
        },
        agents: { defaults: { mediaModels: { image: { primary: 'openai/gpt-image-1' } } } },
      }),
    );
    const providers = (removal?.patch.models as { providers: Record<string, unknown> } | undefined)?.providers;
    const agents = (removal?.patch.agents as { defaults?: Record<string, unknown> } | undefined)?.defaults;

    expect(providers?.openai, '别家的 openai provider 不该被清').toBeUndefined();
    expect(providers?.clawrouter, 'clawrouter 是我们的，要清').toBeNull();
    expect(agents?.mediaModels, '别家的图片模型不该被清').toBeUndefined();
  });

  it('⭐ 图像模型指向别家、baseUrl 是别家 ⇒ 注销不许碰它（同一条所有权判据）', () => {
    const removal = buildRelayRemovalPatch(
      snapshot({
        models: { providers: { clawrouter: { baseUrl: RELAY_BASE_URL } } },
        agents: { defaults: { mediaModels: { image: { primary: 'google/gemini-3-pro-image-preview' } } } },
      }),
    );
    const agents = (removal?.patch.agents as { defaults?: Record<string, unknown> } | undefined)?.defaults;
    expect(agents?.mediaModels).toBeUndefined();
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
    providers: [{ id: 'bailian', models: [{ id: 'glm-5.3-flash' }, { id: 'qwen3.6-plus' }] }],
  };

  it('拼出两段的模型 ref，不含 catalog 的 provider id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => CATALOG })),
    );
    const { fetchFirstRelayModel } = await import('../src/main/commercial/relay-config.js');

    expect(await fetchFirstRelayModel('rly_abc')).toBe('clawrouter/glm-5.3-flash');
    vi.unstubAllGlobals();
  });

  /**
   * ⭐ 默认模型**只能有一处定义**。
   *
   * 2026-09-17 实机：激活时这里取的是**中转目录第一条**（qwen3.5-27b），
   * 而 composer 显示的是商业默认（当时 deepseek-v4-flash）—— 同一个"默认"两个值，
   * 于是用户看到的模型和实际生成消息的模型对不上（徽章显示 qwen，用户以为买了 Kimi 跑 glm）。
   * 这条测试把两边钉成同一个 id。
   *
   * 2026-10-10 Cephalon 批：商业默认迁到 `glm-5.3-flash`（`COMMERCIAL_DEFAULT_MODEL_ID`），
   * 判据不变 —— 目录第一条不是商业默认时，仍优先取商业默认。
   */
  it('目录第一条不是商业默认时，也优先取商业默认（与 composer 显示保持一致）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          providers: [{ id: 'bailian', models: [{ id: 'qwen3.5-27b' }, { id: 'glm-5.3-flashx' }] }],
        }),
      })),
    );
    const { fetchFirstRelayModel } = await import('../src/main/commercial/relay-config.js');

    expect(await fetchFirstRelayModel('rly_abc')).toBe('clawrouter/glm-5.3-flashx');
    vi.unstubAllGlobals();
  });

  it('目录里没有商业默认时才退回第一条（不能因此不写）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ providers: [{ id: 'bailian', models: [{ id: 'qwen3.5-27b' }] }] }),
      })),
    );
    const { fetchFirstRelayModel } = await import('../src/main/commercial/relay-config.js');

    expect(await fetchFirstRelayModel('rly_abc')).toBe('clawrouter/qwen3.5-27b');
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

/**
 * 2026-10-14 实机（BUG-080）：网关的 `size-drop` 写守卫把**合法清账**当成
 * "疑似误删整份配置"拒掉 —— openclaw.json 20901B，删掉带模型目录快照的
 * clawrouter 后剩 8542B（40.9% < 50% 阈值）。拒绝是确定性的（重试无用），
 * 但**分段收缩**可以过：先按条数减半大数组，再整删。
 */
describe('relay credential removal · size-drop 分段收缩（BUG-080）', () => {
  const sizeDropError = () =>
    new Error(
      'Config write rejected: /tmp/openclaw.json (size-drop:20901->8542). ' +
        'Rejected payload saved to /tmp/openclaw.json.rejected.2026-10-14T10-14-45-773Z.: code=CONFIG_WRITE_REJECTED',
    );

  const models16 = Array.from({ length: 16 }, (_, i) => ({ id: `m${i}` }));
  const relayWithModels = (models: unknown[]) => ({
    baseUrl: `${RELAY_BASE_URL}/`,
    apiKey: '__OPENCLAW_REDACTED__',
    models,
  });

  it('整体删除被 size-drop 拒 → 先把 models 减半（16→8）→ 再整删成功', async () => {
    const s1 = snapshot({ models: { providers: { clawrouter: relayWithModels(models16) } } }, 'h1');
    const s2 = snapshot({ models: { providers: { clawrouter: relayWithModels(models16.slice(0, 8)) } } }, 'h2');
    const s3 = snapshot({ models: { providers: {} } }, 'h3');
    const getConfig = vi.fn().mockResolvedValueOnce(s1).mockResolvedValueOnce(s2).mockResolvedValueOnce(s3);
    const patchConfig = vi.fn().mockRejectedValueOnce(sizeDropError()).mockResolvedValue({ ok: true });

    const result = await removeRelayConfig({ getConfig, patchConfig });

    expect(result).toEqual({ ok: true, cleaned: true });
    expect(patchConfig).toHaveBeenCalledTimes(3);
    // 第 2 次 = 减半补丁：保留前 8 条 + 声明 replacePaths（replace 语义，否则按 id 合并无效）
    expect(patchConfig.mock.calls[1]![0]).toEqual({
      baseHash: 'h1',
      raw: JSON.stringify({ models: { providers: { clawrouter: { models: models16.slice(0, 8) } } } }),
      replacePaths: ['models.providers.clawrouter.models'],
    });
    // 第 3 次 = 收缩后的快照上做整删
    expect(patchConfig.mock.calls[2]![0].baseHash).toBe('h2');
    expect(JSON.parse(patchConfig.mock.calls[2]![0].raw as string)).toEqual({
      models: { providers: { clawrouter: null } },
    });
  });

  it('收缩写也被拒（非 size-drop）→ fail-closed 返回 rejected，不再循环', async () => {
    const s1 = snapshot({ models: { providers: { clawrouter: relayWithModels(models16) } } }, 'h1');
    const getConfig = vi.fn().mockResolvedValue(s1);
    const patchConfig = vi
      .fn()
      .mockRejectedValueOnce(sizeDropError())
      .mockRejectedValueOnce(new Error('invalid config: unknown key "models.providers.clawrouter.models"'));

    const result = await removeRelayConfig({ getConfig, patchConfig });

    expect(result.ok).toBe(false);
    expect(result.cleaned).toBe(false);
    expect(result.errorCode).toBe('rejected');
    expect(patchConfig).toHaveBeenCalledTimes(2);
  });

  it('没有可收缩的大数组时 size-drop 直接返回 rejected（保持原语义）', async () => {
    const s1 = snapshot({ models: { providers: { clawrouter: { baseUrl: `${RELAY_BASE_URL}/` } } } }, 'h1');
    const getConfig = vi.fn().mockResolvedValue(s1);
    const patchConfig = vi.fn().mockRejectedValue(sizeDropError());

    const result = await removeRelayConfig({ getConfig, patchConfig });

    expect(result.errorCode).toBe('rejected');
    expect(patchConfig).toHaveBeenCalledTimes(1);
  });

  it('非 size-drop 的 rejected 不触发收缩（schema 拒绝仍是死路）', async () => {
    const s1 = snapshot({ models: { providers: { clawrouter: relayWithModels(models16) } } }, 'h1');
    const getConfig = vi.fn().mockResolvedValue(s1);
    const patchConfig = vi.fn().mockRejectedValue(new Error('invalid config: duplicated id'));

    const result = await removeRelayConfig({ getConfig, patchConfig });

    expect(result.errorCode).toBe('rejected');
    expect(patchConfig).toHaveBeenCalledTimes(1);
  });

  it('buildRelayRemovalShrinkPatch：16→8，5→2（floor），1→null 删键', () => {
    const shrink = (n: number) => {
      const models = Array.from({ length: n }, (_, i) => ({ id: `m${i}` }));
      return buildRelayRemovalShrinkPatch(snapshot({ models: { providers: { clawrouter: relayWithModels(models) } } }));
    };

    expect(shrink(16)?.patch).toEqual({
      models: {
        providers: { clawrouter: { models: Array.from({ length: 16 }, (_, i) => ({ id: `m${i}` })).slice(0, 8) } },
      },
    });
    expect(shrink(5)?.patch).toEqual({
      models: { providers: { clawrouter: { models: [{ id: 'm0' }, { id: 'm1' }] } } },
    });
    expect(shrink(1)?.patch).toEqual({ models: { providers: { clawrouter: { models: null } } } });
    expect(shrink(16)?.replacePaths).toEqual(['models.providers.clawrouter.models']);
  });

  /**
   * T28 / BUG-080 反例：**重现 >50% 缩小条件后登出 → 重登同进程进入业务**。
   *
   * 上面几条用的是脚本化的 `mockResolvedValueOnce` 串 —— 它们能证明"收缩补丁长什么样"，
   * 却**证不了**"这两个动作在同一个网关/同一份配置上接得起来"。真正上线跑的是**一条链**：
   *   登出 → 清账（撞 size-drop 守卫 → 分段收缩）→ 登录 → 重新写配置 → 业务可用。
   *
   * 所以这里用**有状态的假网关**（真做 JSON merge patch、真按 50% 阈值拒），跑完整往返。
   */
  describe('T28 反例：size-drop 清账 → 同进程重登进入业务（有状态假网关）', () => {
    /** 极简 JSON merge patch：`null` = 删键；数组整体替换。 */
    function mergePatch(target: unknown, patch: unknown): unknown {
      if (patch === null) return undefined;
      if (typeof patch !== 'object' || Array.isArray(patch)) return patch;
      const base =
        target && typeof target === 'object' && !Array.isArray(target)
          ? { ...(target as Record<string, unknown>) }
          : {};
      for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
        const next = mergePatch((base as Record<string, unknown>)[key], value);
        if (next === undefined) delete (base as Record<string, unknown>)[key];
        else (base as Record<string, unknown>)[key] = next;
      }
      return base;
    }

    /** 假网关：真应用补丁，并**按真实阈值**（缩小到不足上次一半）拒写。 */
    function fakeGateway(initial: Record<string, unknown>) {
      let state = JSON.parse(JSON.stringify(initial)) as Record<string, unknown>;
      let revision = 1;
      const attempts: Array<{ before: number; after: number; rejected: boolean }> = [];
      const gateway = {
        getConfig: async () => snapshot(state, `h${revision}`),
        patchConfig: async ({ raw }: { raw: string }) => {
          const patched = mergePatch(state, JSON.parse(raw)) as Record<string, unknown>;
          const before = JSON.stringify(state).length;
          const after = JSON.stringify(patched).length;
          const rejected = after < before * 0.5;
          attempts.push({ before, after, rejected });
          if (rejected) {
            throw new Error(
              `Config write rejected: /tmp/openclaw.json (size-drop:${before}->${after}). code=CONFIG_WRITE_REJECTED`,
            );
          }
          state = patched;
          revision += 1;
          return { ok: true };
        },
        state: () => state,
        attempts: () => attempts,
      };
      return gateway;
    }

    /**
     * 一份**比例贴近真实盘**的中转配置。
     *
     * 真实盘上 openclaw.json 是 20901B，删掉 clawrouter 后剩 8542B（40.9% ⇒ 撞守卫）；
     * 而**非中转内容（agents / skills / …）必须足够大**，否则"整删 → 减半 → 再整删"
     * 这条链收敛不了：减半后配置已经很小，再删整块仍然会跌破 50%。
     *
     * 收敛条件（R = 中转块，P = 其余）：整删被拒 ⇔ P/(R+P) < 0.5；减半后整删被放行 ⇔
     * P ≥ R/2。这里取 P ≈ 0.6R —— 既复现真实拒绝，又保证分段收缩真的能走完。
     */
    const bigRelayConfig = (apiKey: string) => {
      const relay = {
        models: {
          providers: {
            clawrouter: {
              baseUrl: RELAY_BASE_URL,
              apiKey,
              models: Array.from({ length: 16 }, (_, i) => ({
                id: `model-${i}`,
                name: `Model number ${i}`,
                reasoning: true,
                input: ['text', 'image'],
                compat: { supportsReasoningEffort: true, supportedReasoningEfforts: ['low', 'medium', 'high', 'max'] },
                thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
              })),
            },
          },
        },
      };
      const padding = 'x'.repeat(Math.ceil(JSON.stringify(relay).length * 0.6));
      return { ...relay, skills: { bundled: { blob: padding } } };
    };

    it('⭐⭐ 登出清账撞 size-drop → 分段收缩成功；**同进程重登**能把配置重新写上并进入业务', async () => {
      const gw = fakeGateway(bigRelayConfig('rly_OLD_ACCOUNT_KEY'));

      // ① 登出：清掉上一账号的中转配置（带 16 条模型的目录快照 ⇒ 必然撞 50% 守卫）。
      const cleanup = await removeRelayConfig(gw);
      expect(cleanup).toEqual({ ok: true, cleaned: true });
      // 前置**实证**：这一次清账确实走过"被拒 → 分段收缩 → 成功"三段，
      // 而不是因为夹具不够大而一路顺风（那样等于没复现这个条件）。
      const attempts = gw.attempts();
      expect(attempts.map((a) => a.rejected)).toEqual([true, false, false]);
      // 原账号凭据**撤出**：provider 没了，key 也不再出现在配置里。
      expect(JSON.stringify(gw.state())).not.toContain('rly_OLD_ACCOUNT_KEY');
      expect(relayProviderIds(await gw.getConfig())).toEqual(new Set());

      // ② 同进程重登：新账号的 key 写进来，业务重新可用。
      const reapply = await applyRelayConfig(
        {
          getConfig: gw.getConfig,
          patchConfig: gw.patchConfig,
          resolveCatalogModels: async () =>
            [
              {
                id: 'deepseek-v4-pro',
                name: 'DeepSeek',
                reasoning: true,
                input: ['text'],
                compat: { supportsReasoningEffort: true as const, supportedReasoningEfforts: ['low', 'high', 'max'] },
                thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
              },
            ] as never,
        } as never,
        { relayKey: 'rly_NEW_ACCOUNT_KEY', deviceFingerprint: 'fp-new' },
      );

      expect(reapply.configured).toBe(true);
      const after = gw.state();
      expect(JSON.stringify(after)).toContain('rly_NEW_ACCOUNT_KEY');
      expect(JSON.stringify(after)).not.toContain('rly_OLD_ACCOUNT_KEY');
      // 目录**整体替换**：上一账号的 16 条不许残留（否则模型列表会串账号）。
      const providers = (after.models as { providers: Record<string, { models?: Array<{ id: string }> }> }).providers;
      expect(providers.clawrouter?.models?.map((m) => m.id)).toEqual(['deepseek-v4-pro']);
      expect(relayProviderIds(await gw.getConfig())).toEqual(new Set([RELAY_PROVIDER_ID]));
    });

    it('⭐ 清账后**没有** pending 残留：再跑一次清账是 no-op（不会反复撞守卫）', async () => {
      const gw = fakeGateway(bigRelayConfig('rly_OLD_ACCOUNT_KEY'));
      expect(await removeRelayConfig(gw)).toEqual({ ok: true, cleaned: true });
      expect(await removeRelayConfig(gw)).toEqual({ ok: true, cleaned: true });
    });
  });

  it('buildRelayRemovalShrinkPatch：不碰用户自己的 provider；无料可收时返回 null', () => {
    // 用户自己的 openai（baseUrl 不是我们的）—— 即便有 models 数组也不许动
    expect(
      buildRelayRemovalShrinkPatch(
        snapshot({
          models: {
            providers: {
              openai: { baseUrl: 'https://api.openai.com/v1', models: [{ id: 'gpt-image-1' }, { id: 'x' }] },
            },
          },
        }),
      ),
    ).toBeNull();
    expect(buildRelayRemovalShrinkPatch(snapshot({ models: { providers: {} } }))).toBeNull();
    expect(buildRelayRemovalShrinkPatch(snapshot({}))).toBeNull();
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

  it('⭐ 网关丢掉 thinkingLevelMap 的 null 键，不得被判成「没应用」（2026-10-16 r14 实机：准备页卡 33% / verify-failed）', async () => {
    // 补丁侧刻意写满 7 档、不支持的 = null（`buildThinkingLevelMap` 与内核同构）；
    // 而**真实网关持久化时会丢掉值为 null 的键**（实测盘上 16 条里 9 条缺键）。
    // 校验若用 `current.map?.[level] === effort` 严格比，就会变成 `undefined === null` ⇒ 恒假。
    const catalog = [
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek',
        reasoning: true,
        input: ['text'] as Array<'text' | 'image'>,
        compat: {
          supportsReasoningEffort: true as const,
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max',
        },
      },
    ];
    const appliedWithoutNulls = {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek',
      reasoning: true,
      input: ['text'],
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      // 关键：值为 null 的键被网关丢掉，只剩受支持的档位。
      thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    };
    const d = deps({
      resolveCatalogModels: async () => catalog as never,
      getConfig: vi.fn(async () =>
        snapshot({
          models: {
            providers: {
              [RELAY_PROVIDER_ID]: { baseUrl: RELAY_BASE_URL, apiKey: 'rly_abc', models: [appliedWithoutNulls] },
            },
          },
        }),
      ),
    });

    expect((await applyRelayConfig(d, INPUT)).configured).toBe(true);
  });

  /**
   * T03：思考档位回读的**四类必须可区分**（BUG-098 的对照与回归护栏）。
   *
   * 背景（2026-10-16 r14 实机）：补丁侧把 7 个档位写满、不支持的写 `null`（与内核同构），
   * 但**网关持久化时会把值为 `null` 的键丢掉**。原来的严格比较
   * `current.map?.[level] === effort` 在"缺键"上变成 `undefined === null` ⇒ 恒假 ⇒
   * 整轮准备必失败（与网关有没有应用无关）。
   *
   * ⚠️ 归一化的**风险**是"把真错误也一起放过"。所以这组用例把五类摆在一起，要求：
   *    丢 null 键 / 保留 null 键 ⇒ 成功；值不同 / 该有值却缺键 / 不支持却给了值 /
   *    缺模型 / 能力降级 ⇒ 失败。
   *    任何一条反过来 = 修法越界（要么仍误判，要么"错配置也判成功"）。
   */
  describe('思考档位回读：丢键/保键/真错/缺模型/降级 — 必须可区分（T03）', () => {
    const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
    /** 与 `buildThinkingLevelMap` 同构：7 档写满、不支持的写 null。 */
    const ENTRY = {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek',
      reasoning: true,
      input: ['text'] as Array<'text' | 'image'>,
      compat: { supportsReasoningEffort: true as const, supportedReasoningEfforts: [...EFFORTS] as string[] },
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max',
      } as Record<string, string | null>,
    };
    /** 网关原样保留完整 7 键（含 null 值）。 */
    const keptNulls = (): Record<string, unknown> => ({ ...ENTRY, thinkingLevelMap: { ...ENTRY.thinkingLevelMap } });
    /** 网关丢掉了值为 null 的键，只剩受支持的 5 档。 */
    const droppedNulls = (): Record<string, unknown> => ({
      ...ENTRY,
      thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    });

    /** 用一份 `resolveCatalogModels` = 期望条目，跑一轮；回读固定为 `current`。 */
    const applyWith = (current: unknown) =>
      applyRelayConfig(
        deps({
          resolveCatalogModels: async () => [{ ...ENTRY, thinkingLevelMap: { ...ENTRY.thinkingLevelMap } }] as never,
          getConfig: vi.fn(async () =>
            snapshot({
              models: {
                providers: {
                  [RELAY_PROVIDER_ID]: { baseUrl: RELAY_BASE_URL, apiKey: 'rly_abc', models: [current] },
                },
              },
            }),
          ),
        }),
        INPUT,
      );

    it('① 网关**丢掉了 null 键** ⇒ 配置成功（BUG-098 的正例）', async () => {
      expect((await applyWith(droppedNulls())).configured).toBe(true);
    });

    it('② 网关**原样保留 null 键** ⇒ 同样配置成功（新/旧网关都要能过）', async () => {
      expect((await applyWith(keptNulls())).configured).toBe(true);
    });

    it('③-1 真档位错误：受支持档位的**值不同**（max 从 `max` 变成 `high`）⇒ 不算成功', async () => {
      const wrong = droppedNulls();
      (wrong as { thinkingLevelMap: Record<string, string | null> }).thinkingLevelMap.max = 'high';
      const res = await applyWith(wrong);
      expect(res.configured).toBe(false);
      expect(res.errorCode).toBe('verify-failed');
    });

    it('③-2 真档位错误：**该有值的键整个丢了**（max 缺失）⇒ 不算成功（不许把"缺失"一律当 null）', async () => {
      const wrong = droppedNulls();
      delete (wrong as { thinkingLevelMap: Record<string, string | null> }).thinkingLevelMap.max;
      const res = await applyWith(wrong);
      expect(res.configured).toBe(false);
      expect(res.errorCode).toBe('verify-failed');
    });

    it('③-3 真档位错误：补丁说**不支持**（null），网关却给了个真值（off=minimal）⇒ 不算成功', async () => {
      const wrong = keptNulls();
      (wrong as { thinkingLevelMap: Record<string, string | null> }).thinkingLevelMap.off = 'minimal';
      const res = await applyWith(wrong);
      expect(res.configured).toBe(false);
      expect(res.errorCode).toBe('verify-failed');
    });

    it('④-1 缺模型：网关那条目录**换成了别的 id** ⇒ 不算成功', async () => {
      const res = await applyWith({ ...droppedNulls(), id: 'someone-else-model' });
      expect(res.configured).toBe(false);
      expect(res.errorCode).toBe('verify-failed');
    });

    it('④-2 缺模型：网关**一条目录都没有** ⇒ 不算成功', async () => {
      const res = await applyWith(undefined);
      expect(res.configured).toBe(false);
      expect(res.errorCode).toBe('verify-failed');
    });

    it('⑤-1 能力降级：`supportsReasoningEffort` 从 true 掉成 false ⇒ 不算成功', async () => {
      const degraded = droppedNulls();
      (degraded as { compat: Record<string, unknown> }).compat = {
        supportsReasoningEffort: false,
        supportedReasoningEfforts: [...EFFORTS],
      };
      const res = await applyWith(degraded);
      expect(res.configured).toBe(false);
      expect(res.errorCode).toBe('verify-failed');
    });

    it('⑤-2 能力降级：`supportedReasoningEfforts` **少档**（5 → 2）⇒ 不算成功', async () => {
      const degraded = droppedNulls();
      (degraded as { compat: Record<string, unknown> }).compat = {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ['low', 'medium'],
      };
      const res = await applyWith(degraded);
      expect(res.configured).toBe(false);
      expect(res.errorCode).toBe('verify-failed');
    });

    it('⭐⭐ 五类**互相可区分**：成功/失败两组的判据不能互相塌缩', async () => {
      const outcomes = {
        丢null键: (await applyWith(droppedNulls())).configured,
        保null键: (await applyWith(keptNulls())).configured,
        值不同: (await applyWith({ ...droppedNulls(), thinkingLevelMap: { low: 'low', max: 'high' } })).configured,
        缺模型: (await applyWith(undefined)).configured,
      };
      expect(outcomes).toEqual({ 丢null键: true, 保null键: true, 值不同: false, 缺模型: false });
    });
  });

  it.each([undefined, ['text']])('视觉input回读缺失/降级不能报告配置成功 (%s)', async (input) => {
    const expected = {
      id: 'glm-5.3-flash',
      name: 'GLM',
      reasoning: false,
      input: ['text', 'image'] as Array<'text' | 'image'>,
    };
    const d = deps({
      resolveCatalogModels: async () => [expected],
      getConfig: vi.fn(async () =>
        snapshot({
          models: {
            providers: {
              clawrouter: {
                baseUrl: RELAY_BASE_URL,
                apiKey: '__OPENCLAW_REDACTED__',
                models: [{ ...expected, input }],
              },
            },
          },
        }),
      ),
    });
    const result = await applyRelayConfig(d, INPUT);
    expect(result.configured).toBe(false);
    expect(result.errorCode).toBe('verify-failed');
  });

  it('回读允许runtime补缺省字段与对象键重排，但保留视觉和max声明', async () => {
    const expected = {
      id: 'glm-5.3-flash',
      name: 'GLM',
      reasoning: true,
      input: ['text', 'image'] as Array<'text' | 'image'>,
      compat: { supportsReasoningEffort: true as const, supportedReasoningEfforts: ['high', 'max'] },
      thinkingLevelMap: { high: 'high', max: 'max' },
    };
    const current = {
      ...expected,
      input: ['image', 'text'],
      contextWindow: 200000,
      maxTokens: 8192,
      compat: { supportedReasoningEfforts: ['high', 'max'], supportsReasoningEffort: true },
      thinkingLevelMap: { max: 'max', high: 'high' },
    };
    const d = deps({
      resolveCatalogModels: async () => [expected],
      getConfig: vi.fn(async () =>
        snapshot({
          models: {
            providers: { clawrouter: { baseUrl: RELAY_BASE_URL, apiKey: '__OPENCLAW_REDACTED__', models: [current] } },
          },
        }),
      ),
    });
    expect((await applyRelayConfig(d, INPUT)).configured).toBe(true);
    current.thinkingLevelMap.max = 'high';
    expect((await applyRelayConfig(d, INPUT)).configured).toBe(false);
  });

  it('可信空目录若网关保留旧模型则回读失败', async () => {
    const d = deps({
      resolveCatalogModels: async () => [],
      getConfig: vi.fn(async () =>
        snapshot({
          models: {
            providers: {
              clawrouter: {
                baseUrl: RELAY_BASE_URL,
                apiKey: '__OPENCLAW_REDACTED__',
                models: [{ id: 'removed', input: ['text', 'image'] }],
              },
            },
          },
        }),
      ),
    });
    expect((await applyRelayConfig(d, INPUT)).configured).toBe(false);
    expect(JSON.parse(d.patchConfig.mock.calls[0]![0].raw)).toHaveProperty('models.providers.clawrouter.models', []);
  });

  it('启动刷新旧静态模型input，并移除目录已下架模型', async () => {
    const fresh = [
      { id: 'glm-5.3-flash', name: 'GLM', reasoning: false, input: ['text', 'image'] as Array<'text' | 'image'> },
    ];
    let state: Record<string, unknown> = {
      models: {
        providers: {
          clawrouter: {
            baseUrl: RELAY_BASE_URL,
            apiKey: '__OPENCLAW_REDACTED__',
            models: [{ id: 'glm-5.3-flash' }, { id: 'removed', input: ['text', 'image'] }],
          },
        },
      },
    };
    const d = deps({
      resolveCatalogModels: async () => fresh,
      getConfig: vi.fn(async () => snapshot(state)),
      patchConfig: vi.fn(async ({ raw }: { raw: string }) => {
        state = JSON.parse(raw) as Record<string, unknown>;
        return { ok: true };
      }),
    });
    expect((await applyRelayConfig(d, INPUT)).configured).toBe(true);
    expect(state).toHaveProperty('models.providers.clawrouter.models', fresh);
  });

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

  /**
   * T03 诊断口径：`verify-failed` 是**确定性失败**，现场必须能**逐项归因**。
   *
   * r14 实机的教训：界面与日志只有一句 `verified:false` / "gateway did not apply
   * the relay config"，而"网关真的没写"和"写了但目录条目对不上"是**两种成因、两种修法**。
   * 这四个谓词的分项结果 + 期望/实际模型 id 是唯一的定位线索（BUG-098 就是这么查出来的）。
   */
  describe('回读失败的诊断口径：四谓词分项 + 模型 id（T03）', () => {
    const ENTRY = {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek',
      reasoning: true,
      input: ['text'] as Array<'text' | 'image'>,
      thinkingLevelMap: { low: 'low', max: 'max' } as Record<string, string | null>,
    };
    const captureLog = () => {
      const events: Array<[string, Record<string, unknown>]> = [];
      return { events, log: (event: string, data: Record<string, unknown>) => events.push([event, data]) };
    };

    it('⭐ 网关整条 provider 都没写 ⇒ 诊断点名 provider(/catalog) 假，且给出期望 vs 实际模型 id', async () => {
      const { events, log } = captureLog();
      const d = deps({
        resolveCatalogModels: async () => [ENTRY] as never,
        getConfig: vi.fn(async () => snapshot({ models: { providers: {} } })),
        log,
      });
      const res = await applyRelayConfig(d, INPUT);

      expect(res.configured).toBe(false);
      const entry = events.find(([event]) => event === 'relay.config-verify-failed');
      expect(entry, '必须有 relay.config-verify-failed 诊断事件').toBeTruthy();
      const data = entry![1] as {
        verdict: Record<string, boolean>;
        expectedModels: string[];
        appliedModels: unknown[];
      };
      expect(data.verdict.provider).toBe(false);
      expect(data.verdict.catalog).toBe(false);
      expect(data.expectedModels).toEqual(['deepseek-v4-pro']);
      expect(data.appliedModels).toEqual([]);
    });

    it('⭐ provider 写了、只有目录条目对不上 ⇒ 诊断能**点名 catalog**，不与"整条没写"混为一谈', async () => {
      const { events, log } = captureLog();
      const d = deps({
        resolveCatalogModels: async () => [ENTRY] as never,
        getConfig: vi.fn(async () =>
          snapshot({
            models: {
              providers: {
                [RELAY_PROVIDER_ID]: {
                  baseUrl: RELAY_BASE_URL,
                  apiKey: 'rly_abc',
                  // provider 对了，但目录条目丢了 max 档 ⇒ 只有 catalog 谓词该假。
                  models: [{ ...ENTRY, thinkingLevelMap: { low: 'low', max: 'high' } }],
                },
              },
            },
          }),
        ),
        log,
      });
      const res = await applyRelayConfig(d, INPUT);

      expect(res.configured).toBe(false);
      const entry = events.find(([event]) => event === 'relay.config-verify-failed');
      expect(entry).toBeTruthy();
      const verdict = (entry![1] as { verdict: Record<string, boolean> }).verdict;
      expect(verdict.provider).toBe(true);
      expect(verdict.catalog).toBe(false);
    });
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

  it('⭐ 真网关的 CAS 文案没有 hash 一词：冷启预置助手并发改配置时也必须重读重试', async () => {
    let calls = 0;
    const d = deps({
      getConfig: vi.fn(async () =>
        calls === 0
          ? snapshot({}, 'stale')
          : snapshot(
              { models: { providers: { [RELAY_PROVIDER_ID]: { baseUrl: RELAY_BASE_URL, apiKey: 'rly_abc' } } } },
              'fresh',
            ),
      ),
      patchConfig: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('config changed since last load; re-run config.get and retry');
        return { ok: true };
      }),
    });

    const res = await applyRelayConfig(d, INPUT);

    expect(res.configured).toBe(true);
    expect(res.errorCode).toBeUndefined();
    expect(d.patchConfig).toHaveBeenCalledTimes(2);
    expect(d.getConfig).toHaveBeenCalledTimes(3);
    expect(d.patchConfig).toHaveBeenNthCalledWith(2, expect.objectContaining({ baseHash: 'fresh' }));
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

/**
 * 联网：百炼内置 `enable_search`。
 *
 * 通道（读随包运行时确认，`dist/extra-params-*.mjs`）：配置里**只有**
 * `params.extra_body` 会被 `Object.assign` 合并进真正发出去的 payload
 * （且必须是普通对象，否则 warn + 忽略）⇒ 裸写 `params.enable_search` 会被**静默丢弃**。
 * 挂点是**按模型**的：`agents.defaults.models["clawrouter/<model>"].params.extra_body`。
 *
 * ⚠️ 只给**支持它的模型**开：对不支持的模型（deepseek / glm / kimi / doubao …）
 *    百炼是**直接报错** `This model does not support enable_search.`，不是忽略 ——
 *    所以"全局开"会把不支持的模型全打挂。
 */
describe('联网：按模型注入 enable_search', () => {
  const agentsDefaults = (patch: unknown): { models?: Record<string, unknown>; model?: unknown } =>
    (patch as { agents: { defaults: Record<string, unknown> } }).agents.defaults;

  it('⭐ 支持的模型（qwen-turbo / qwen-plus / qwen3.7-flash）带上 params.extra_body.enable_search', () => {
    const patch = buildRelayPatch({ relayKey: 'rly_abc', deviceFingerprint: 'fp' });

    const models = agentsDefaults(patch).models as Record<string, { params: Record<string, unknown> }>;
    expect(models['clawrouter/qwen-turbo'].params).toEqual({ extra_body: { enable_search: true } });
    expect(models['clawrouter/qwen-plus'].params).toEqual({ extra_body: { enable_search: true } });
    expect(models['clawrouter/qwen3.7-flash'].params).toEqual({ extra_body: { enable_search: true } });
  });

  it('⭐ 只列支持的那几个 —— 多一个都会让上游 400', () => {
    const patch = buildRelayPatch({ relayKey: 'rly_abc', deviceFingerprint: 'fp' });

    expect(Object.keys(agentsDefaults(patch).models ?? {}).sort()).toEqual([
      'clawrouter/qwen-plus',
      'clawrouter/qwen-turbo',
      'clawrouter/qwen3.7-flash',
    ]);
  });

  it('⭐ Cephalon 批：GLM-5.3-Flash 与新 DeepSeek 渠道都不在联网白名单（默认三档/PPT 链不带 enable_search）', () => {
    const patch = buildRelayPatch({ relayKey: 'rly_abc', deviceFingerprint: 'fp', webSearch: true });

    const models = agentsDefaults(patch).models ?? {};
    expect(Object.keys(models)).not.toContain('clawrouter/glm-5.3-flash');
    expect(Object.keys(models)).not.toContain('clawrouter/deepseek-v4-flash-cephalon');
    expect(JSON.stringify(models)).not.toContain('glm-5.3-flash');
    expect(JSON.stringify(models)).not.toContain('deepseek-v4-flash-cephalon');
  });

  it('⭐ 两处白名单同步（core 能力快照 ≡ relay-config 注入真源）：都保持旧 Qwen 三件套、都不含 GLM/新 DeepSeek', () => {
    // core 的 RELAY_SEARCH_ENABLED_MODEL_IDS 是状态推导用的判据快照；
    // relay-config 的 ENABLE_SEARCH_MODEL_IDS 是注入真源 —— 两边必须一致（上面两条钉注入面）。
    expect([...RELAY_SEARCH_ENABLED_MODEL_IDS].sort()).toEqual(['qwen-plus', 'qwen-turbo', 'qwen3.7-flash']);
    expect(RELAY_SEARCH_ENABLED_MODEL_IDS).not.toContain('glm-5.3-flash');
    expect(RELAY_SEARCH_ENABLED_MODEL_IDS).not.toContain('deepseek-v4-flash-cephalon');
  });

  it('⭐⭐ 快速档别名 qwen3.7-flash-fast **刻意不进白名单**（"快速档搜索硬关"就靠这一条）', () => {
    // 机制：enable_search 只认模型级配置，快速档用一个不进白名单的别名 id
    // （relay 目录里的 qwen3.7-flash-fast，upstream 指向 qwen3.7-flash）——
    // 没有任何一处参数注入，搜索在上游就是关的。
    const patch = buildRelayPatch({ relayKey: 'rly_abc', deviceFingerprint: 'fp', webSearch: true });

    const models = agentsDefaults(patch).models ?? {};
    expect(Object.keys(models)).not.toContain('clawrouter/qwen3.7-flash-fast');
    // 兜底：整张表里不许以任何形状出现别名 id
    expect(JSON.stringify(models)).not.toContain('qwen3.7-flash-fast');
  });

  it('⭐ 形状必须是 params.extra_body（裸 params.enable_search 会被静默丢掉）', () => {
    const patch = buildRelayPatch({ relayKey: 'rly_abc', deviceFingerprint: 'fp' });

    const entry = (agentsDefaults(patch).models as Record<string, { params: Record<string, unknown> }>)[
      'clawrouter/qwen-turbo'
    ];
    expect(entry.params).not.toHaveProperty('enable_search');
    expect(entry.params.extra_body).toEqual({ enable_search: true });
  });

  it('缺 relayKey 时连这张表都不写（宁可不写，也不写半个配置）', () => {
    expect(buildRelayPatch({ relayKey: null, deviceFingerprint: 'fp' })).toBeNull();
  });

  it('与默认模型互不干扰：primary 已设置时，仍然写联网表而不碰 primary', () => {
    const patch = buildRelayPatch({
      relayKey: 'rly_abc',
      deviceFingerprint: 'fp',
      existingConfig: snapshot({ agents: { defaults: { model: { primary: 'deepseek/deepseek-v4-flash' } } } }),
      defaultModel: 'clawrouter/bailian/deepseek-v4-flash',
    });

    expect(agentsDefaults(patch).model).toBeUndefined();
    expect(Object.keys(agentsDefaults(patch).models ?? {})).toContain('clawrouter/qwen-turbo');
  });
});

/**
 * ⭐ **联网开关**（设置里那一行）。
 *
 * 为什么要有它：这个能力以前是"对 qwen-turbo / qwen-plus 一直开着"——
 * 用户既看不见、也关不掉，而它的成本大约是**输入 token 的 200 倍**。
 * 现在的做法是**让它开着但看得见、随手能关**。
 *
 * ⚠️ 缺省（不传）必须是**开**：老盘升级上来没有这个字段，
 *    按关处理等于"升一次级静默拿走一个功能"。
 */
describe('联网开关：关掉之后不再注入，缺省仍然开着', () => {
  const agentsDefaults = (patch: unknown): { models?: Record<string, unknown> } =>
    (patch as { agents: { defaults: Record<string, unknown> } }).agents.defaults;

  it('uses deletion markers for owned search parameters when webSearch is false', () => {
    const patch = buildRelayPatch({ relayKey: 'rly_abc', deviceFingerprint: 'fp', webSearch: false });

    expect(agentsDefaults(patch).models).toEqual({
      'clawrouter/qwen-turbo': { params: { extra_body: { enable_search: null } } },
      'clawrouter/qwen-plus': { params: { extra_body: { enable_search: null } } },
      'clawrouter/qwen3.7-flash': { params: { extra_body: { enable_search: null } } },
    });
  });

  it('does not forward false as an upstream search parameter', () => {
    const patch = buildRelayPatch({ relayKey: 'rly_abc', deviceFingerprint: 'fp', webSearch: false });

    expect(JSON.stringify(patch)).not.toContain('"enable_search":false');
  });

  it('webSearch: true ⇒ 照旧注入（显式打开）', () => {
    const patch = buildRelayPatch({ relayKey: 'rly_abc', deviceFingerprint: 'fp', webSearch: true });

    expect(Object.keys(agentsDefaults(patch).models ?? {}).sort()).toEqual([
      'clawrouter/qwen-plus',
      'clawrouter/qwen-turbo',
      'clawrouter/qwen3.7-flash',
    ]);
  });

  it('⭐ 对照：**不传** webSearch ⇒ 按开处理（老盘升级上来行为不变）', () => {
    const patch = buildRelayPatch({ relayKey: 'rly_abc', deviceFingerprint: 'fp' });

    expect(Object.keys(agentsDefaults(patch).models ?? {})).toHaveLength(3);
  });

  it('⭐⭐ 只有**显式 false** 才算关（undefined / null / 空对象都算开）', () => {
    // 这条是这一整块的判据：写错成 `=== true` 会让所有老盘静默失去联网
    expect(webSearchEnabled(undefined)).toBe(true);
    expect(webSearchEnabled(null)).toBe(true);
    expect(webSearchEnabled({})).toBe(true);
    expect(webSearchEnabled({ webSearch: true })).toBe(true);
    expect(webSearchEnabled({ webSearch: false })).toBe(false);
  });

  it('开关关掉不影响别的部分（默认模型照旧写得进去）', () => {
    const patch = buildRelayPatch({
      relayKey: 'rly_abc',
      deviceFingerprint: 'fp',
      webSearch: false,
      defaultModel: 'clawrouter/deepseek-v4-flash',
    });

    expect(JSON.stringify(patch)).toContain('deepseek-v4-flash');
  });
});

/**
 * 2026-10-17 现场（r31 首启卡 33%）：
 * 目录模型条目内容一变（能力标记撤回），整段 replace 的 `models` 数组会被网关的
 * 破坏性校验判成"删条目" ⇒ `config.patch would remove entries from array path(s)` ⇒
 * relay bootstrap 直接失败、准备页停在 33%。写补丁必须显式声明 replace 意图。
 */
describe('relayPatchReplacePaths（数组替换声明）', () => {
  const base = { relayKey: 'rly_test', deviceFingerprint: 'fp' };

  it('⭐ 带 models 数组 ⇒ 声明 models.providers.clawrouter.models', () => {
    const patch = buildRelayPatch({
      ...base,
      catalogModels: [{ id: 'glm-5.3-flash', name: 'GLM', reasoning: false, input: ['text'] }],
    });
    expect(patch).not.toBeNull();
    expect(relayPatchReplacePaths(patch!)).toEqual([
      'models.providers.clawrouter.models',
      // 元素内的数组也要声明：网关第二层校验会报 `…models[].input`
      'models.providers.clawrouter.models[].input',
    ]);
  });

  it('不写 models（目录拉不到）⇒ 不声明', () => {
    const patch = buildRelayPatch({ ...base });
    expect(patch).not.toBeNull();
    expect(relayPatchReplacePaths(patch!)).toEqual([]);
  });
});
