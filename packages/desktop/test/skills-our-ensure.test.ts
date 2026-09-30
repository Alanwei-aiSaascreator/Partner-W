import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **开机自装随包技能**（`skills:our-ensure`）。
 *
 * 为什么需要它：随包技能原来**只在用户点「安装」时**才进 managed 目录 ⇒
 * "随包内置"对新盘等于没发生，助手看不到技能就用不上
 * （「文档生成（PPT / Word / Excel）」就是例子：看不到它，助手只会说"只能给文字稿"）。
 *
 * 这里真跑一条：列出随包技能 → 只补缺的 → 已装的一个字节都不动。
 */

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  skillsStatus: vi.fn(),
  // ⚠️ 新机制要读写 `bundledSkillRecords`（内容指纹记账）⇒ 配置必须桩成**内存**的。
  //    否则 `updateConfig` 会往一个不存在的目录写、抛 ENOENT，整条处理器被打回
  //    `ok:false` —— 而测试只会看到"结果里什么都没有"，看不出因果。
  configState: { value: {} as Record<string, unknown> },
}));

vi.mock('../src/main/workspace/config.js', () => ({
  readConfig: () => mocks.configState.value,
  updateConfig: (partial: Record<string, unknown>) => {
    mocks.configState.value = { ...mocks.configState.value, ...partial };
    return mocks.configState.value;
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
  // `resolveOurSkillsRoot` 会按这三个值找随包技能目录；指到包根即可（dev 形状）。
  app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => 'C:\\clawwork-test-no-such-dir' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
}));

vi.mock('../src/main/ws/index.js', () => {
  const client = {
    isConnected: true,
    getSkillsStatus: mocks.skillsStatus,
    listAgents: async () => ({ defaultId: 'main', agents: [{ id: 'main' }] }),
  };
  return { getGatewayClient: () => client };
});

vi.mock('../src/main/debug/index.js', () => ({
  initDebugLogger: vi.fn(),
  getDebugLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), flush: vi.fn() }),
}));

const { registerSkillsHandlers } = await import('../src/main/skills/handlers.js');
const { readBundledSkills } = await import('../src/main/skills/bundled.js');

let managedDir = '';

beforeEach(() => {
  mocks.handlers.clear();
  managedDir = mkdtempSync(join(tmpdir(), 'clawwork-skills-ensure-'));
  mocks.skillsStatus.mockReset();
  mocks.skillsStatus.mockResolvedValue({ managedSkillsDir: managedDir });
  registerSkillsHandlers();
});
afterEach(() => rmSync(managedDir, { recursive: true, force: true }));

async function ensure(gatewayId = 'gw-1') {
  const handler = mocks.handlers.get('skills:our-ensure');
  if (!handler) throw new Error('skills:our-ensure 没注册');
  return (await handler({}, { gatewayId })) as {
    ok: boolean;
    result?: { installed: string[]; failed: Array<{ slug: string; error: string }> };
    error?: string;
  };
}

/** 随包目录里有多少技能（真实读盘，避免把清单抄进测试里）。 */
function bundledSlugs(): string[] {
  return readBundledSkills(join(process.cwd(), 'our-skills')).map((skill) => skill.slug);
}

describe('skills:our-ensure（开机自装）', () => {
  it('⭐ 空目录 ⇒ 把随包技能全装上', async () => {
    const slugs = bundledSlugs();
    expect(slugs.length, '随包技能不该是空的（空的话这条测试什么都没验）').toBeGreaterThan(0);

    const result = await ensure();

    expect(result.ok).toBe(true);
    expect(result.result?.failed).toEqual([]);
    expect([...(result.result?.installed ?? [])].sort()).toEqual([...slugs].sort());
    for (const slug of slugs) {
      expect(existsSync(join(managedDir, slug, 'SKILL.md')), `${slug} 没装上`).toBe(true);
    }
  });

  it('⭐ 已装的**一个字节都不动**（语义是"缺了就补"，不是"每次覆盖"）', async () => {
    const slug = bundledSlugs()[0] as string;
    mkdirSync(join(managedDir, slug), { recursive: true });
    writeFileSync(join(managedDir, slug, 'SKILL.md'), '用户或运行时改过的内容');

    const result = await ensure();

    expect(result.result?.installed, '已装的不该在安装名单里').not.toContain(slug);
    expect(readFileSync(join(managedDir, slug, 'SKILL.md'), 'utf8')).toBe('用户或运行时改过的内容');
  });

  it('再跑一次 ⇒ 什么都不装（幂等；开机每次都会调它）', async () => {
    await ensure();
    const second = await ensure();
    expect(second.result?.installed).toEqual([]);
    expect(second.result?.failed).toEqual([]);
  });

  it('网关没连上（拿不到安装目录）⇒ ok:false，且**不往任何地方写**', async () => {
    mocks.skillsStatus.mockResolvedValue({});
    const result = await ensure();
    expect(result.ok).toBe(false);
    expect(result.error).toBe('GATEWAY_UNAVAILABLE');
    expect(
      readBundledSkills(join(process.cwd(), 'our-skills')).every((s) => !existsSync(join(managedDir, s.slug))),
    ).toBe(true);
  });

  it('新技能随包进来（目录里没有它）⇒ 只补那一个', async () => {
    // 先把除最后一个以外的都装上，模拟"老盘上已经有旧的几个"
    const slugs = bundledSlugs();
    const firstRun = await ensure();
    expect(firstRun.result?.installed.length).toBe(slugs.length);

    const newest = slugs[slugs.length - 1] as string;
    rmSync(join(managedDir, newest), { recursive: true, force: true });

    const second = await ensure();
    expect(second.result?.installed).toEqual([newest]);
  });
});

/**
 * 渲染层那道**栅栏**（不是行为测试，故意说明白）。
 *
 * 上面验的是主进程"接到调用会不会装"。真正让它在开机时发生的，是
 * `useStartupReadiness` 把 `ensureOurSkills` 交给工作区能力门禁，并在网关连接 effect 里启动门禁。
 * 把这条接线删掉、或挪出那个 effect，**整套主进程测试都不会红**，而功能会静默失效
 * （新盘上助手看不到随包技能 ⇒ 例如"做个 PPT"它只会说只能给文字稿）。
 *
 * 给 `useStartupReadiness` 写一个行为测试要搭起 zustand 会话、中转状态订阅、
 * 网关 bootstrap 一大套；这里用源码栅栏换那个成本，**并把它的性质写在名字里**。
 */
describe('栅栏：开机时机确实会调自装', () => {
  it('useStartupReadiness 把技能自装与助手安装一起交给工作区门禁', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/hooks/useStartupReadiness.ts'), 'utf8');
    expect(source, '技能自装必须经过与助手相同的文件系统能力门禁').toContain('ensureSkills: ensureOurSkills');
    expect(source, '网关联上时必须启动这道统一门禁').toContain('void runGatedBootstrap()');
  });
});
