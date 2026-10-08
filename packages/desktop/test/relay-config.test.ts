import { describe, expect, it, vi } from 'vitest';
import {
  webSearchEnabled,
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

  /**
   * ⭐ 默认模型**只能有一处定义**。
   *
   * 2026-09-17 实机：激活时这里取的是**中转目录第一条**（qwen3.5-27b），
   * 而 composer 显示的是商业默认（deepseek-v4-flash）—— 同一个"默认"两个值，
   * 于是用户看到的模型和实际生成消息的模型对不上（徽章显示 qwen，用户以为买了 Kimi 跑 glm）。
   * 这条测试把两边钉成同一个 id。
   */
  it('目录第一条不是商业默认时，也优先取商业默认（与 composer 显示保持一致）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          providers: [{ id: 'bailian', models: [{ id: 'qwen3.5-27b' }, { id: 'deepseek-v4-flash' }] }],
        }),
      })),
    );
    const { fetchFirstRelayModel } = await import('../src/main/commercial/relay-config.js');

    expect(await fetchFirstRelayModel('rly_abc')).toBe('clawrouter/deepseek-v4-flash');
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
