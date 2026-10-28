import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUNDLED_RUNTIME_DIR_NAME, RUNTIME_MANIFEST_FILE } from '../src/main/runtime/locate.js';

/**
 * 打包门禁：**缺运行时必须让构建失败**，不许静默打出一个没有运行时的安装包。
 *
 * 为什么要单独测这个：electron-builder 对不存在的 extraResources 源只 warn 不报错
 * （`fileMatcher.js` 的 `copyFiles()`），所以"忘了产出 runtime-out/"和"一切正常"
 * 在构建日志里长得几乎一样。门禁是挂在 `electron-builder.yml` 的 `beforePack` 上的
 * 一个 `.cjs`（构建脚本不能被 main 进程 import），这里用 createRequire 直接读它。
 *
 * ⚠️ 纯函数部分用**注入的 exists**（不依赖真盘、更不依赖那个 222MB 的 runtime-out/）；
 * 与**真配置**的一致性靠本文件末尾那组文本断言 —— 没有它，把 yml 里那条
 * extraResources 删掉时，上面所有用合成配置的测试**照样绿**。
 */

const requireCjs = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

interface PackagingGate {
  checkBundledRuntime: (config: unknown, projectDir: string, exists?: (p: string) => boolean) => string | null;
  collectProblems: (config: unknown, projectDir: string, exists?: (p: string) => boolean) => string[];
  staticExtraResourceSources: (
    config: unknown,
    projectDir: string,
  ) => { from: string; to: string | null; abs: string }[];
  beforePack: (context: unknown) => Promise<void>;
  BUNDLED_TO: string;
  MARKER: string;
}

const gate = requireCjs('../scripts/require-bundled-runtime.cjs') as PackagingGate;

const PROJECT_DIR = 'C:\\app\\packages\\desktop';
const RUNTIME_OUT = path.resolve(PROJECT_DIR, '../../runtime-out');

/** 与 `electron-builder.yml` 同形的配置（末尾有断言钉住"真配置就是这两条"）。 */
const config = {
  extraResources: [
    { from: 'build/icon.png', to: 'icon.png' },
    { from: '../../runtime-out', to: 'runtime' },
  ],
};

const only = (...paths: string[]): ((p: string) => boolean) => {
  const set = new Set(paths);
  return (p) => set.has(p);
};

describe('打包门禁：随包运行时（beforePack 钩子）', () => {
  it('⭐ runtime-out 不存在 ⇒ **硬失败**，报错是可操作的中文（这就是事故要根治的形状）', () => {
    const message = gate.checkBundledRuntime(config, PROJECT_DIR, only(path.resolve(PROJECT_DIR, 'build/icon.png')));

    expect(message).not.toBeNull();
    const text = message as string;
    expect(text).toContain('打包中止');
    expect(text).toContain('干净机器上起不来');
    expect(text).toContain(RUNTIME_OUT); // 缺的是哪个绝对路径
    expect(text).toContain('../../runtime-out'); // 配置里写的是什么
    expect(text).toContain(`基准 = ${PROJECT_DIR}`); // 基准说清楚（不赌相对路径）
    expect(text).toContain('pack-runtime.mjs'); // 怎么产出
    expect(text).toContain('worktree'); // 从 worktree 构建要先把 runtime-out 拷过去
  });

  it('⭐ 目录在但**没有 marker** ⇒ 同样失败（半成品/拷错目录不被当成"有运行时"）', () => {
    const message = gate.checkBundledRuntime(
      config,
      PROJECT_DIR,
      only(path.resolve(PROJECT_DIR, 'build/icon.png'), RUNTIME_OUT),
    );

    expect(message).toContain(RUNTIME_MANIFEST_FILE);
    expect(message).toContain(RUNTIME_OUT);
  });

  it('全都就位 ⇒ null（不该误伤正常构建）', () => {
    expect(
      gate.checkBundledRuntime(
        config,
        PROJECT_DIR,
        // 目录本身要存在（electron-builder 也是这样 stat 的），marker + 飞书 npm 负载也要在
        only(
          path.resolve(PROJECT_DIR, 'build/icon.png'),
          RUNTIME_OUT,
          path.join(RUNTIME_OUT, RUNTIME_MANIFEST_FILE),
          path.join(RUNTIME_OUT, 'node', 'npm.cmd'),
          path.join(RUNTIME_OUT, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
          path.join(RUNTIME_OUT, 'node', 'npm-cache', '_cacache'),
        ),
      ),
    ).toBeNull();
  });

  it('⭐ 缺飞书 npm 负载 ⇒ 构建失败（否则飞书只能发不能收）', () => {
    const message = gate.checkBundledRuntime(
      config,
      PROJECT_DIR,
      only(
        path.resolve(PROJECT_DIR, 'build/icon.png'),
        RUNTIME_OUT,
        path.join(RUNTIME_OUT, RUNTIME_MANIFEST_FILE),
        // 故意不给 npm.cmd / npm-cli / cache
      ),
    );
    expect(message).not.toBeNull();
    expect(message as string).toContain('npm.cmd');
  });

  it('⭐ 配置里没有 `to: runtime` 那条 ⇒ 失败（改成别的目录名 = 客户端永远找不到，静默）', () => {
    const message = gate.checkBundledRuntime(
      { extraResources: [{ from: 'build/icon.png', to: 'icon.png' }] },
      PROJECT_DIR,
      only(path.resolve(PROJECT_DIR, 'build/icon.png')),
    );

    expect(message).toContain('to: runtime');
    expect(message).toContain('bundled');
  });

  it('通配源（`*.png`）不参与"必须存在"的判定（匹配不到不一定是错）', () => {
    const sources = gate.staticExtraResourceSources({ extraResources: ['build/*.png', 'build/icon.png'] }, PROJECT_DIR);
    expect(sources.map((s) => s.from)).toEqual(['build/icon.png']);
  });

  it('⭐ beforePack（真文件系统）：齐全 ⇒ 通过；缺运行时 ⇒ 抛出那句让人知道怎么办的中文', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-w-gate-'));
    try {
      fs.writeFileSync(path.join(projectDir, 'icon.png'), '');
      fs.mkdirSync(path.join(projectDir, 'runtime-out'));
      const archive = Buffer.from('verified runtime fixture');
      fs.writeFileSync(path.join(projectDir, 'runtime-out', 'runtime.zip'), archive);
      const manifest = {
        runtimes: [
          {
            archive: 'runtime.zip',
            sha256: createHash('sha256').update(archive).digest('hex'),
            patches: ['partner-w-relay-video-trial-v1'],
          },
        ],
      };
      const manifestPath = path.join(projectDir, 'runtime-out', RUNTIME_MANIFEST_FILE);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      // 飞书可信安装所需的 npm 负载（BUG-171）
      fs.mkdirSync(path.join(projectDir, 'runtime-out', 'node', 'node_modules', 'npm', 'bin'), { recursive: true });
      fs.mkdirSync(path.join(projectDir, 'runtime-out', 'node', 'npm-cache', '_cacache'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'runtime-out', 'node', 'npm.cmd'), '@ECHO off\r\n');
      fs.writeFileSync(path.join(projectDir, 'runtime-out', 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');

      const sameShape = {
        extraResources: [
          { from: 'icon.png', to: 'icon.png' },
          { from: 'runtime-out', to: 'runtime' },
        ],
      };
      await expect(gate.beforePack({ packager: { projectDir, config: sameShape } })).resolves.toBeUndefined();

      manifest.runtimes[0].patches = [];
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      await expect(gate.beforePack({ packager: { projectDir, config: sameShape } })).rejects.toThrow(/runtime patch/);
      manifest.runtimes[0].patches = ['partner-w-relay-video-trial-v1'];
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      fs.appendFileSync(path.join(projectDir, 'runtime-out', 'runtime.zip'), 'corruption');
      await expect(gate.beforePack({ packager: { projectDir, config: sameShape } })).rejects.toThrow(/archive hash/);
      fs.writeFileSync(path.join(projectDir, 'runtime-out', 'runtime.zip'), archive);
      manifest.runtimes[0].archive = '../icon.png';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      await expect(gate.beforePack({ packager: { projectDir, config: sameShape } })).rejects.toThrow(/archive path/);

      // 把运行时删掉（= 忘了产出 runtime-out/）⇒ 构建必须中止
      fs.rmSync(path.join(projectDir, 'runtime-out'), { recursive: true });
      await expect(gate.beforePack({ packager: { projectDir, config: sameShape } })).rejects.toThrow(
        /打包中止[\s\S]*pack-runtime\.mjs/,
      );
    } finally {
      if (projectDir.includes(path.join(os.tmpdir(), 'partner-w-gate-'))) {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
    }
  });
});

describe('与 electron-builder.yml 的一致性（真配置，不是合成配置）', () => {
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'packages/desktop/electron-builder.yml'), 'utf-8');

  /**
   * ⚠️ 断言前**先剥掉注释**：注释掉的那行不算配置。
   *
   * 变异验证实测出来的教训：把 `beforePack:` 那行**注释掉**（而不是删掉）时，
   * 原先的 `toContain('beforePack: ./scripts/...')` 照样绿 —— 正是本仓库那类
   * 「假绿」的形状（抽取范围太宽）。这道门禁的意义就是"缺了必须红"，
   * 所以注释掉=没挂上，必须红。
   *
   * yml 里没有"值本身含 `#`"的字段（路径 / 域名 / 中文文案都没有），整行剥注释是安全的。
   */
  const yml = raw
    .split(/\r?\n/)
    .map((line) => (line.trimStart().startsWith('#') ? '' : line.replace(/\s#.*$/, '')))
    .join('\n');

  /** 抠出 `- from: X` / `to: Y` 相邻的条目（yml 里就这两种写法）。 */
  const entries = [...yml.matchAll(/-\s*from:\s*(\S+)\s*\n\s*to:\s*(\S+)/g)].map((m) => ({ from: m[1], to: m[2] }));

  it('⭐ 真配置里确实有 `from: ../../runtime-out` → `to: runtime`', () => {
    expect(entries).toContainEqual({ from: '../../runtime-out', to: 'runtime' });
  });

  it('⭐ 基准是 projectDir（= packages/desktop）⇒ 解出来正好是仓库根的 runtime-out/', () => {
    const projectDir = path.join(REPO_ROOT, 'packages', 'desktop');
    const from = entries.find((e) => e.to === 'runtime')?.from ?? '';
    expect(path.resolve(projectDir, from)).toBe(path.join(REPO_ROOT, 'runtime-out'));
  });

  it('门禁真的挂上了（beforePack 指到组合钩子，组合钩子再指到这个脚本）', () => {
    // electron-builder 只接受一个 beforePack，所以中间隔了一层组合钩子
    // （`scripts/before-pack.cjs`）。这里两步都查：只查组合钩子存在、
    // 不查它是否真的 require 本脚本的话，把本脚本从组合钩子里摘掉也不会红。
    expect(yml).toContain('beforePack: ./scripts/before-pack.cjs');
    const combiner = fs.readFileSync(path.join(REPO_ROOT, 'packages/desktop/scripts/before-pack.cjs'), 'utf-8');
    expect(combiner).toContain("require('./require-bundled-runtime.cjs')");
    expect(fs.existsSync(path.join(REPO_ROOT, 'packages/desktop/scripts/require-bundled-runtime.cjs'))).toBe(true);
  });

  it('⚠️ 一对天然会漂移的常量：脚本里的 BUNDLED_TO / MARKER == locate.ts 里的常量', () => {
    expect(gate.BUNDLED_TO).toBe(BUNDLED_RUNTIME_DIR_NAME);
    expect(gate.MARKER).toBe(RUNTIME_MANIFEST_FILE);
  });
});
