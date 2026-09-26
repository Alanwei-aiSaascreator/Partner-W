import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 装/卸随包技能之后，**通知网关把那一侧的技能缓存作废**（T-a2·A2-6）。
 *
 * ## 为什么非要有这一下
 *
 * 网关对**每个 agent** 缓存一份技能表（`skillEntryCache`，键里含一个版本号）。
 * 装/卸我们只动磁盘（`managedSkillsDir` 里 cp/rm），**网关看不见**：
 * 实测 2026-09-20（随包运行时 2026.9.3，脚本 `%TEMP%/ta7mut/skills-cache-probe.mjs`）——
 * 同一个网关进程、同一时刻，盘上删掉一个 managed 技能之后：
 *   - 问**已经问过**的 agent ⇒ 技能数不变（照旧报着那个技能）
 *   - 问**没问过**的 agent ⇒ 立刻是磁盘真值
 * 加技能是同样的：先问过的 agent 看不到新技能。两个方向都量过。
 *
 * 能让版本号前进的路子里，只有一条能从 RPC 够到（其余是 fs watcher —— 只在
 * 「构建过一次 session snapshot」之后才装，而且 chokidar `ignoreInitial: true`，
 * 装之前发生的增删它永远看不见）：**写一处 `skills.*` 配置**
 * （`server-reload-managed-BZLndg46.mjs:508`：changedPaths 里有 `skills` 或 `skills.*`
 * ⇒ 全局 bump）。而且**值必须真的变** —— 原样重写同一条不算变更
 * （`changedPaths.length === 0` 直接 return），这一条也实测过。
 *
 * ⇒ 装：`skills.update {skillKey: slug, enabled: true}`；卸：`enabled: false`。
 * 装上 → 卸下 → 再装，值每次都真变，所以这三种常见动作都能立刻生效。
 *
 * ⚠️ 已知缺口（照实记）：**重复装同一个技能（内容升级）写进去的值没变 ⇒ 不 bump**，
 * 那种情况下 agent 可能还拿着旧内容，直到别的事件 bump 或重启应用。
 *
 * ⚠️ 这一下是**尽力而为**：装/卸本身成功与否不受它影响，失败只记一条 warn。
 * 网关连不上就不发（没有可通知的对象），也**不**因此让装/卸失败。
 *
 * ⚠️ mock 一律写 `mocks.x`：`vi.mock` 的工厂会被提升到文件顶部，而静态 import 会在
 *    **模块顶部的 const 初始化之前**就去加载被测模块 ⇒ 工厂里引用那些 const 就是
 *    `Cannot access 'x' before initialization`（仓库里 `artifact-handlers.test.ts`
 *    踩过同一个坑）。`vi.hoisted` 是唯一安全的形状；解构 `const {x} = mocks` 同样会
 *    栽在提升顺序上（实测），所以全篇不用解构。
 */

const mocks = vi.hoisted(() => ({
  handleMap: new Map<string, (...args: unknown[]) => unknown>(),
  updateSkill: vi.fn<(params: unknown) => Promise<unknown>>(async () => ({})),
  getSkillsStatus: vi.fn(async () => ({ managedSkillsDir: 'C:/managed-skills' })),
  getGatewayClient: vi.fn(),
  installBundledSkill: vi.fn(),
  removeBundledSkill: vi.fn(),
  // ⚠️ 返回类型必须写出来：不写就是 `never[]`，`mockReturnValue([{slug, content}])` 编不过。
  readBundledSkills: vi.fn<() => Array<{ slug: string; content?: string }>>(() => []),
  isBundledSkillInstalled: vi.fn(() => false),
  readInstalledSkillContent: vi.fn<(dir: unknown, slug: string) => string | null>(() => null),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'C:/app' },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handleMap.set(channel, handler);
    },
  },
}));

vi.mock('../src/main/ws/index.js', () => ({
  getGatewayClient: mocks.getGatewayClient,
}));

vi.mock('../src/main/skills/bundled.js', async (importOriginal) => ({
  // ⚠️ 只桩 **IO 那几件**，`staleBundledSkills` / `readInstalledSkillContent` 用**真的**：
  //    这两个正是要被测的逻辑，桩掉它们等于没测（"每个零件都测过、拼起来没测过"）。
  ...(await importOriginal<typeof import('../src/main/skills/bundled.js')>()),
  installBundledSkill: mocks.installBundledSkill,
  removeBundledSkill: mocks.removeBundledSkill,
  readBundledSkills: mocks.readBundledSkills,
  isBundledSkillInstalled: mocks.isBundledSkillInstalled,
  readInstalledSkillContent: mocks.readInstalledSkillContent,
}));

vi.mock('../src/main/skills/locate.js', () => ({
  resolveOurSkillsRoot: () => 'C:/bundled-skills',
}));

vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({ warn: mocks.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { notifySkillCacheChange } from '../src/main/skills/cache-refresh.js';
import { registerSkillsHandlers } from '../src/main/skills/handlers.js';

/** 一个连上的网关客户端替身。`updateSkill` 的**载荷形状**是本切片的核心断言。 */
function connectedClient() {
  return { isConnected: true, updateSkill: mocks.updateSkill, getSkillsStatus: mocks.getSkillsStatus };
}

async function invoke(channel: string, payload: unknown): Promise<Record<string, unknown>> {
  const handler = mocks.handleMap.get(channel);
  if (!handler) throw new Error(`handler 没注册：${channel}`);
  return (await handler({}, payload)) as Record<string, unknown>;
}

describe('notifySkillCacheChange —— 通知的形状与失败方式', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateSkill.mockResolvedValue({});
  });

  it('⭐ 装上：调 updateSkill({skillKey, enabled:true})，恰好一次', async () => {
    const outcome = await notifySkillCacheChange({ client: connectedClient(), slug: 'meeting-minutes', enabled: true });
    expect(outcome).toBe('ok');
    expect(mocks.updateSkill).toHaveBeenCalledTimes(1);
    expect(mocks.updateSkill).toHaveBeenCalledWith({ skillKey: 'meeting-minutes', enabled: true });
  });

  it('⭐ 卸下：同一个 skillKey，enabled:false（换的就是这个值 —— 值不变网关不会重扫）', async () => {
    const outcome = await notifySkillCacheChange({
      client: connectedClient(),
      slug: 'meeting-minutes',
      enabled: false,
    });
    expect(outcome).toBe('ok');
    expect(mocks.updateSkill).toHaveBeenCalledWith({ skillKey: 'meeting-minutes', enabled: false });
  });

  it('网关没连上（client 缺席）⇒ skipped：一条 RPC 都不发，也不抛', async () => {
    await expect(notifySkillCacheChange({ client: null, slug: 'meeting-minutes', enabled: true })).resolves.toBe(
      'skipped',
    );
    await expect(notifySkillCacheChange({ client: undefined, slug: 'meeting-minutes', enabled: true })).resolves.toBe(
      'skipped',
    );
    expect(mocks.updateSkill).not.toHaveBeenCalled();
  });

  it('⭐ RPC 抛错 ⇒ failed + 一条 warn（带 slug），**不抛给调用方**', async () => {
    mocks.updateSkill.mockRejectedValue(new Error('网关没回'));
    const onWarn = vi.fn();
    const outcome = await notifySkillCacheChange({
      client: connectedClient(),
      slug: 'meeting-minutes',
      enabled: false,
      onWarn,
    });
    expect(outcome).toBe('failed');
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toMatchObject({ slug: 'meeting-minutes' });
  });
});

describe('skills:our-install / skills:our-remove 成功之后会通知网关', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handleMap.clear();
    registerSkillsHandlers();
    mocks.getGatewayClient.mockReturnValue(connectedClient());
    mocks.installBundledSkill.mockReturnValue({ ok: true });
    mocks.removeBundledSkill.mockReturnValue({ ok: true });
  });

  it('⭐ 装上成功 ⇒ 通知 enabled:true；IPC 结果仍是「装」那一份', async () => {
    const res = await invoke('skills:our-install', { gatewayId: 'gw-1', agentId: 'a-1', slug: 'copy-variants' });
    expect(res).toEqual({ ok: true });
    expect(mocks.updateSkill).toHaveBeenCalledWith({ skillKey: 'copy-variants', enabled: true });
  });

  it('⭐ 装失败 ⇒ **不通知**（没发生的变更不该去写配置）', async () => {
    mocks.installBundledSkill.mockReturnValue({ ok: false, error: '随包目录里没有这个技能：nope' });
    const res = await invoke('skills:our-install', { gatewayId: 'gw-1', agentId: 'a-1', slug: 'nope' });
    expect(res.ok).toBe(false);
    expect(mocks.updateSkill).not.toHaveBeenCalled();
  });

  it('卸下成功 ⇒ 通知 enabled:false', async () => {
    const res = await invoke('skills:our-remove', { gatewayId: 'gw-1', agentId: 'a-1', slug: 'copy-variants' });
    expect(res).toEqual({ ok: true });
    expect(mocks.updateSkill).toHaveBeenCalledWith({ skillKey: 'copy-variants', enabled: false });
  });

  it('⭐ 通知失败 ⇒ IPC 照样 ok:true（尽力而为，不反噬装/卸），且 warn 落到调试日志', async () => {
    mocks.updateSkill.mockRejectedValue(new Error('网关没回'));
    const res = await invoke('skills:our-install', { gatewayId: 'gw-1', agentId: 'a-1', slug: 'copy-variants' });
    expect(res).toEqual({ ok: true });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    // domain 归 `gateway`（`DebugDomain` 是闭集，没有 skills），技能语义在 event 名里
    expect(mocks.warn.mock.calls[0][0]).toMatchObject({ domain: 'gateway', event: 'skills.cache-refresh.failed' });
  });

  it('网关压根没连上 ⇒ 装本身明确失败（GATEWAY_UNAVAILABLE），也就没有什么要通知的', async () => {
    mocks.getGatewayClient.mockReturnValue(null);
    const res = await invoke('skills:our-remove', { gatewayId: 'gw-1', agentId: 'a-1', slug: 'copy-variants' });
    expect(res).toEqual({ ok: false, error: 'GATEWAY_UNAVAILABLE' });
    expect(mocks.updateSkill).not.toHaveBeenCalled();
  });

  it('⭐ 装的中途网关断了（问目录时还在，通知时已断）⇒ 装照旧成功，但**不发**这条 RPC', async () => {
    // 15 秒超时的请求不该白挂一条：连接断了就什么都不发。
    const client = {
      isConnected: true,
      getSkillsStatus: mocks.getSkillsStatus,
      updateSkill: mocks.updateSkill,
    };
    mocks.getSkillsStatus.mockImplementation(async () => {
      client.isConnected = false;
      return { managedSkillsDir: 'C:/managed-skills' };
    });
    mocks.getGatewayClient.mockReturnValue(client);
    const res = await invoke('skills:our-install', { gatewayId: 'gw-1', agentId: 'a-1', slug: 'copy-variants' });
    expect(res).toEqual({ ok: true });
    expect(mocks.updateSkill).not.toHaveBeenCalled();
  });
});

/**
 * ⭐ 补上那个**已知缺口**（这个模块自己的注释里就写着）：
 *   「重复装同一个技能（内容升级）写进去的值没变 ⇒ 不 bump」。
 *
 * 真机形状（2026-09-26，盘 E: 0.0.35）：技能**内容升级**之后，助手照旧按旧契约
 * 说"PDF 做不到"。装的那一下 `{enabled:true}` 对已经 `true` 的那条**不是变更**，
 * 网关那边 `changedPaths.length === 0` 直接 return ⇒ 缓存不 bump。
 *
 * 修法用**已经被实测过的那条机制**（值必须真的变）：`force` 时先写 `false` 再写 `true`
 * ⇒ 两次都是真变更 ⇒ 一定 bump。顺序不能反（先 false 后 true 才能停在"已启用"）。
 */
describe('内容升级：强制 bump（值必须真的变两次）', () => {
  beforeEach(() => {
    mocks.updateSkill.mockClear();
    mocks.updateSkill.mockImplementation(async () => ({}));
  });

  it('force ⇒ 先 false 后 true，两次调用', async () => {
    const outcome = await notifySkillCacheChange({
      client: { updateSkill: mocks.updateSkill },
      slug: 'document-deck',
      enabled: true,
      force: true,
    });

    expect(outcome).toBe('ok');
    expect(mocks.updateSkill.mock.calls.map((c) => (c[0] as { enabled: boolean }).enabled)).toEqual([false, true]);
    expect(mocks.updateSkill.mock.calls.every((c) => (c[0] as { skillKey: string }).skillKey === 'document-deck')).toBe(
      true,
    );
  });

  it('⚠️ 顺序不许反：最后落定的必须是 enabled', async () => {
    await notifySkillCacheChange({
      client: { updateSkill: mocks.updateSkill },
      slug: 'x',
      enabled: true,
      force: true,
    });
    // ⚠️ 必须**同时**钉住"两次"与"最后是 true"：只断言最后一个是 true 的话，
    //    没实现 force 时它照样通过（一次 `{enabled:true}` 也叫"最后是 true"）
    //    —— 这条测试第一版就是这么空过的，变异测试前先自己抓住。
    expect(mocks.updateSkill, 'force 必须是两次（false → true）').toHaveBeenCalledTimes(2);
    const last = mocks.updateSkill.mock.calls.at(-1)?.[0] as { enabled: boolean };
    expect(last.enabled).toBe(true);
  });

  it('不传 force ⇒ 还是一刀（普通装/卸不该多打一次）', async () => {
    await notifySkillCacheChange({ client: { updateSkill: mocks.updateSkill }, slug: 'x', enabled: true });
    expect(mocks.updateSkill).toHaveBeenCalledTimes(1);
  });
});

/**
 * ⭐ 「老盘拿不到新技能」两层里的**磁盘那一层**：随包内容与已装内容不一致 ⇒ 升级。
 *
 * 真机形状（2026-09-26，盘 E: 0.0.35）：技能文件在磁盘上已经是新版（含 PDF 段），
 * 而助手照旧说「环境限制…没法直接生成 PDF」——`missingBundledSkills` 只管"缺了才补"，
 * 老盘的技能**不缺**，于是永远不会被升级。
 *
 * 这条同时钉住两件事：**装了**（覆盖磁盘）+ **force bump 了**（否则运行时还拿着旧缓存）。
 */
describe('开机自装 × 内容升级', () => {
  beforeEach(() => {
    mocks.handleMap.clear();
    mocks.installBundledSkill.mockReset();
    mocks.installBundledSkill.mockReturnValue({ ok: true });
    mocks.readBundledSkills.mockReset();
    mocks.isBundledSkillInstalled.mockReset();
    mocks.readInstalledSkillContent.mockReset();
    mocks.updateSkill.mockReset();
    mocks.updateSkill.mockImplementation(async () => ({}));
    mocks.getGatewayClient.mockReset();
    // ⚠️ `managedSkillsDirOf` 要 `isConnected` + `getSkillsStatus`，少一个就**静默**
    //    返回 null ⇒ 处理器直接 `{ok:false, GATEWAY_UNAVAILABLE}`，而测试会以为
    //    "装没发生"是产品行为（第一版就是这么空过的）。
    mocks.getGatewayClient.mockReturnValue({
      isConnected: true,
      updateSkill: mocks.updateSkill,
      getSkillsStatus: mocks.getSkillsStatus,
    });
    mocks.getSkillsStatus.mockResolvedValue({ managedSkillsDir: 'C:/managed-skills' });
  });

  const runEnsure = async () => {
    const { registerSkillsHandlers } = await import('../src/main/skills/handlers.js');
    registerSkillsHandlers();
    const handler = mocks.handleMap.get('skills:our-ensure');
    return (await handler?.({}, { gatewayId: 'local-runtime' })) as {
      ok: boolean;
      result?: { installed?: string[]; upgraded?: string[] };
    };
  };

  it('内容一致 ⇒ 不升级、不重复装', async () => {
    mocks.readBundledSkills.mockReturnValue([{ slug: 'a', content: '同一份' }]);
    mocks.isBundledSkillInstalled.mockReturnValue(true);
    mocks.readInstalledSkillContent.mockReturnValue('同一份');

    const res = await runEnsure();

    expect(res.result?.upgraded).toEqual([]);
    expect(mocks.installBundledSkill, '一致就不该动盘').not.toHaveBeenCalled();
    expect(mocks.updateSkill, '也不该发通知').not.toHaveBeenCalled();
  });

  it('⭐ 内容不一致 ⇒ 覆盖安装 + 强制 bump（false → true）', async () => {
    mocks.readBundledSkills.mockReturnValue([{ slug: 'document-deck', content: '新正文含 PDF 段' }]);
    mocks.isBundledSkillInstalled.mockReturnValue(true);
    mocks.readInstalledSkillContent.mockReturnValue('旧正文只有三种格式');

    const res = await runEnsure();

    expect(res.result?.upgraded).toEqual(['document-deck']);
    expect(mocks.installBundledSkill).toHaveBeenCalledTimes(1);
    const enabledCalls = mocks.updateSkill.mock.calls.map((c) => (c[0] as { enabled: boolean }).enabled);
    expect(enabledCalls, '内容升级必须强制 bump（值要真的变）').toEqual([false, true]);
  });

  it('没装的不算升级（那是 missing 那条路）', async () => {
    mocks.readBundledSkills.mockReturnValue([{ slug: 'a', content: '正文' }]);
    mocks.isBundledSkillInstalled.mockReturnValue(false);
    mocks.readInstalledSkillContent.mockReturnValue(null);

    await runEnsure();

    expect(mocks.installBundledSkill, '缺了要装（missing 那条路）').toHaveBeenCalledTimes(1);
    const enabledCalls = mocks.updateSkill.mock.calls.map((c) => (c[0] as { enabled: boolean }).enabled);
    expect(enabledCalls, '缺了那条路只打一刀').toEqual([true]);
  });
});
