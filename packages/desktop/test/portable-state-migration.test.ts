import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  preparePortableState,
  rebasePortableConfig,
  PORTABLE_STATE_MIGRATION_BLOCKED,
} from '../src/main/runtime/portable-state-migration.js';
import { acquireStateReadLease } from '../src/main/runtime/state-read-lease.js';

let root: string;
let source: string;
let target: string;
const token = 'test-portable-identity';
const readLease = async () => ({ assertHeld() {}, async release() {} });
const write = (file: string, value: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
};
const writeConfig = (dir: string) =>
  write(path.join(dir, 'openclaw.json'), JSON.stringify({ gateway: { auth: { token } } }));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-migration-test-'));
  source = path.join(root, 'local', 'state', 'identity');
  target = path.join(root, 'portable', 'state', 'identity');
  writeConfig(source);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (root.startsWith(path.join(os.tmpdir(), 'clawwork-migration-test-')))
    fs.rmSync(root, { recursive: true, force: true });
});

const migrate = (overrides: Partial<Parameters<typeof preparePortableState>[0]> = {}) =>
  preparePortableState({
    sourceDir: source,
    stateDir: target,
    workspacePath: path.join(root, 'workspace'),
    token,
    acquireLease: readLease,
    ...overrides,
  });

describe('portable state migration', () => {
  it('copies database and all sidecars together, retains originals and excludes disposable locks', async () => {
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      write(path.join(source, 'state', `openclaw.sqlite${suffix}`), `bytes:${suffix}`);
    write(path.join(source, 'agents', 'main', 'agent', 'history.sqlite-wal'), 'agent-wal');
    write(path.join(source, 'tmp', 'stale.tmp'), 'stale');
    await migrate();
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      expect(fs.readFileSync(path.join(target, 'state', `openclaw.sqlite${suffix}`), 'utf8')).toBe(`bytes:${suffix}`);
      expect(fs.readFileSync(path.join(source, 'state', `openclaw.sqlite${suffix}`), 'utf8')).toBe(`bytes:${suffix}`);
    }
    expect(fs.readFileSync(path.join(target, 'agents', 'main', 'agent', 'history.sqlite-wal'), 'utf8')).toBe(
      'agent-wal',
    );
    expect(fs.existsSync(path.join(target, 'tmp'))).toBe(false);
    expect(fs.existsSync(path.join(target, '.clawwork-portable-state.json'))).toBe(true);
  });

  it('refuses a live gateway before attempting to copy', async () => {
    write(path.join(source, 'tmp', 'openclaw', 'gateway.state.lock'), JSON.stringify({ pid: process.pid }));
    const acquireLease = vi.fn(readLease);
    // 无身份字段（无 startTime）⇒ 走"有界等待"分支；这里把等待压到 0 只钉"仍阻断"。
    await expect(migrate({ acquireLease, lockOwner: { waitMs: 0 } })).rejects.toMatchObject({
      code: PORTABLE_STATE_MIGRATION_BLOCKED,
    });
    expect(acquireLease).not.toHaveBeenCalled();
    expect(fs.existsSync(target)).toBe(false);
  });

  // ---------------------------------------------------------------- BUG-039
  //
  // 现场（2026-10-04 客户机）：`Gateway lock owner cannot be verified` /
  // `Previous gateway is still running` 让整盘卡死。真相是锁里的 pid 在**另一台
  // 机器上被系统复用**了 —— pid "活着"不等于"写锁的那个网关还活着"。判据必须
  // 走**进程身份**（锁里的 startTime vs 真实启动时间），无法核验时才退回到
  // 有界等待 + 可执行指引。**任何一条路径都不许 kill 进程。**
  const lockFile = (): string => path.join(source, 'tmp', 'openclaw', 'gateway.state.lock');
  const fixtureClock = () => {
    let nowMs = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      now: () => nowMs,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    };
  };

  it('⭐ PID 复用：锁里 pid 指向的进程启动时间对不上 ⇒ 判陈旧、隔离、继续迁移', async () => {
    write(
      lockFile(),
      JSON.stringify({
        pid: process.pid,
        startTime: 1_700_000_000_000,
        stateDir: source,
        createdAt: '2026-10-01T00:00:00.000Z',
      }),
    );
    await migrate({ lockOwner: { startTime: () => 1_700_000_999_999 } });
    expect(fs.existsSync(target)).toBe(true);
    const remaining = fs.readdirSync(path.join(source, 'tmp', 'openclaw'));
    expect(remaining).toEqual([expect.stringMatching(/^gateway\.state\.lock\.stale-/u)]);
  });

  it('⭐ 身份核验为真实存活（启动时间一致）⇒ 仍然阻断，且一分钟都不等', async () => {
    const clock = fixtureClock();
    write(lockFile(), JSON.stringify({ pid: process.pid, startTime: 1_700_000_000_000, stateDir: source }));
    const error = (await migrate({
      lockOwner: { startTime: () => 1_700_000_000_000, sleep: clock.sleep, now: clock.now },
    }).catch((reason: unknown) => reason)) as Error & { code?: string };
    expect(error.code).toBe(PORTABLE_STATE_MIGRATION_BLOCKED);
    expect(error.message).toMatch(/Previous gateway is still running/u);
    expect(error.message).toContain('gateway.state.lock');
    expect(error.message).toContain(String(process.pid));
    expect(clock.sleeps).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('⭐ 无法核验（锁里没有启动时间）但 pid 在等待窗口内消失 ⇒ 放行', async () => {
    const clock = fixtureClock();
    write(lockFile(), JSON.stringify({ pid: process.pid }));
    let probes = 0;
    await migrate({
      lockOwner: {
        liveness: () => (++probes >= 3 ? 'gone' : 'alive'),
        waitMs: 1_000,
        pollMs: 250,
        sleep: clock.sleep,
        now: clock.now,
      },
    });
    expect(fs.existsSync(target)).toBe(true);
    expect(clock.sleeps).toEqual([250, 250]);
  });

  it('⭐ 查询异常 / 无法核验且 pid 一直活着 ⇒ 有界等待后阻断，信息里给出锁文件与 pid', async () => {
    const clock = fixtureClock();
    write(lockFile(), JSON.stringify({ pid: process.pid }));
    const error = (await migrate({
      lockOwner: {
        // 模拟"探不动"（EPERM/超时 ⇒ unknown）：不能当成死了，也不能无限等。
        liveness: () => 'unknown',
        startTime: () => null,
        waitMs: 1_000,
        pollMs: 250,
        sleep: clock.sleep,
        now: clock.now,
      },
    }).catch((reason: unknown) => reason)) as Error & { code?: string };
    expect(error.code).toBe(PORTABLE_STATE_MIGRATION_BLOCKED);
    expect(error.message).toContain('gateway.state.lock');
    expect(error.message).toContain(String(process.pid));
    // 有界：等待窗口 1s / 250ms 一轮 ⇒ 恰好 4 次，不会无限轮询
    expect(clock.sleeps).toEqual([250, 250, 250, 250]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('⭐ 锁声明的 stateDir 不是这一份 state（旧盘符/别的机器残留）⇒ 隔离后继续，不等待', async () => {
    const clock = fixtureClock();
    write(
      lockFile(),
      JSON.stringify({ pid: process.pid, stateDir: 'Z:\\other-state', configPath: 'Z:\\other-state\\openclaw.json' }),
    );
    await migrate({ lockOwner: { sleep: clock.sleep, now: clock.now } });
    expect(fs.existsSync(target)).toBe(true);
    expect(clock.sleeps).toEqual([]);
    expect(fs.readdirSync(path.join(source, 'tmp', 'openclaw'))).toEqual([
      expect.stringMatching(/^gateway\.state\.lock\.stale-/u),
    ]);
  });

  /**
   * 换盘符重放（本地 subst 模拟 A→B）：真机现场就是"盘从 E: 变成 G:"。
   *
   * ⚠️ 只在 Windows 跑：subst 是 Windows 的机制。try/finally 保证映射一定删除
   *    （绝不在机器上留悬空盘符）。
   */
  const subst = (args: string[]): void => {
    execFileSync('subst', args, { windowsHide: true, stdio: 'ignore' });
  };
  /**
   * 以 `X:` 别名跑一段（BUG-059 附③ 现场形态：内核写 realpath、应用传别名）。
   * X: 已被占用 ⇒ 跳过（返回 undefined；沿用既有的环境限制约定）。
   */
  const withSubstX = async <T>(disk: string, fn: () => Promise<T>): Promise<T | undefined> => {
    fs.mkdirSync(disk, { recursive: true });
    try {
      subst(['X:', disk]);
    } catch {
      return undefined;
    }
    try {
      return await fn();
    } finally {
      try {
        subst(['/d', 'X:']);
      } catch {
        /* 没建上就算了 */
      }
    }
  };
  it.runIf(process.platform === 'win32')('⭐ 换盘符重放（X: → Y:）：旧盘符的锁残留不再阻断迁移', async () => {
    const disk = path.join(root, 'disk');
    fs.mkdirSync(disk, { recursive: true });
    try {
      subst(['X:', disk]);
    } catch {
      return; // 机器上 X: 已被占用 ⇒ 跳过（环境限制，不是失败）
    }
    try {
      const oldSource = 'X:\\state';
      write(path.join(oldSource, 'openclaw.json'), JSON.stringify({ gateway: { auth: { token } } }));
      // 旧盘符上留下的网关锁（写它的那次运行是在 X:\ 挂载时）：pid 还"活着"，
      // 但锁声明的 state 位置已经不是眼前这一份 state。
      write(
        path.join(oldSource, 'tmp', 'openclaw', 'gateway.state.lock'),
        JSON.stringify({ pid: process.pid, stateDir: oldSource }),
      );
      subst(['/d', 'X:']);
      subst(['Y:', disk]);
      const migrated = path.join(root, 'target', 'state');
      await preparePortableState({
        sourceDir: 'Y:\\state',
        stateDir: migrated,
        workspacePath: path.join(root, 'workspace'),
        token,
        acquireLease: readLease,
      });
      expect(fs.existsSync(migrated)).toBe(true);
      expect(fs.readdirSync('Y:\\state\\tmp\\openclaw')).toEqual([
        expect.stringMatching(/^gateway\.state\.lock\.stale-/u),
      ]);
    } finally {
      try {
        subst(['/d', 'Y:']);
      } catch {
        /* 没建上就算了 */
      }
    }
  });

  /**
   * BUG-059 附③：位置比对先做 realpath 归一 + **startTime 相符是所有隔离判据里最决定性的**。
   *
   * 现场形态：subst / junction 下**内核写 realpath、应用传别名** —— 纯词法比对会把
   * "同一份 state"判成"别处的残留"，把**活网关的锁**隔离掉（漏闸），而 startTime
   * 相符本可一眼确认"这就是我们的活网关"。判据顺序必须让决定性判据先说话。
   */
  it.runIf(process.platform === 'win32')(
    '⭐（BUG-059 附③）位置拼写不同（subst 别名）但 startTime 相符 ⇒ 绝不隔离：如实阻断、锁原样保留',
    async () => {
      await withSubstX(path.join(root, 'disk-alias'), async () => {
        const real = path.join(root, 'disk-alias', 'state');
        writeConfig(real);
        write(
          path.join(real, 'tmp', 'openclaw', 'gateway.state.lock'),
          JSON.stringify({ pid: process.pid, startTime: 1_700_000_000_000, stateDir: real }),
        );

        const error = (await migrate({
          sourceDir: 'X:\\state',
          lockOwner: { startTime: () => 1_700_000_000_000 },
        }).catch((reason: unknown) => reason)) as Error & { code?: string };

        expect(error.code).toBe(PORTABLE_STATE_MIGRATION_BLOCKED);
        expect(error.message).toMatch(/Previous gateway is still running/u);
        // 决定性判据（startTime 相符）最优先：锁**没有被隔离**（现场原样，名字都没改）。
        expect(fs.readdirSync(path.join(real, 'tmp', 'openclaw'))).toEqual(['gateway.state.lock']);
      });
    },
  );

  it.runIf(process.platform === 'win32')(
    '⭐（BUG-059 附③）位置比对走 realpath：别名与真路径是同一目录 ⇒ 不当成"别处残留"隔离',
    async () => {
      await withSubstX(path.join(root, 'disk-realpath'), async () => {
        const real = path.join(root, 'disk-realpath', 'state');
        writeConfig(real);
        // 无 startTime（无法按进程身份核验）——只有位置判据可看。
        write(
          path.join(real, 'tmp', 'openclaw', 'gateway.state.lock'),
          JSON.stringify({ pid: process.pid, stateDir: real }),
        );
        const clock = fixtureClock();

        const error = (await migrate({
          sourceDir: 'X:\\state',
          // 有界等待压到 0：只钉"位置判据认得出是同一份 state ⇒ 不隔离"。
          lockOwner: { waitMs: 0, sleep: clock.sleep, now: clock.now },
        }).catch((reason: unknown) => reason)) as Error & { code?: string };

        expect(error.code).toBe(PORTABLE_STATE_MIGRATION_BLOCKED);
        expect(fs.readdirSync(path.join(real, 'tmp', 'openclaw'))).toEqual(['gateway.state.lock']);
      });
    },
  );

  it('⭐（BUG-059 附②）隔离失败（锁被占用/介质只读）⇒ 阻断 + 可执行指引，不抛裸 EPERM、现场原样保留', async () => {
    const lock = path.join(source, 'tmp', 'openclaw', 'gateway.state.lock');
    write(lock, '\u0000'.repeat(493));
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    });

    const error = (await migrate().catch((reason: unknown) => reason)) as Error & { code?: string };

    expect(error.code).toBe(PORTABLE_STATE_MIGRATION_BLOCKED); // fail-closed：阻断
    expect(error.message).toMatch(/完全退出Partner-W/u); // 可执行指引
    expect(error.message).toContain('gateway.state.lock');
    expect(error.message).toContain('EPERM'); // 原始原因保留（排障）
    expect(fs.existsSync(lock)).toBe(true); // 现场保留：改名失败 ⇒ 文件原地未动
    expect(fs.existsSync(target)).toBe(false); // 没有继续迁移
  });

  it('quarantines an all-NUL corrupted lock (field-proven, BUG-035) instead of blocking startup', async () => {
    // 现场实锤：不安全拔盘让"JSON+padding 原位覆写"的锁半写完 → 493 字节全 NUL；
    // 旧行为=readJson 炸 → fail-closed → 盘在任何机器上永久卡死（用户侧表现为"卡 17%"）。
    // 新行为=不可解析的锁判定为陈旧残留 → 隔离为 .corrupt-*（保留现场）→ 继续迁移。
    const lock = path.join(source, 'tmp', 'openclaw', 'gateway.state.lock');
    write(lock, '\u0000'.repeat(493));
    await migrate();
    expect(fs.existsSync(target)).toBe(true);
    const remaining = fs.readdirSync(path.join(source, 'tmp', 'openclaw'));
    expect(remaining).toEqual([expect.stringMatching(/^gateway\.state\.lock\.corrupt-/u)]);
  });

  it('quarantines a corrupted lock on the rebase path when the state directory already exists', async () => {
    // 现场同构：盘上 state 目录已存在（existing 路径），坏锁位于其中。
    writeConfig(target);
    write(path.join(target, 'tmp', 'openclaw', 'gateway.fbd10263.lock'), '\u0000'.repeat(493));
    await migrate();
    expect(fs.existsSync(path.join(target, '.clawwork-portable-state.json'))).toBe(true);
    const remaining = fs.readdirSync(path.join(target, 'tmp', 'openclaw'));
    expect(remaining).toEqual([expect.stringMatching(/^gateway\.fbd10263\.lock\.corrupt-/u)]);
  });

  it('proceeds when a well-formed lock names a process that no longer exists', async () => {
    write(path.join(source, 'tmp', 'openclaw', 'gateway.state.lock'), JSON.stringify({ pid: 2147483646 }));
    await migrate();
    expect(fs.existsSync(target)).toBe(true);
  });

  it('does not create an empty replacement when the read lease cannot be acquired', async () => {
    await expect(
      migrate({
        acquireLease: async () => {
          throw new Error('busy');
        },
      }),
    ).rejects.toMatchObject({ code: PORTABLE_STATE_MIGRATION_BLOCKED });
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(source, 'openclaw.json'))).toBe(true);
  });

  it('rolls back only its stage after a mid-copy failure and permits a clean retry', async () => {
    write(path.join(source, 'state', 'history.sqlite'), 'keep-original');
    vi.spyOn(fs, 'copyFileSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await expect(migrate()).rejects.toThrow('disk full');
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(path.dirname(target))).toEqual([]);
    expect(fs.readFileSync(path.join(source, 'state', 'history.sqlite'), 'utf8')).toBe('keep-original');
    vi.restoreAllMocks();
    await migrate();
    expect(fs.readFileSync(path.join(target, 'state', 'history.sqlite'), 'utf8')).toBe('keep-original');
  });

  it('keeps migration blocked even if removing a failed stage also fails', async () => {
    vi.spyOn(fs, 'copyFileSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => {
      throw new Error('cleanup denied');
    });
    await expect(migrate()).rejects.toMatchObject({ code: PORTABLE_STATE_MIGRATION_BLOCKED });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('never overwrites existing target history with legacy source history', async () => {
    writeConfig(target);
    write(path.join(target, 'state', 'history.sqlite'), 'newest');
    write(path.join(source, 'state', 'history.sqlite'), 'obsolete');
    await migrate();
    expect(fs.readFileSync(path.join(target, 'state', 'history.sqlite'), 'utf8')).toBe('newest');
  });

  // 2026-10-19 现场盘：`openclaw plugins install` 装的插件会在
  // `<state>\extensions\<插件>\node_modules\openclaw` 建一条指向随包运行时的 junction。
  // 旧白名单不认这个形状 ⇒ 换盘符后整个迁移被判 blocked、网关不启动（准备页卡住）。
  it('accepts the host link an npm-installed plugin creates under extensions/', async () => {
    const pluginLink = path.join(source, 'extensions', 'feishu', 'node_modules', 'openclaw');
    fs.mkdirSync(path.dirname(pluginLink), { recursive: true });
    fs.symlinkSync(path.join(root, 'runtime', 'deployed', 'KEY', 'node_modules', 'openclaw'), pluginLink, 'junction');

    await migrate();

    expect(fs.existsSync(target)).toBe(true);
    expect(fs.lstatSync(path.join(target, 'extensions', 'feishu', 'node_modules', 'openclaw')).isSymbolicLink()).toBe(
      true,
    );
  });

  // 2026-10-19 用户实测「登不进去」：同一个 npm 项目里，**包自己**的 node_modules 下
  // 还有一条 peer 链（`node_modules/@openclaw/feishu/node_modules/openclaw`）。
  // 旧白名单只认项目顶层那条 ⇒ 迁移直接判 blocked，网关永远起不来（登录后停在准备页）。
  it('accepts the nested peer host link inside an npm-installed plugin package', async () => {
    const peer = path.join(
      source,
      'npm',
      'projects',
      'openclaw-feishu-dc69f44688',
      'node_modules',
      '@openclaw',
      'feishu',
      'node_modules',
      'openclaw',
    );
    fs.mkdirSync(path.dirname(peer), { recursive: true });
    fs.symlinkSync(path.join(root, 'runtime', 'deployed', 'KEY', 'node_modules', 'openclaw'), peer, 'junction');

    await migrate();

    expect(fs.existsSync(target)).toBe(true);
    expect(
      fs
        .lstatSync(
          path.join(
            target,
            'npm',
            'projects',
            'openclaw-feishu-dc69f44688',
            'node_modules',
            '@openclaw',
            'feishu',
            'node_modules',
            'openclaw',
          ),
        )
        .isSymbolicLink(),
    ).toBe(true);
  });

  // 负对照：嵌套层里**不是** openclaw 的链接照旧拒绝（白名单只放宽这一种形状）。
  it('still refuses a nested link that is not the openclaw host link', async () => {
    const stray = path.join(
      source,
      'npm',
      'projects',
      'p',
      'node_modules',
      '@openclaw',
      'feishu',
      'node_modules',
      'other',
    );
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.symlinkSync(path.join(root, 'elsewhere'), stray, 'junction');
    await expect(migrate()).rejects.toThrow('unsupported link');
  });

  it('still refuses a link that is not a known host link', async () => {
    const stray = path.join(source, 'extensions', 'feishu', 'node_modules', 'other');
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.symlinkSync(path.join(root, 'elsewhere'), stray, 'junction');
    await expect(migrate()).rejects.toThrow('unsupported link');
  });

  it('refuses another token identity and unsupported links without following them', async () => {
    await expect(migrate({ token: 'another-account' })).rejects.toThrow('does not match');
    const external = path.join(root, 'external');
    fs.mkdirSync(external);
    fs.symlinkSync(external, path.join(source, 'credentials'), 'junction');
    await expect(migrate()).rejects.toThrow('unsupported link');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('rebases known config paths for a drive move while preserving prose, credentials and unrelated paths', () => {
    const previous = { stateDir: 'E:\\app-data\\state\\identity', workspacePath: 'E:\\workspace' };
    const next = { stateDir: 'F:\\app-data\\state\\identity', workspacePath: 'F:\\workspace' };
    const result = rebasePortableConfig(
      {
        agents: {
          entries: {
            main: { workspace: 'E:\\workspace' },
            analyst: {
              workspace: 'E:\\workspace\\agents\\analyst',
              agentDir: 'E:\\app-data\\state\\identity\\agents\\analyst\\agent',
            },
            external: { workspace: 'E:\\workspace-other' },
          },
        },
        skills: { load: { extraDirs: ['E:\\app-data\\state\\identity\\skills'] } },
        prompt: 'E:\\workspace',
        apiKey: 'E:\\workspace',
      },
      previous,
      next,
    );
    expect(result).toMatchObject({
      agents: {
        entries: {
          main: { workspace: 'F:\\workspace' },
          analyst: {
            workspace: 'F:\\workspace\\agents\\analyst',
            agentDir: 'F:\\app-data\\state\\identity\\agents\\analyst\\agent',
          },
          external: { workspace: 'E:\\workspace-other' },
        },
      },
      skills: { load: { extraDirs: ['F:\\app-data\\state\\identity\\skills'] } },
      prompt: 'E:\\workspace',
      apiKey: 'E:\\workspace',
    });
  });

  it('does not remap other agents when the user chooses a different workspace folder', () => {
    expect(
      rebasePortableConfig(
        { agents: { entries: { analyst: { workspace: 'E:\\old-project\\analyst' } } } },
        { stateDir: 'E:\\data\\state\\identity', workspacePath: 'E:\\old-project' },
        { stateDir: 'E:\\data\\state\\identity', workspacePath: 'E:\\new-project' },
      ),
    ).toEqual({ agents: { entries: { analyst: { workspace: 'E:\\old-project\\analyst' } } } });
  });

  it.runIf(process.platform === 'win32')(
    'native read lease blocks a writer until the snapshot is released',
    async () => {
      const file = path.join(source, '\u4e2d\u6587\u76ee\u5f55', 'history.sqlite');
      const wal = `${file}-wal`;
      write(file, 'database');
      write(wal, 'wal');
      const lease = await acquireStateReadLease([file, wal]);
      try {
        lease.assertHeld();
        expect(() => fs.openSync(file, 'r+')).toThrow();
        expect(() => fs.openSync(wal, 'r+')).toThrow();
      } finally {
        await lease.release();
      }
      const writer = fs.openSync(wal, 'r+');
      try {
        await expect(acquireStateReadLease([file, wal])).rejects.toThrow('State is busy');
      } finally {
        fs.closeSync(writer);
      }
    },
  );
});
