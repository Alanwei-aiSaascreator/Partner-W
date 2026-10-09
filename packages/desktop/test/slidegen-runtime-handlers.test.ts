import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
  appPath: '',
  /** `app.getPath('userData')`：显式修复的持久恢复目录就落在它下面。 */
  userData: '',
  bundledRoot: '',
  managedDir: '',
  config: {} as Record<string, unknown>,
  /** >0 ⇒ 接下来 N 次 `updateConfig` 抛错（模拟"账写不下去"）。 */
  configWriteFails: 0,
  notify: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => mocks.appPath, getPath: () => mocks.userData },
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) =>
      mocks.handlers.set(name, handler),
  },
}));
vi.mock('@clawwork/core', () => ({ resolveCatalogAgentId: () => 'main' }));
vi.mock('../src/main/ws/index.js', () => ({ getGatewayClient: () => gateway }));
const gateway = {
  isConnected: true,
  listAgents: async () => ({ agents: [{ id: 'main' }] }),
  getSkillsStatus: async () => ({ agentId: 'main', managedSkillsDir: mocks.managedDir }),
};
vi.mock('../src/main/workspace/config.js', () => ({
  readConfig: () => mocks.config,
  updateConfig: (value: Record<string, unknown>) => {
    // E1 的"账写不下去"注入点：抛错必须触发事务回滚，而不是留下半截现场。
    if (mocks.configWriteFails > 0) {
      mocks.configWriteFails -= 1;
      throw new Error('config-write-failed');
    }
    return Object.assign(mocks.config, value);
  },
}));
vi.mock('../src/main/skills/locate.js', () => ({ resolveOurSkillsRoot: () => mocks.bundledRoot }));
vi.mock('../src/main/skills/cache-refresh.js', () => ({ notifySkillCacheChange: mocks.notify }));
vi.mock('../src/main/debug/index.js', () => ({ getDebugLogger: () => ({ warn: mocks.warn }) }));
import { registerSkillsHandlers } from '../src/main/skills/handlers.js';

let root = '';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.config = {};
  mocks.configWriteFails = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slidegen-runtime-handlers-'));
  mocks.bundledRoot = path.join(root, 'bundle');
  mocks.managedDir = path.join(root, 'managed');
  mocks.appPath = path.join(root, 'application');
  mocks.userData = path.join(root, 'user-data');
  fs.mkdirSync(mocks.appPath);
  fs.mkdirSync(mocks.userData);
  fs.cpSync(path.join(import.meta.dirname, '../our-skills/deck-layout'), path.join(mocks.bundledRoot, 'deck-layout'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(mocks.bundledRoot, 'other-skill'));
  fs.writeFileSync(
    path.join(mocks.bundledRoot, 'other-skill/SKILL.md'),
    '---\nname: Other\ndescription: Other\n---\nOther',
  );
  mocks.notify.mockResolvedValue(undefined);
  registerSkillsHandlers();
});
afterEach(() => {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('test path escaped');
  fs.rmSync(root, { recursive: true, force: true });
});
function invoke(name: string, slug?: string) {
  return mocks.handlers.get(name)!(null, { gatewayId: 'local', agentId: 'main', slug });
}
function config() {
  const file = path.join(mocks.managedDir, 'deck-layout/scripts/generate-runtime.json');
  expect(fs.existsSync(file)).toBe(true);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
/**
 * ⚠️ **每次都重新读**：`updateConfig` 的桩是整体 `Object.assign`（换掉 `bundledSkillRecords`
 * 这个属性），拿着旧引用去断言会读到一个过期对象 —— 那种断言会**假绿**。
 */
function records(): Record<string, Record<string, string>> {
  const value = (mocks.config as { bundledSkillRecords?: Record<string, Record<string, string>> }).bundledSkillRecords;
  expect(value, '这一步应当已经写过账').toBeTruthy();
  return value!;
}

it('configures the current app through the existing explicit installation IPC', async () => {
  expect(await invoke('skills:our-install', 'deck-layout')).toEqual({ ok: true });
  expect(config()).toMatchObject({
    schemaVersion: 1,
    executable: process.execPath,
    args: [mocks.appPath],
    launcherSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(mocks.notify).toHaveBeenCalledOnce();
});

it('refreshes program paths on every ensure without reinstalling unchanged skills', async () => {
  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { installed: ['deck-layout', 'other-skill'], failed: [] },
  });
  const script = fs.readFileSync(path.join(mocks.managedDir, 'deck-layout/scripts/generate.cjs'));
  mocks.appPath = path.join(root, 'moved application');
  fs.mkdirSync(mocks.appPath);
  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { installed: [], upgraded: [], failed: [] },
  });
  expect(config().args).toEqual([mocks.appPath]);
  expect(fs.readFileSync(path.join(mocks.managedDir, 'deck-layout/scripts/generate.cjs'))).toEqual(script);
});

it('reports runtime configuration failure without enabling an unusable manual install', async () => {
  fs.rmdirSync(mocks.appPath);
  expect(await invoke('skills:our-install', 'deck-layout')).toMatchObject({
    ok: false,
    error: 'slidegen-runtime-unavailable',
  });
  expect(mocks.notify).not.toHaveBeenCalled();
});

it('preserves customized launchers and reports their configuration boundary during ensure', async () => {
  await invoke('skills:our-ensure');
  const scripts = path.join(mocks.managedDir, 'deck-layout/scripts');
  config();
  const before = fs.readFileSync(path.join(scripts, 'generate-runtime.json'));
  fs.appendFileSync(path.join(scripts, 'generate.cjs'), '\ncustomization');
  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { failed: [{ slug: 'deck-layout', error: 'slidegen-runtime-script-modified' }] },
  });
  expect(fs.readFileSync(path.join(scripts, 'generate-runtime.json'))).toEqual(before);
});

it('keeps unrelated skill installation independent from the PPT runtime', async () => {
  expect(await invoke('skills:our-install', 'other-skill')).toEqual({ ok: true });
  expect(fs.existsSync(path.join(mocks.managedDir, 'other-skill/scripts/generate-runtime.json'))).toBe(false);
});

it('preserves customized launchers and stops the automatic upgrade with a named conflict', async () => {
  await invoke('skills:our-ensure');
  const scripts = path.join(mocks.managedDir, 'deck-layout/scripts');
  fs.appendFileSync(path.join(scripts, 'generate.cjs'), '\ncustomization');
  const script = fs.readFileSync(path.join(scripts, 'generate.cjs'));
  const runtime = fs.readFileSync(path.join(scripts, 'generate-runtime.json'));
  const records = JSON.stringify(mocks.config);
  fs.appendFileSync(path.join(mocks.bundledRoot, 'deck-layout/SKILL.md'), '\nUpdated guide');
  // H1：被改过的启动器不再走"整目录覆盖 + 报个失败码"，而是**具名冲突**（保留现场）。
  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: {
      upgraded: [],
      failed: [],
      conflicts: [{ slug: 'deck-layout', reason: 'user-modified', paths: ['scripts/generate.cjs'] }],
    },
  });
  expect(fs.readFileSync(path.join(scripts, 'generate.cjs'))).toEqual(script);
  expect(fs.readFileSync(path.join(scripts, 'generate-runtime.json'))).toEqual(runtime);
  expect(JSON.stringify(mocks.config)).toBe(records);
});

it('allows a recorded owned launcher version to upgrade with its guide', async () => {
  await invoke('skills:our-ensure');
  const oldRuntime = config();
  expect(oldRuntime.launcherSha256).toMatch(/^[a-f0-9]{64}$/);
  fs.appendFileSync(path.join(mocks.bundledRoot, 'deck-layout/scripts/generate.cjs'), '\nvoid 0;');
  fs.appendFileSync(path.join(mocks.bundledRoot, 'deck-layout/SKILL.md'), '\nUpdated guide');
  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { upgraded: ['deck-layout'], failed: [] },
  });
  expect(config().launcherSha256).not.toBe(oldRuntime.launcherSha256);
  expect(fs.readFileSync(path.join(mocks.managedDir, 'deck-layout/scripts/generate.cjs'))).toEqual(
    fs.readFileSync(path.join(mocks.bundledRoot, 'deck-layout/scripts/generate.cjs')),
  );
  // 运行时附加物不在厂商清单里 ⇒ 升级不会删它、也不会因为它在盘上把计划判成冲突。
  expect(fs.existsSync(path.join(mocks.managedDir, 'deck-layout/scripts/generate-runtime.json'))).toBe(true);
});

it('upgrades legacy skills that never installed a launcher', async () => {
  await invoke('skills:our-ensure');
  const scripts = path.join(mocks.managedDir, 'deck-layout/scripts');
  // 老盘的真实形状：当年那一版**只有 SKILL.md**（启动器还不存在），记账是旧口径
  // （只记 SKILL.md 指纹、枚举不出辅助文件）。
  fs.rmSync(scripts, { recursive: true, force: true });
  const records = (mocks.config as { bundledSkillRecords: Record<string, Record<string, string>> }).bundledSkillRecords;
  const installedSkill = fs.readFileSync(path.join(mocks.managedDir, 'deck-layout/SKILL.md'), 'utf8');
  records[mocks.managedDir]!['deck-layout'] = createHash('sha256')
    .update(installedSkill.replace(/\r\n/g, '\n'))
    .digest('hex');
  fs.appendFileSync(path.join(mocks.bundledRoot, 'deck-layout/SKILL.md'), '\nUpdated guide');
  expect(await invoke('skills:our-ensure'), '辅助文件是新增的（盘上一个都没有）⇒ 允许补进来').toMatchObject({
    ok: true,
    result: { upgraded: ['deck-layout'], failed: [] },
  });
  expect(config().executable).toBe(process.execPath);
  expect(fs.existsSync(path.join(scripts, 'generate.cjs'))).toBe(true);
});

it('does not certify old auxiliary files from a legacy record — names the conflict instead', async () => {
  await invoke('skills:our-ensure');
  const scripts = path.join(mocks.managedDir, 'deck-layout/scripts');
  fs.unlinkSync(path.join(scripts, 'generate.cjs'));
  fs.unlinkSync(path.join(scripts, 'generate-runtime.json'));
  const records = (mocks.config as { bundledSkillRecords: Record<string, Record<string, string>> }).bundledSkillRecords;
  const installedSkill = fs.readFileSync(path.join(mocks.managedDir, 'deck-layout/SKILL.md'), 'utf8');
  records[mocks.managedDir]!['deck-layout'] = createHash('sha256')
    .update(installedSkill.replace(/\r\n/g, '\n'))
    .digest('hex');
  const preflight = fs.readFileSync(path.join(scripts, 'preflight.cjs'));
  fs.appendFileSync(path.join(mocks.bundledRoot, 'deck-layout/SKILL.md'), '\nUpdated guide');

  // 旧口径只认证 SKILL.md：盘上还留着**来路不明**的辅助文件（preflight.cjs）⇒ 自动流程
  // 不能凭"SKILL.md 一致"把它们认成我们的 ⇒ 具名冲突、一个字节都不动（显式安装才是修复出口）。
  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: {
      upgraded: [],
      failed: [],
      conflicts: [{ slug: 'deck-layout', reason: 'unverified-origin', paths: ['scripts/preflight.cjs'] }],
    },
  });
  expect(fs.readFileSync(path.join(scripts, 'preflight.cjs'))).toEqual(preflight);
});

/**
 * ⭐ H1 复审反例（e5024996 两个 REVIEW_MAIN 探针的正式版）。
 *
 * 旧实现的两条路都要被钉死：
 *  ① **认领**凭"SKILL.md 一致"就把**旧辅助文件**记成最新包 ⇒ 随包只改了
 *     `scripts/generate.cjs` 时，第二次 ensure 判"没变"，盘上永远停在 version1；
 *  ② 升级走**整目录 rmSync + 拷贝** ⇒ 用户改过的 layouts 被随包内容直接冲掉。
 */
it('REVIEW：认领不得把旧辅助文件记成最新包（随包只改脚本 ⇒ 必须升上去且只升一次）', async () => {
  const bundle = path.join(mocks.bundledRoot, 'other-skill');
  fs.mkdirSync(path.join(bundle, 'scripts'));
  fs.writeFileSync(path.join(bundle, 'scripts', 'generate.cjs'), 'version1');
  // 显式安装：与 ensure 同一条出口 ⇒ 记账必须当场写下（旧实现这一笔是空的）。
  expect(await invoke('skills:our-install', 'other-skill')).toEqual({ ok: true });
  fs.writeFileSync(path.join(bundle, 'scripts', 'generate.cjs'), 'version2');

  // ⭐ 反例本体：旧实现把"SKILL.md 一致"当成"整个包都是我们装的"⇒ 认领后第二次 ensure
  //    判"随包没变"，盘上永远停在 version1（连一条日志都没有）。
  expect(await invoke('skills:our-ensure'), '第一轮：辅助文件更新必须触发升级').toMatchObject({
    ok: true,
    result: { upgraded: ['other-skill'], failed: [] },
  });
  expect(await invoke('skills:our-ensure'), '第二轮：随包没再变 ⇒ 不许重复升级').toMatchObject({
    ok: true,
    result: { upgraded: [], installed: [], failed: [] },
  });
  expect(fs.readFileSync(path.join(mocks.managedDir, 'other-skill', 'scripts', 'generate.cjs'), 'utf8')).toBe(
    'version2',
  );
  // 显式安装与 ensure 同一条出口 ⇒ 记账必须当场写下（旧实现这一笔是空的）。
  const records = (mocks.config as { bundledSkillRecords?: Record<string, Record<string, string>> })
    .bundledSkillRecords;
  expect(records?.[mocks.managedDir]?.['other-skill'], '显式安装也要记账').toMatch(/^pkg2:/);
});

it('REVIEW：随包更新不得冲掉用户改过的辅助文件（冲突具名、字节保留）', async () => {
  const bundle = path.join(mocks.bundledRoot, 'other-skill');
  fs.mkdirSync(path.join(bundle, 'layouts'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'layouts', '01.md'), 'vendor-v1');
  await invoke('skills:our-ensure');
  const installed = path.join(mocks.managedDir, 'other-skill', 'layouts', '01.md');
  fs.writeFileSync(installed, 'user-edit');
  fs.writeFileSync(path.join(bundle, 'layouts', '01.md'), 'vendor-v2');

  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { conflicts: [{ slug: 'other-skill', reason: 'user-modified', paths: ['layouts/01.md'] }], failed: [] },
  });
  expect(fs.readFileSync(installed, 'utf8'), '用户字节一个都不许动').toBe('user-edit');

  // ⭐ 修复出口（状态 4）：用户**明确**点安装 ⇒ 允许替换冲突文件（带备份与核验），
  //    但用户额外文件仍然保留、记账当场更新。
  const target = path.join(mocks.managedDir, 'other-skill');
  fs.writeFileSync(path.join(target, '我的笔记.md'), '用户自己放的');
  // ⭐ E2：显式修复成功后必须留下**可定位**的恢复资产 —— 成功结果里带着备份目录。
  const repair = (await invoke('skills:our-install', 'other-skill')) as {
    ok: boolean;
    result?: { backupDir?: string };
  };
  expect(repair).toMatchObject({ ok: true });
  const repairBackup = repair.result?.backupDir ?? '';
  expect(repairBackup, '修复成功必须能定位恢复备份').toBeTruthy();
  // E2 命名空间：用户字节在 payload 根（`files/`）下，系统恢复清单才在备份根顶部。
  expect(fs.existsSync(path.join(repairBackup, 'files', 'SKILL.md')), '备份里要有被换掉的那份旧内容').toBe(true);
  expect(fs.readFileSync(installed, 'utf8'), '明确选择替换后厂商文件该到位').toBe('vendor-v2');
  expect(fs.readFileSync(path.join(target, '我的笔记.md'), 'utf8'), '额外文件不在替换面里').toBe('用户自己放的');
  // 修完再 ensure：盘上 == 记账 ⇒ 不再是冲突。
  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { conflicts: [], failed: [] },
  });
});

it('REVIEW：用户额外文件保留，厂商删掉的文件才清理（差分而不是整目录覆盖）', async () => {
  const bundle = path.join(mocks.bundledRoot, 'other-skill');
  fs.mkdirSync(path.join(bundle, 'layouts'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'layouts', '01.md'), 'v1');
  await invoke('skills:our-ensure');
  const target = path.join(mocks.managedDir, 'other-skill');
  fs.writeFileSync(path.join(target, 'notes.md'), '用户自己放的');
  fs.rmSync(path.join(bundle, 'layouts', '01.md'));
  fs.writeFileSync(path.join(bundle, 'layouts', '02.md'), 'v2');

  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { upgraded: ['other-skill'], failed: [] },
  });
  expect(fs.readFileSync(path.join(target, 'notes.md'), 'utf8')).toBe('用户自己放的');
  expect(fs.existsSync(path.join(target, 'layouts', '01.md')), '厂商已删的文件可清理').toBe(false);
  expect(fs.existsSync(path.join(target, 'layouts', '02.md'))).toBe(true);
});

/**
 * ⭐⭐ E1（2026-10-09 终审）：**运行时失败发生在事务之外** ⇒ 文件已是新字节、账还是旧字节，
 * 恢复环境后普通 ensure 把自己的写入判成 `user-modified` 假冲突，`upgraded=[]`，
 * 而"下一次认领自愈"对已有 pkg2 根本不成立（planSkillSync 直接按旧基线核对）。
 * 契约：runtime 配置、装后再次核验、写账**都在事务里**（`finalize`），失败 = 整批回滚。
 */
it('H1/E1：runtime 配置失败 ⇒ 旧 SKILL/launcher/runtime/账整批回滚，且不能靠"下一次自愈"', async () => {
  expect(await invoke('skills:our-ensure')).toMatchObject({ ok: true, result: { failed: [] } });
  const target = path.join(mocks.managedDir, 'deck-layout');
  const before = {
    skill: fs.readFileSync(path.join(target, 'SKILL.md')),
    script: fs.readFileSync(path.join(target, 'scripts/generate.cjs')),
    runtime: fs.readFileSync(path.join(target, 'scripts/generate-runtime.json')),
    records: JSON.stringify(mocks.config),
  };
  fs.appendFileSync(path.join(mocks.bundledRoot, 'deck-layout/SKILL.md'), '\nUpdated guide for H1 runtime failure');
  fs.appendFileSync(path.join(mocks.bundledRoot, 'deck-layout/scripts/generate.cjs'), '\nvoid 20261009;');
  fs.rmdirSync(mocks.appPath);
  mocks.notify.mockClear();

  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { upgraded: [], failed: [{ slug: 'deck-layout', error: 'slidegen-runtime-unavailable' }] },
  });
  expect(fs.readFileSync(path.join(target, 'SKILL.md')), '失败的更新不许把新 SKILL.md 留在盘上').toEqual(before.skill);
  expect(fs.readFileSync(path.join(target, 'scripts/generate.cjs'))).toEqual(before.script);
  expect(fs.readFileSync(path.join(target, 'scripts/generate-runtime.json')), 'runtime 侧车同属一个事务').toEqual(
    before.runtime,
  );
  expect(JSON.stringify(mocks.config), '本技能旧账必须逐字节恢复').toBe(before.records);
  expect(mocks.notify, '事务没成功 ⇒ 一条缓存通知都不发').not.toHaveBeenCalled();

  // 恢复环境 ⇒ **普通** ensure 就该升级成功、无冲突（不是把自己的写入判成 user-modified）。
  fs.mkdirSync(mocks.appPath);
  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { upgraded: ['deck-layout'], conflicts: [], failed: [] },
  });
});

it('H1/E1：账写不下去（配置写失败）⇒ 文件与旧账一起回滚，别的技能照升不误', async () => {
  expect(await invoke('skills:our-ensure')).toMatchObject({ ok: true, result: { failed: [] } });
  const oldDeckRecord = records()[mocks.managedDir]!['deck-layout'];
  const target = path.join(mocks.managedDir, 'deck-layout');
  const oldSkill = fs.readFileSync(path.join(target, 'SKILL.md'));
  const oldRuntime = JSON.parse(fs.readFileSync(path.join(target, 'scripts/generate-runtime.json'), 'utf8')) as {
    launcherSha256: string;
  };
  // 两个技能同时有随包更新；只让**第一次**记账写失败（deck-layout 字母序在前）。
  fs.appendFileSync(path.join(mocks.bundledRoot, 'deck-layout/SKILL.md'), '\nUpdated guide');
  fs.appendFileSync(path.join(mocks.bundledRoot, 'deck-layout/scripts/generate.cjs'), '\nvoid 1;');
  fs.appendFileSync(path.join(mocks.bundledRoot, 'other-skill/SKILL.md'), '\nUpdated other');
  mocks.configWriteFails = 1;
  mocks.notify.mockClear();

  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { upgraded: ['other-skill'], failed: [{ slug: 'deck-layout', error: 'config-write-failed' }] },
  });
  expect(fs.readFileSync(path.join(target, 'SKILL.md')), '账写不成 ⇒ 文件也要回滚').toEqual(oldSkill);
  expect(
    (
      JSON.parse(fs.readFileSync(path.join(target, 'scripts/generate-runtime.json'), 'utf8')) as {
        launcherSha256: string;
      }
    ).launcherSha256,
    'runtime 侧车要跟着旧 launcher 一起回滚（否则下一次 ownership 检查会报"脚本被改过"）',
  ).toBe(oldRuntime.launcherSha256);
  expect(records()[mocks.managedDir]!['deck-layout'], '本技能旧账不动').toBe(oldDeckRecord);
  expect(records()[mocks.managedDir]!['other-skill'], '别的技能的账照写').toMatch(/^pkg2:/);
  expect(mocks.notify.mock.calls.map((call) => (call[0] as { slug: string }).slug)).toEqual(['other-skill']);

  // 再 ensure 一次：deck-layout 这次该升级成功（侧车回滚干净 ⇒ 不会被判成脚本被改过）。
  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { upgraded: ['deck-layout'], conflicts: [], failed: [] },
  });
});

it('H1/E1：新装失败（runtime 起不来）⇒ 不留半装状态：文件回滚、不记账、不通知', async () => {
  fs.rmdirSync(mocks.appPath);
  expect(await invoke('skills:our-install', 'deck-layout')).toMatchObject({
    ok: false,
    error: 'slidegen-runtime-unavailable',
  });
  const target = path.join(mocks.managedDir, 'deck-layout');
  expect(fs.existsSync(path.join(target, 'SKILL.md')), 'runtime 起不来 ⇒ 不许把文件留在盘上').toBe(false);
  expect(fs.existsSync(target), '连刚建出来的空壳目录也要收掉').toBe(false);
  expect(
    (mocks.config as { bundledSkillRecords?: Record<string, Record<string, string>> }).bundledSkillRecords?.[
      mocks.managedDir
    ]?.['deck-layout'],
    '失败不记账',
  ).toBeUndefined();
  expect(mocks.notify).not.toHaveBeenCalled();

  // 环境恢复 ⇒ 同样的动作这次成功，且账当场写下（不是"下一次也许自愈"）。
  fs.mkdirSync(mocks.appPath);
  expect(await invoke('skills:our-install', 'deck-layout')).toEqual({ ok: true });
  expect(records()[mocks.managedDir]!['deck-layout']).toMatch(/^pkg2:/);
});

it('H1/E1：认领（adopt）前先核 runtime —— 起不来就**不写新账**（不写未核验的账）', async () => {
  expect(await invoke('skills:our-ensure')).toMatchObject({ ok: true, result: { failed: [] } });
  // 造"无账、但盘上与当前包逐字一致"的老盘：把记录抹掉即可。
  delete records()[mocks.managedDir]!['deck-layout'];
  fs.rmdirSync(mocks.appPath);
  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { adopted: [], failed: [{ slug: 'deck-layout', error: 'slidegen-runtime-unavailable' }] },
  });
  expect(records()[mocks.managedDir]!['deck-layout'], 'runtime 没验过 ⇒ 认领也不许先写账').toBeUndefined();

  fs.mkdirSync(mocks.appPath);
  expect(await invoke('skills:our-ensure')).toMatchObject({
    ok: true,
    result: { adopted: ['deck-layout'], failed: [] },
  });
  expect(records()[mocks.managedDir]!['deck-layout'], 'runtime 验过 ⇒ 认领照常写账').toMatch(/^pkg2:/);
});

/**
 * ⭐⭐ E2（2026-10-09 终审）：显式修复成功后**恢复资产必须留下并且可定位** ——
 * 旧实现把备份建在系统临时目录、`finally` 里无条件 rm，用户换掉自己的文件后一份都找不回。
 */
it('H1/E2：显式修复的恢复资产落在持久目录（userData/skill-backups），可读、含用户额外文件与旧记录', async () => {
  expect(await invoke('skills:our-ensure')).toMatchObject({ ok: true, result: { failed: [] } });
  const target = path.join(mocks.managedDir, 'other-skill');
  const userBytes = Buffer.from('用户改过的 SKILL（修复前的现场）\n');
  fs.writeFileSync(path.join(target, 'SKILL.md'), userBytes);
  fs.writeFileSync(path.join(target, '用户笔记.md'), '额外文件');
  const recordedBefore = records()[mocks.managedDir]!['other-skill'];

  const outcome = (await invoke('skills:our-install', 'other-skill')) as {
    ok: boolean;
    result?: { backupDir?: string };
  };
  expect(outcome).toMatchObject({ ok: true });
  const backupDir = outcome.result?.backupDir ?? '';
  expect(backupDir, '成功结果必须带出备份位置（界面要能告诉用户去哪儿找回）').toBeTruthy();
  expect(
    path.resolve(backupDir).startsWith(path.resolve(path.join(mocks.userData, 'skill-backups'))),
    '恢复资产必须在**持久**目录里（系统临时目录会被清理）',
  ).toBe(true);
  expect(path.resolve(backupDir).startsWith(path.resolve(mocks.managedDir)), '恢复目录不得在技能目录树里').toBe(false);
  // E2 命名空间：用户字节（`files/`）与系统恢复清单（`manifest.json`）分开存放。
  expect(fs.readFileSync(path.join(backupDir, 'files', 'SKILL.md')), '备份里要有修复前的旧内容').toEqual(userBytes);
  expect(fs.readFileSync(path.join(backupDir, 'files', '用户笔记.md'), 'utf8'), '完整快照含用户额外文件').toBe(
    '额外文件',
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8')) as {
    schemaVersion: number;
    payloadDir: string;
    slug: string;
    recorded: string;
    files: Record<string, string>;
  };
  expect(manifest.schemaVersion).toBe(1);
  expect(manifest.payloadDir, '清单必须告诉人工恢复：用户字节在哪个子目录').toBe('files');
  expect(manifest.slug).toBe('other-skill');
  expect(manifest.recorded, '清单里要有**旧来源记录**').toBe(recordedBefore);
  expect(manifest.files['SKILL.md'], '清单要有逐文件 sha（人工恢复时对读）').toMatch(/^[a-f0-9]{64}$/);
  // 修复本身照旧语义：厂商文件到位、用户额外文件原样。
  expect(fs.readFileSync(path.join(target, 'SKILL.md'))).not.toEqual(userBytes);
  expect(fs.readFileSync(path.join(target, '用户笔记.md'), 'utf8')).toBe('额外文件');
});

/**
 * ⭐⭐ E2 终审反例（H1–H6 E 轮，2026-10-09）之一：**用户技能可以自带任何文件名**。
 *
 * 旧实现把"用户文件快照"和"系统恢复清单"都写在备份根的同一条路径（`<备份根>/manifest.json`）上：
 * 用户自己的 `manifest.json` 备份会被系统清单**当场覆盖** —— 而这份备份正是显式修复成功后
 * 用户唯一的后悔药；修复还返回 ok=true（假成功）。
 */
it('H1/E2：用户自带的 manifest.json 必须原样备份（系统恢复清单不得覆盖它）', async () => {
  expect(await invoke('skills:our-install', 'other-skill')).toMatchObject({ ok: true });
  const target = path.join(mocks.managedDir, 'other-skill');
  const userSkill = Buffer.from('user SKILL before E2 manifest collision\n');
  const userManifest = Buffer.from('{"owner":"user","exactOriginalName":"manifest.json"}\n');
  fs.writeFileSync(path.join(target, 'SKILL.md'), userSkill);
  fs.writeFileSync(path.join(target, 'manifest.json'), userManifest);

  const outcome = (await invoke('skills:our-install', 'other-skill')) as {
    ok: boolean;
    result?: { backupDir?: string };
  };
  expect(outcome, '确认修复本身照旧成功').toMatchObject({ ok: true });
  const backupDir = outcome.result?.backupDir ?? '';
  expect(backupDir).toBeTruthy();

  const backedUpUserManifest = fs.readFileSync(path.join(backupDir, 'files', 'manifest.json'));
  const userManifestSha = createHash('sha256').update(userManifest).digest('hex');
  expect(
    createHash('sha256').update(backedUpUserManifest).digest('hex'),
    '用户 manifest.json 的备份必须与修复前逐字节一致',
  ).toBe(userManifestSha);
  const metadata = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8')) as {
    payloadDir: string;
    files: Record<string, string>;
  };
  expect(metadata.payloadDir).toBe('files');
  expect(metadata.files['manifest.json'], '恢复清单记录的 sha 必须指向用户原字节').toBe(userManifestSha);
  // 修复本身照旧语义：厂商 SKILL.md 到位；用户 manifest.json 不在替换面里，不动。
  expect(fs.readFileSync(path.join(target, 'SKILL.md'))).not.toEqual(userSkill);
  expect(fs.readFileSync(path.join(target, 'manifest.json')), '用户文件不在厂商清单里 ⇒ 一个字节都不许动').toEqual(
    userManifest,
  );
});

/**
 * ⭐⭐ E2 终审反例之二：账写不下去 ⇒ 整批回滚时，**系统恢复清单绝不能被当成用户文件写回去**。
 *
 * 旧实现在这条路上把元数据拷回用户目录（`restore-failed:manifest.json`），用户的
 * `manifest.json` 被系统清单覆盖 —— 一次故障注入就成立，不需要两个异常叠加。
 */
it('H1/E2：一次配置写失败的回滚不得用系统清单覆盖用户 manifest.json（目标字节与旧账全恢复）', async () => {
  expect(await invoke('skills:our-install', 'other-skill')).toMatchObject({ ok: true });
  const target = path.join(mocks.managedDir, 'other-skill');
  const userSkill = Buffer.from('user SKILL before E2 rollback\n');
  const userManifest = Buffer.from('{"owner":"user","exactOriginalName":"manifest.json"}\n');
  fs.writeFileSync(path.join(target, 'SKILL.md'), userSkill);
  fs.writeFileSync(path.join(target, 'manifest.json'), userManifest);
  const oldRecord = records()[mocks.managedDir]!['other-skill']!;
  mocks.configWriteFails = 1;
  mocks.notify.mockClear();

  const outcome = (await invoke('skills:our-install', 'other-skill')) as { ok: boolean; error?: string };
  expect(outcome.ok, '账写不下去 ⇒ 如实失败，不许半截成功').toBe(false);
  expect(outcome.error, '回滚已逐字节核验 ⇒ 不出现 restore-failed').not.toContain('restore-failed');
  expect(fs.readFileSync(path.join(target, 'SKILL.md')), '旧 SKILL 必须逐字节回滚').toEqual(userSkill);
  expect(fs.readFileSync(path.join(target, 'manifest.json')), '用户 manifest.json 不得被系统清单覆盖').toEqual(
    userManifest,
  );
  expect(records()[mocks.managedDir]!['other-skill'], '旧账恢复').toBe(oldRecord);
  expect(mocks.notify, '事务没成功 ⇒ 一条缓存通知都不发').not.toHaveBeenCalled();
});

/**
 * ⭐⭐ F1（2026-10-09 H1–H6 终审反例）：`skills:our-ensure` 里 staging 目录的清理**在事务之外**，
 * 清理失败（杀软/句柄锁住临时目录的 EACCES）经外层 catch 把**已经定稿的更新**整轮报成失败 ——
 * 启动就绪判据据此反复重试，用户看到的是假的"装不上"。
 *
 * 契约：清理失败只留一条诊断（与 `installBundledSkill`/`installAndRecordSkill` 同一条纪律），
 * 成功照样如实报成功、通知照发、**循环照常继续**；真实事务失败不许被这一层 catch 吞掉或改写。
 */
it('H1/F1：staging 清理失败（EACCES）不得把已定稿的更新报成失败 —— 诊断留下、循环继续', async () => {
  expect(await invoke('skills:our-ensure')).toMatchObject({ ok: true, result: { failed: [] } });
  const target = path.join(mocks.managedDir, 'other-skill');
  const oldRecord = records()[mocks.managedDir]!['other-skill'];
  // 把应用挪个位置：循环尾的 deck-layout 启动器刷新是"清理异常之后处理仍继续"的可观察探针。
  mocks.appPath = path.join(root, 'moved application f1');
  fs.mkdirSync(mocks.appPath);
  fs.appendFileSync(path.join(mocks.bundledRoot, 'other-skill/SKILL.md'), '\nF1 vendor revision');
  const expected = fs.readFileSync(path.join(mocks.bundledRoot, 'other-skill/SKILL.md'));
  // 注入：任何 staging 目录的清理都 EACCES（真机形态：临时目录被占用/被拦）。
  const rm = fs.rmSync.bind(fs);
  const cleanupAttempts: string[] = [];
  const spy = vi.spyOn(fs, 'rmSync').mockImplementation((p, opts) => {
    if (path.basename(String(p)).startsWith('royin-skill-stage-')) {
      cleanupAttempts.push(String(p));
      throw Object.assign(new Error('stage-cleanup-EACCES'), { code: 'EACCES' });
    }
    return rm(p, opts);
  });
  mocks.notify.mockClear();
  try {
    const outcome = (await invoke('skills:our-ensure')) as {
      ok: boolean;
      result?: { upgraded: string[]; failed: Array<{ slug: string; error: string }> };
    };
    // ① 更新已经定稿（文件+账）⇒ 如实成功；清理异常不许把整轮升级改成失败。
    expect(outcome).toMatchObject({ ok: true, result: { upgraded: ['other-skill'], failed: [] } });
    // ② 目标新字节与新账一致；成功通知仍**恰一次**（不吞、不重发）。
    expect(fs.readFileSync(path.join(target, 'SKILL.md'))).toEqual(expected);
    expect(records()[mocks.managedDir]!['other-skill']).not.toBe(oldRecord);
    expect(records()[mocks.managedDir]!['other-skill']).toMatch(/^pkg2:/);
    expect(mocks.notify.mock.calls.map((call) => (call[0] as { slug: string }).slug)).toEqual(['other-skill']);
    // ③ 清理诊断可观察（debug logger 的 warn 出口），且清理确实只尝试了一次（不是靠重试掩盖）。
    expect(cleanupAttempts).toHaveLength(1);
    expect(mocks.warn).toHaveBeenCalledWith({
      domain: 'gateway',
      event: 'skills.transaction-diagnostic',
      message: expect.stringContaining('staging-cleanup-failed:'),
    });
    // ④ 清理异常之后的处理照常继续：循环尾的 deck-layout 启动器刷新已把路径指向新位置。
    expect(config().args).toEqual([mocks.appPath]);

    // ⑤ 后续技能继续处理：再来一轮（两个技能都有新随包版本）—— 第一个技能的清理异常
    //    不许中断循环，后面的技能必须照升，且每个成功的技能仍各通知恰一次。
    fs.appendFileSync(path.join(mocks.bundledRoot, 'deck-layout/SKILL.md'), '\nF1 vendor revision');
    fs.appendFileSync(path.join(mocks.bundledRoot, 'other-skill/SKILL.md'), '\nF1 second revision');
    mocks.notify.mockClear();
    const second = (await invoke('skills:our-ensure')) as {
      ok: boolean;
      result?: { upgraded: string[]; failed: Array<{ slug: string; error: string }> };
    };
    expect(second.ok).toBe(true);
    expect([...(second.result?.upgraded ?? [])].sort()).toEqual(['deck-layout', 'other-skill']);
    expect(second.result?.failed).toEqual([]);
    expect(cleanupAttempts, '两个技能各清理一次（加上第一轮的一次）').toHaveLength(3);
    expect(mocks.notify.mock.calls.map((call) => (call[0] as { slug: string }).slug).sort()).toEqual([
      'deck-layout',
      'other-skill',
    ]);
  } finally {
    spy.mockRestore();
  }
});

/**
 * ⭐⭐ F1 对照：清理异常**不得**把真实事务失败吞掉或改写成成功 —— 真失败继续进 `failed`
 * （带着真实原因），失败的技能照常回滚文件与旧账，别的技能照升。
 */
it('H1/F1 对照：真实事务失败不许被 staging 清理异常吞掉或改写成成功', async () => {
  expect(await invoke('skills:our-ensure')).toMatchObject({ ok: true, result: { failed: [] } });
  const target = path.join(mocks.managedDir, 'deck-layout');
  const oldSkill = fs.readFileSync(path.join(target, 'SKILL.md'));
  const oldRecord = records()[mocks.managedDir]!['deck-layout'];
  fs.appendFileSync(path.join(mocks.bundledRoot, 'deck-layout/SKILL.md'), '\nF1 control revision');
  fs.appendFileSync(path.join(mocks.bundledRoot, 'other-skill/SKILL.md'), '\nF1 control revision');
  mocks.configWriteFails = 1; // deck-layout 字母序在前 ⇒ 它的账写不进去（真实事务失败）
  const rm = fs.rmSync.bind(fs);
  const spy = vi.spyOn(fs, 'rmSync').mockImplementation((p, opts) => {
    if (path.basename(String(p)).startsWith('royin-skill-stage-')) {
      throw Object.assign(new Error('stage-cleanup-EACCES'), { code: 'EACCES' });
    }
    return rm(p, opts);
  });
  mocks.notify.mockClear();
  try {
    const outcome = (await invoke('skills:our-ensure')) as {
      ok: boolean;
      result?: { upgraded: string[]; failed: Array<{ slug: string; error: string }> };
    };
    // 真实失败如实报出（不是被清理异常顶替、更不是转成成功）；别的技能照升、照通知。
    expect(outcome).toMatchObject({
      ok: true,
      result: { upgraded: ['other-skill'], failed: [{ slug: 'deck-layout', error: 'config-write-failed' }] },
    });
    expect(fs.readFileSync(path.join(target, 'SKILL.md')), '失败技能的文件要回滚').toEqual(oldSkill);
    expect(records()[mocks.managedDir]!['deck-layout'], '失败技能的旧账要恢复').toBe(oldRecord);
    expect(mocks.notify.mock.calls.map((call) => (call[0] as { slug: string }).slug)).toEqual(['other-skill']);
    expect(mocks.warn).toHaveBeenCalledWith({
      domain: 'gateway',
      event: 'skills.transaction-diagnostic',
      message: expect.stringContaining('staging-cleanup-failed:'),
    });
  } finally {
    spy.mockRestore();
  }
});

/**
 * ⭐⭐ F2（同轮反例）：显式修复的 whole-directory 快照枚举失败被吞成空数组 ⇒ 恢复资产
 * 不完整（用户子目录一个都没进备份）却仍执行替换、返回成功。
 *
 * 契约：核验不了**完整**快照 ⇒ 具名失败（`skill-backup-snapshot-unreadable`），
 * 在任何目标写入/记账/通知之前停手。
 */
it('H1/F2：整目录快照枚举失败（用户子目录 EACCES）⇒ 具名失败，替换之前停手', async () => {
  expect(await invoke('skills:our-install', 'other-skill')).toEqual({ ok: true });
  const target = path.join(mocks.managedDir, 'other-skill');
  const userSkill = Buffer.from('user SKILL before F2 snapshot failure\n');
  fs.writeFileSync(path.join(target, 'SKILL.md'), userSkill);
  const notes = path.join(target, 'user-notes');
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, 'extra.txt'), 'user extra content');
  const oldRecord = records()[mocks.managedDir]!['other-skill'];
  const readdir = fs.readdirSync.bind(fs);
  let failures = 0;
  const spy = vi.spyOn(fs, 'readdirSync').mockImplementation((...args: Parameters<typeof fs.readdirSync>) => {
    if (String(args[0]) === notes) {
      failures += 1;
      throw Object.assign(new Error('extra-directory-EACCES'), { code: 'EACCES' });
    }
    return readdir(...args);
  });
  mocks.notify.mockClear();
  try {
    const outcome = (await invoke('skills:our-install', 'other-skill')) as { ok: boolean; error?: string };
    // ① 具名失败：快照核不全 ⇒ 不许替换；枚举恰尝试一次（不靠重试掩盖）。
    expect(outcome).toEqual({ ok: false, error: 'skill-backup-snapshot-unreadable' });
    expect(failures).toBe(1);
    // ② "替换之前停手"的观察点：目标字节、用户文件、旧账全部原样，一条通知都没发；
    //    连持久恢复目录都还没建（枚举失败发生在任何写盘之前）。
    expect(fs.readFileSync(path.join(target, 'SKILL.md'))).toEqual(userSkill);
    expect(fs.readFileSync(path.join(notes, 'extra.txt'), 'utf8')).toBe('user extra content');
    expect(records()[mocks.managedDir]!['other-skill']).toBe(oldRecord);
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(mocks.userData, 'skill-backups'))).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

/**
 * ⭐⭐ F3（同轮反例）：显式修复的 whole-directory 分支只枚举"现在盘上有"的文件 ——
 * 声明要一起恢复、但**原先不存在**的 runtime 侧车没进快照；修复重建它之后一旦回滚，
 * 侧车被留在盘上（"回到原现场"不成立，下一次 ownership 判定还可能被它带偏）。
 *
 * 契约：快照 = 本次会动的文件 ∪ 目录枚举结果 ∪ **声明路径**（含"声明了但不存在"的那些）。
 */
it('H1/F3：修复回滚必须恢复"原先不存在"的 runtime 侧车', async () => {
  expect(await invoke('skills:our-install', 'deck-layout')).toEqual({ ok: true });
  const target = path.join(mocks.managedDir, 'deck-layout');
  const runtime = path.join(target, 'scripts/generate-runtime.json');
  fs.unlinkSync(runtime); // 现场：侧车原先不存在（用户/环境删掉了它）
  const skill = fs.readFileSync(path.join(target, 'SKILL.md'));
  const oldRecord = records()[mocks.managedDir]!['deck-layout'];
  mocks.configWriteFails = 1; // 修复会**重建**侧车；随后的单次记账失败 ⇒ 整批回滚
  mocks.notify.mockClear();
  const outcome = (await invoke('skills:our-install', 'deck-layout')) as { ok: boolean; error?: string };
  expect(outcome).toMatchObject({ ok: false, error: 'config-write-failed' });
  expect(fs.existsSync(runtime), '回滚要恢复到"不存在"，而不是把重建出来的侧车留在盘上').toBe(false);
  expect(fs.readFileSync(path.join(target, 'SKILL.md'))).toEqual(skill);
  expect(records()[mocks.managedDir]!['deck-layout']).toBe(oldRecord);
  expect(mocks.notify, '事务没成功 ⇒ 一条缓存通知都不发').not.toHaveBeenCalled();
});
