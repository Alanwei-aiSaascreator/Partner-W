import { describe, expect, it } from 'vitest';
import {
  LAUNCHER_VERSION_ARGUMENT,
  LauncherVersionError,
  normalizeLauncherVersion,
  probeLauncherVersion,
  type LauncherRunner,
  type LauncherRunnerInput,
} from '../src/main/update/launcher-version.js';

/**
 * 盘上启动器的**真实版本**从哪来。
 *
 * 为什么需要它（2026-09-23 取证）：`update-handlers.ts:27-28` 以前把
 * `LAUNCHER_PROTOCOL_VERSION = '1.0.0'` 这个**硬编码**值当启动器版本传给服务，
 * `portable-manifest.ts:137-139` 拿它去比 `manifest.minLauncherVersion` ——
 * 比的是一个**我们编出来的数字**，不是盘上那个 exe 的版本 ⇒ `minLauncherVersion`
 * 是一道假门。真值一直有通道，只是从没被调用：`launcher/cmd/mofang-launcher/main.go:52-54`
 * 收 `--version`、`:133-136` 把 `deps.version` 打到 stdout，版本由 ldflags
 * `-X main.version=<MOFANG_LAUNCHER_VERSION>` 注入
 * （`scripts/lib/portable-launcher-build.mjs:49`）。
 *
 * 比"更准"更要紧的一点：发布侧 `scripts/make-portable-update.mjs:55` 把
 * `minLauncherVersion` 也设成**同一个** `MOFANG_LAUNCHER_VERSION`，
 * 所以两侧本来就是同一条版本线 —— 硬编码的 '1.0.0' 只是恰好 >= 真实版本而"过关"。
 * 换成真值以后：盘上启动器比清单要求的旧 ⇒ 真的判 `launcher-incompatible`
 * （正确的补救就是那个错误码对应的"换新交付包"）。
 *
 * ⚠️ 探测失败**不许**静默退回某个版本 —— 那正是这个洞本身。这里的出口是
 * `{ kind: 'unavailable' }`，由服务把它变成**拒绝一切更新**（`launcher-incompatible`）。
 */

describe('启动器版本：解析 stdout', () => {
  it('标准输出（含尾随换行）⇒ 得到裸 semver', () => {
    expect(normalizeLauncherVersion('0.0.27\n')).toBe('0.0.27');
    expect(normalizeLauncherVersion('0.0.27\r\n')).toBe('0.0.27');
    expect(normalizeLauncherVersion('  0.0.27  ')).toBe('0.0.27');
  });

  it('预发布版本号也认（发布侧用 RELEASE_TAG 注入，可能带 -rc）', () => {
    expect(normalizeLauncherVersion('0.0.27-rc.1\n')).toBe('0.0.27-rc.1');
  });

  it('⭐ ldflags 没注入时的 Go 默认值 `dev` ⇒ 拒绝（不是"当成 1.0.0"）', () => {
    expect(() => normalizeLauncherVersion('dev\n')).toThrow(LauncherVersionError);
  });

  it('空输出 ⇒ 拒绝', () => {
    expect(() => normalizeLauncherVersion('')).toThrow(LauncherVersionError);
    expect(() => normalizeLauncherVersion('   \n')).toThrow(LauncherVersionError);
  });

  it('带 `v` 前缀 ⇒ 拒绝（发布侧 `RELEASE_TAG#v` 已经剥掉；这里认了会把坏构建放过去）', () => {
    expect(() => normalizeLauncherVersion('v0.0.27\n')).toThrow(LauncherVersionError);
  });

  it('多行输出（启动器还在别的信息）⇒ 拒绝，不做"猜哪一行"', () => {
    expect(() => normalizeLauncherVersion('0.0.27\nextra\n')).toThrow(LauncherVersionError);
  });
});

describe('启动器版本：探测（注入的 runner）', () => {
  const launcherPath = 'D:\\\\荣盈魔方\\荣盈魔方启动器.exe';

  it('⭐ 用 `--version` 这**唯一**一个参数去问（多一个参数就可能落到 `--apply` 那条路上）', async () => {
    // ⚠️ 用显式收集而不是 `vi.fn()`：无参的 `vi.fn()` 会把 `mock.calls` 推成 `[]`，
    //    `calls[0][0]` 就过不了 `typecheck:tests`（`tsc -p tsconfig.test.json` 报 TS2493）。
    const calls: LauncherRunnerInput[] = [];
    const run: LauncherRunner = async (input) => {
      calls.push(input);
      return '0.0.27\n';
    };

    await probeLauncherVersion({ launcherPath, runLauncher: run });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ launcherPath, args: [LAUNCHER_VERSION_ARGUMENT] });
    expect(LAUNCHER_VERSION_ARGUMENT).toBe('--version');
  });

  it('拿到真版本 ⇒ kind=version', async () => {
    const result = await probeLauncherVersion({ launcherPath, runLauncher: async () => '0.0.27\n' });

    expect(result).toEqual({ kind: 'version', version: '0.0.27' });
  });

  it('⭐ 跑不起来（exe 不在/不是我们的启动器）⇒ kind=unavailable，且 reason 说得出原因', async () => {
    const run = async (): Promise<string> => {
      throw new Error('spawn 荣盈魔方启动器.exe ENOENT');
    };

    const result = await probeLauncherVersion({ launcherPath, runLauncher: run });

    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toContain('ENOENT');
    }
  });

  it('⭐ 输出不是版本号 ⇒ kind=unavailable，并且把原始输出带进 reason（别让人只看到"失败"）', async () => {
    const result = await probeLauncherVersion({ launcherPath, runLauncher: async () => 'not-a-version\n' });

    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toContain('not-a-version');
    }
  });

  it('超时会走到 unavailable（runner 负责超时；这里证明上层不会把异常当版本）', async () => {
    const run = async (): Promise<string> => {
      throw new LauncherVersionError('probing the launcher version timed out');
    };

    const result = await probeLauncherVersion({ launcherPath, runLauncher: run });

    expect(result.kind).toBe('unavailable');
  });
});

describe('启动器版本：真 spawn（这条才碰得到 spawn 管道，注入 runner 的测试永远碰不到）', () => {
  it('⭐ 真跑一个进程并收它的 stdout：node --version 打的是 `v26.…` ⇒ 被严格 semver 拒掉', async () => {
    // 用 node 自己冒充"启动器"：它收到 `--version` 会往 stdout 打一行 `v<版本>`。
    // 这条同时证明三件事：spawn 管道通、stdout 真收到了、带 `v` 前缀的版本会被拒。
    const result = await probeLauncherVersion({ launcherPath: process.execPath, timeoutMs: 15_000 });

    expect(result.kind).toBe('unavailable');
    if (result.kind === 'unavailable') {
      expect(result.reason).toContain('v');
      expect(result.reason).toContain(process.versions.node);
    }
  });

  it('路径根本不存在 ⇒ unavailable（不抛出去，由调用方决定出口）', async () => {
    const result = await probeLauncherVersion({
      launcherPath: 'D:\\definitely-not-here\\荣盈魔方启动器.exe',
      timeoutMs: 15_000,
    });

    expect(result.kind).toBe('unavailable');
  });
});

describe('与真装配点的一致性（ipc/update-handlers.ts，不是合成调用）', () => {
  const HERE = new URL('.', import.meta.url);
  const handlersPath = new URL('../src/main/ipc/update-handlers.ts', HERE);

  it('⭐ 装配点用真探测，且**硬编码的启动器版本已经消失**', async () => {
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(handlersPath, 'utf-8'));

    expect(raw).toContain('probeLauncherVersion({ launcherPath })');
    // 这两条就是"假门"的形状：一个写死的协议版本常量、或直接传一个字面量。
    expect(raw).not.toContain('LAUNCHER_PROTOCOL_VERSION');
    expect(raw).not.toMatch(/launcherVersion:\s*'/);
  });

  it('⭐ 探测在 `createPortableUpdateService` **之前**发生（顺序反了就等于没修）', async () => {
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(handlersPath, 'utf-8'));
    const probeAt = raw.indexOf('probeLauncherVersion({ launcherPath })');
    const createAt = raw.indexOf('createPortableUpdateService({');

    expect(probeAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(-1);
    expect(probeAt).toBeLessThan(createAt);
  });

  it('探测失败的出口是把 null 交给服务（不是退回某个版本号）', async () => {
    const raw = await import('node:fs/promises').then((fs) => fs.readFile(handlersPath, 'utf-8'));

    expect(raw).toContain("probe.kind === 'version' ? probe.version : null");
  });
});
