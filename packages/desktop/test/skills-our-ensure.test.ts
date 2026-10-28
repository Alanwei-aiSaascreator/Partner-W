import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  // `confirmed-repair` 的备份落在 `userData/skill-backups` ⇒ 必须指到临时目录，
  // 否则测试会去写 `C:\` 根（可能没权限，还会在盘上留垃圾）。
  userDataDir: '',
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
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: (name: string) =>
      name === 'userData' && mocks.userDataDir ? mocks.userDataDir : 'C:\\clawwork-test-no-such-dir',
  },
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
let userDataDir = '';

beforeEach(() => {
  mocks.handlers.clear();
  managedDir = mkdtempSync(join(tmpdir(), 'clawwork-skills-ensure-'));
  userDataDir = mkdtempSync(join(tmpdir(), 'clawwork-skills-userdata-'));
  mocks.userDataDir = userDataDir;
  // 配置是内存桩，**必须每个用例清零** —— 否则上一个用例写的技能账会漏到下一个用例，
  // 让"无账"场景实际带着账跑（结果随执行顺序变，红绿随机）。
  mocks.configState.value = {};
  mocks.skillsStatus.mockReset();
  mocks.skillsStatus.mockResolvedValue({ managedSkillsDir: managedDir });
  registerSkillsHandlers();
});
afterEach(() => {
  rmSync(managedDir, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
});

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
 * T31 · 缺口 3：技能账按网关报的 `managedSkillsDir` 做键 ⇒ **键一变就孤儿化**。
 *
 * 症状：换网关 / 换盘之后，当前键下没有账，`planSkillSync` 看不到"这是我们自己装的旧版"，
 * 于是把健康盘上那份判成 `unverified-origin` —— 一屏**虚假冲突**（其实一个字节都不该动）。
 *
 * 判据：旧键（目录**已经不在盘上**）必须被并到当前键，条目**逐字不动**（它仍然是可信来源）。
 */
describe('孤儿技能账（T31 缺口 3）', () => {
  interface EnsureResult {
    ok: boolean;
    result?: { installed: string[]; upgraded: string[]; adopted: string[]; conflicts: unknown[]; failed: unknown[] };
    error?: string;
  }
  const ensureRaw = async (gatewayId = 'gw-1'): Promise<EnsureResult> => {
    const handler = mocks.handlers.get('skills:our-ensure');
    if (!handler) throw new Error('skills:our-ensure 没注册');
    return (await handler({}, { gatewayId })) as EnsureResult;
  };

  it('⭐ 旧键目录已不在盘上 ⇒ 账并到当前键，不冒虚假冲突', async () => {
    const slug = bundledSlugs()[0] as string;
    const oldContent = '# 旧版\n\n这是随包更早的一版（账能逐字证明它归我们）。\n';
    const oldSha = createHash('sha256').update(oldContent, 'utf8').digest('hex');
    mkdirSync(join(managedDir, slug), { recursive: true });
    writeFileSync(join(managedDir, slug, 'SKILL.md'), oldContent, 'utf8');

    const staleKey = join(tmpdir(), 'clawwork-skills-gone-20261016', 'skills');
    mocks.configState.value = {
      bundledSkillRecords: {
        [staleKey]: {
          [slug]: `pkg2:${JSON.stringify({ version: 2, packageSha: 'a'.repeat(64), files: { 'SKILL.md': oldSha } })}`,
        },
      },
    };

    const result = await ensureRaw();

    expect(result.ok).toBe(true);
    expect(result.result?.conflicts, '旧版的账是可信来源，不该被判成 unverified-origin 冲突').toEqual([]);
    expect(result.result?.upgraded).toContain(slug);
    const records = mocks.configState.value.bundledSkillRecords as Record<string, Record<string, string>>;
    expect(Object.keys(records)).toEqual([managedDir]);
    expect(records[managedDir]?.[slug]).toBeTruthy();
  });

  it('旧键的目录**还在盘上** ⇒ 不认它是孤儿（可能只是这次没连上的另一套 state）', async () => {
    const liveKey = join(tmpdir(), 'clawwork-skills-still-here-20261016', 'skills');
    mkdirSync(liveKey, { recursive: true });
    const slug = bundledSlugs()[0] as string;
    const record = `pkg2:${JSON.stringify({ version: 2, packageSha: 'a'.repeat(64), files: { 'SKILL.md': 'b'.repeat(64) } })}`;
    mocks.configState.value = { bundledSkillRecords: { [liveKey]: { [slug]: record } } };

    await ensureRaw();

    const records = mocks.configState.value.bundledSkillRecords as Record<string, Record<string, string>>;
    expect(records[liveKey]?.[slug]).toBe(record);
    rmSync(liveKey, { recursive: true, force: true });
  });
});

/**
 * BUG-146 · 前账本时代的随包技能**永久卡在旧版**。
 *
 * 实测现场：生图技能目录是早期版本（正文只描述旧模型），但 `bundledSkillRecords` 里
 * 根本没有这一项 ⇒ `planSkillSync` 判 `unverified-origin` 冲突 ⇒ 旧行为永久保留 ⇒
 * 模型每次都读到**旧技能指令**（"只有 qwen-image-plus / 未开通"），于是回答"不支持生图"。
 *
 * 判据两条：
 *  ① 盘上那份**还带着我们这个 slug 的 `metadata.openclaw.skillKey`** ⇒ 是我们自己的旧副本
 *     ⇒ 走 `confirmed-repair`（整目录备份保留后写入当前包）；
 *  ② 认不出是我们写的（无 frontmatter / skillKey 对不上）⇒ 仍按冲突保留，一个字节不动。
 */
describe('无账的技能目录（BUG-146）', () => {
  interface EnsureFull {
    ok: boolean;
    result?: { upgraded: string[]; conflicts: Array<{ slug: string; reason: string }> };
  }
  const ensureFull = async (): Promise<EnsureFull> => {
    const handler = mocks.handlers.get('skills:our-ensure');
    if (!handler) throw new Error('skills:our-ensure 没注册');
    return (await handler({}, { gatewayId: 'gw-1' })) as EnsureFull;
  };

  it('⭐ 盘上是我们的旧副本（skillKey 对得上）⇒ 自动升级到当前包，并留下备份', async () => {
    const slug = bundledSlugs()[0] as string;
    const currentText = readFileSync(join(process.cwd(), 'our-skills', slug, 'SKILL.md'), 'utf8');
    const lines = currentText.split('\n');
    const closeIndex = lines.indexOf('---', 1);
    expect(closeIndex, '随包 SKILL.md 必须有闭合 frontmatter').toBeGreaterThan(0);
    const staleText = `${lines.slice(0, closeIndex + 1).join('\n')}\n\n旧版正文：只描述一个已经废掉的做法。\n`;

    mkdirSync(join(managedDir, slug), { recursive: true });
    writeFileSync(join(managedDir, slug, 'SKILL.md'), staleText, 'utf8');

    const result = await ensureFull();

    expect(result.result?.upgraded, '无账但确是我们的旧副本 ⇒ 必须升级').toContain(slug);
    expect(result.result?.conflicts ?? [], '这条不该再冒冲突').toEqual([]);
    expect(readFileSync(join(managedDir, slug, 'SKILL.md'), 'utf8'), '升级后必须是当前包内容').toBe(currentText);

    const backupRoot = join(userDataDir, 'skill-backups');
    expect(existsSync(backupRoot), 'confirmed-repair 必须留备份（否则等于静默覆盖）').toBe(true);
    expect(readdirSync(backupRoot).length, '备份目录不该是空的').toBeGreaterThan(0);
  });

  it('⭐ 认不出是我们的（无 frontmatter）⇒ 保持冲突、一个字节都不动', async () => {
    const slug = bundledSlugs()[0] as string;
    const userText = '# 用户自己写的技能\n\n这里是我的做法，别动。\n';
    mkdirSync(join(managedDir, slug), { recursive: true });
    writeFileSync(join(managedDir, slug, 'SKILL.md'), userText, 'utf8');

    const result = await ensureFull();

    expect(result.result?.upgraded ?? [], '不是我们的副本，不许自动覆盖').not.toContain(slug);
    expect(
      result.result?.conflicts?.map((c) => c.slug),
      '必须报出来让用户决定',
    ).toContain(slug);
    expect(readFileSync(join(managedDir, slug, 'SKILL.md'), 'utf8')).toBe(userText);
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
