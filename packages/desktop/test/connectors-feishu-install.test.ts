import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installFeishuFromOfficialPackage,
  readFeishuInstallRecord,
  type FeishuInstallRecord,
} from '../src/main/connectors/feishu-install.js';

/**
 * 飞书可信安装记录（BUG-171）。
 *
 * 这里钉两件事：
 *  ① 判断"可信"必须看 `installRecords.feishu`（source=npm + installPath 存在），
 *    不能看插件目录在不在；
 *  ② 缺失时用随包 npm 跑官方安装（命令、环境变量、state 目录必须精确）。
 */

function openNodeSqlite(path: string) {
  const db = new DatabaseSync(path);
  return {
    prepare: (sql: string) => db.prepare(sql) as unknown as { get(...params: unknown[]): unknown },
    close: () => db.close(),
  };
}

function seedIndex(stateDir: string, record: Record<string, unknown> | null): void {
  mkdirSync(join(stateDir, 'state'), { recursive: true });
  const db = new DatabaseSync(join(stateDir, 'state', 'openclaw.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT)');
  db.prepare("INSERT OR REPLACE INTO config_machine_state (state_key, value_json) VALUES (?, ?)").run(
    'plugins.installedIndex',
    JSON.stringify({ revision: 1, index: { version: 1, installRecords: record ? { feishu: record } : {} } }),
  );
  db.close();
}

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clawwork-feishu-install-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('readFeishuInstallRecord', () => {
  it('⭐ 有 npm 记录且 installPath 在本 state 下 ⇒ 可信', () => {
    const stateDir = join(root, 'state-root');
    const installPath = join(stateDir, 'extensions', 'feishu');
    mkdirSync(installPath, { recursive: true });
    seedIndex(stateDir, { source: 'npm', installPath, resolvedSpec: '@openclaw/feishu@2026.9.3' });
    const record = readFeishuInstallRecord(stateDir, { openDatabase: openNodeSqlite });
    expect(record?.source).toBe('npm');
    expect(record?.installPath).toBe(installPath);
  });

  it('installPath 已不存在（换盘/换目录）⇒ 不可信', () => {
    const stateDir = join(root, 'state-root');
    seedIndex(stateDir, { source: 'npm', installPath: join(root, 'gone') });
    expect(readFeishuInstallRecord(stateDir, { openDatabase: openNodeSqlite })).toBeNull();
  });

  // 2026-10-19 自审：旧盘符被另一台装了同款产品的电脑占用时，记录里的
  // `E:\…\extensions\feishu` 会"恰好存在" —— 只查 existsSync 会把**别人盘上的插件**
  // 判成本机的可信记录，于是不修、继续收不到消息。可信必须同时"在本 state 之下"。
  it('⭐ installPath 存在但不在本 state 下（旧盘符撞上另一块盘）⇒ 不可信', () => {
    const stateDir = join(root, 'state-root');
    const foreign = join(root, 'other-machine', 'state', 'extensions', 'feishu');
    mkdirSync(foreign, { recursive: true });
    seedIndex(stateDir, { source: 'npm', installPath: foreign });
    expect(readFeishuInstallRecord(stateDir, { openDatabase: openNodeSqlite })).toBeNull();
  });


  it('没有记录 / 库不存在 ⇒ null（不猜）', () => {
    const stateDir = join(root, 'state-root');
    seedIndex(stateDir, null);
    expect(readFeishuInstallRecord(stateDir, { openDatabase: openNodeSqlite })).toBeNull();
    expect(readFeishuInstallRecord(join(root, 'nope'), { openDatabase: openNodeSqlite })).toBeNull();
  });
});

describe('installFeishuFromOfficialPackage', () => {
  function makeNodeDir(): string {
    const nodeDir = join(root, 'node');
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(join(nodeDir, 'npm.cmd'), '@ECHO off\r\n');
    writeFileSync(join(nodeDir, 'node.exe'), '');
    return nodeDir;
  }

  it('已有可信记录 ⇒ 不启动安装', async () => {
    const nodeDir = makeNodeDir();
    const spawnProcess = vi.fn();
    const record: FeishuInstallRecord = { source: 'npm', installPath: join(root, 'plugin') };
    const result = await installFeishuFromOfficialPackage({
      stateDir: root,
      nodePath: join(nodeDir, 'node.exe'),
      cliPath: join(root, 'openclaw.mjs'),
      pluginVersion: '2026.9.3',
      spawnProcess: spawnProcess as never,
      readRecord: () => record,
    });
    expect(result).toEqual({ ok: true, installed: false, record });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('没有记录 ⇒ 用随包 npm + 离线缓存跑官方安装（args/env 精确）', async () => {
    const nodeDir = makeNodeDir();
    const record: FeishuInstallRecord = { source: 'npm', installPath: join(root, 'plugin') };
    let finished = false;
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const spawnProcess = vi.fn(() => {
      process.nextTick(() => {
        finished = true;
        child.emit('close', 0);
      });
      return child;
    });

    const result = await installFeishuFromOfficialPackage({
      stateDir: join(root, 'state-root'),
      nodePath: join(nodeDir, 'node.exe'),
      cliPath: join(root, 'openclaw.mjs'),
      pluginVersion: '2026.9.3',
      spawnProcess: spawnProcess as never,
      // 第一次读没有记录，安装完成后读到记录（模拟 CLI 写入）
      readRecord: () => (finished ? record : null),
    });

    expect(result).toMatchObject({ ok: true, installed: true });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    const [exe, args, options] = spawnProcess.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(exe).toBe(join(nodeDir, 'node.exe'));
    expect(args).toEqual([
      join(root, 'openclaw.mjs'),
      'plugins',
      'install',
      '@openclaw/feishu@2026.9.3',
      '--accept-capabilities',
      '--acknowledge-install-policy-warning',
    ]);
    expect(options.env['OPENCLAW_STATE_DIR']).toBe(join(root, 'state-root'));
    expect(options.env['NPM_CONFIG_CACHE']).toBe(join(nodeDir, 'npm-cache'));
    // ⭐ 2026-10-19 现场：离线缓存是按 **npmmirror** 的 registry key 存的
    //（`registry.npmmirror.com/@openclaw%2ffeishu` + cdn.npmmirror.com 的 tarball）。
    // 不显式指定 registry，npm 会去查 registry.npmjs.org 的 key ⇒ 离线必 ENOTCACHED
    // ⇒ 装机失败 ⇒ 没有可信记录 ⇒ 飞书工具/收消息全部不可用。
    expect(options.env['NPM_CONFIG_REGISTRY']).toBe('https://registry.npmmirror.com');
  });

  /**
   * ⭐ 2026-10-19 现场（U 盘 E:，飞书一直"插件缺少可信安装记录"）：
   * 内核 CLI 在 `OPENCLAW_SUPERVISOR_MODE=external` 下**拒绝执行**需要停止/重启网关的
   * 命令（`assertGatewayServiceMutationAllowed` → "managed by an external supervisor …
   * Use that supervisor to stop the gateway"）。安装因此每次 exit 1，我们退回目录复制，
   * 永远生不成可信安装记录。网关的 external 标记只属于**网关子进程**，装机 CLI 不该继承。
   */
  it('⭐ 安装子进程不许继承 OPENCLAW_SUPERVISOR_MODE（否则内核拒绝安装）', async () => {
    const nodeDir = makeNodeDir();
    const record: FeishuInstallRecord = { source: 'npm', installPath: join(root, 'plugin') };
    let finished = false;
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const spawnProcess = vi.fn(() => {
      process.nextTick(() => {
        finished = true;
        child.emit('close', 0);
      });
      return child;
    });

    const previous = process.env['OPENCLAW_SUPERVISOR_MODE'];
    process.env['OPENCLAW_SUPERVISOR_MODE'] = 'external';
    try {
      await installFeishuFromOfficialPackage({
        stateDir: join(root, 'state-root'),
        nodePath: join(nodeDir, 'node.exe'),
        cliPath: join(root, 'openclaw.mjs'),
        pluginVersion: '2026.9.3',
        spawnProcess: spawnProcess as never,
        readRecord: () => (finished ? record : null),
        // 大小写两种都试：Windows 环境变量键不区分大小写。
        env: { openclaw_supervisor_mode: 'external' },
      });
    } finally {
      if (previous === undefined) delete process.env['OPENCLAW_SUPERVISOR_MODE'];
      else process.env['OPENCLAW_SUPERVISOR_MODE'] = previous;
    }

    const [, , options] = spawnProcess.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    const supervisorKeys = Object.keys(options.env).filter((key) => key.toUpperCase() === 'OPENCLAW_SUPERVISOR_MODE');
    expect(supervisorKeys).toEqual([]);
  });

  /**
   * ⭐ 2026-10-19 现场（r52，E:）：装机真的开始下载/安装后，CLI 报
   * `Could not start the CLI. Reason: config changed since last load`。
   * 这是**时序竞态**：安装窗口里应用自身的配置写入（relay 初始化/能力边界/网关重启）
   * 改了 openclaw.json ⇒ 装机 CLI 拒绝继续。表现就是"我这台能过、别人那台全挂"。
   * 处理：识别这个瞬时失败并重试（1.5s / 3s），不做静默降级。
   */
  it('⭐ 安装撞上并发配置写入（config changed since last load）⇒ 自动重试并成功', async () => {
    const nodeDir = makeNodeDir();
    const record: FeishuInstallRecord = { source: 'npm', installPath: join(root, 'plugin') };
    let calls = 0;
    const spawnProcess = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      calls += 1;
      process.nextTick(() => {
        if (calls === 1) {
          child.stderr.emit('data', Buffer.from('[openclaw] Reason: config changed since last load'));
          child.emit('close', 1);
        } else {
          child.emit('close', 0);
        }
      });
      return child;
    });

    const result = await installFeishuFromOfficialPackage({
      stateDir: join(root, 'state-root'),
      nodePath: join(nodeDir, 'node.exe'),
      cliPath: join(root, 'openclaw.mjs'),
      pluginVersion: '2026.9.3',
      spawnProcess: spawnProcess as never,
      readRecord: () => (calls >= 2 ? record : null),
    });

    expect(result).toMatchObject({ ok: true, installed: true });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it('没有 npm.cmd（旧运行时）⇒ npm-missing，不启动', async () => {
    const nodeDir = join(root, 'node');
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(join(nodeDir, 'node.exe'), '');
    const spawnProcess = vi.fn();
    const result = await installFeishuFromOfficialPackage({
      stateDir: root,
      nodePath: join(nodeDir, 'node.exe'),
      cliPath: join(root, 'openclaw.mjs'),
      pluginVersion: '2026.9.3',
      spawnProcess: spawnProcess as never,
      readRecord: () => null,
    });
    expect(result).toMatchObject({ ok: false, reason: 'npm-missing' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  // 2026-10-19 自审：读不到随包插件版本时不许静默回落 `2026.9.3` —— 那会把一份
  // 未知版本装进用户盘，且结果看起来"成功"。缺版本 = 包坏了，必须硬失败。
  it('读不到随包插件版本 ⇒ version-missing，不启动 npm', async () => {
    const nodeDir = makeNodeDir();
    const spawnProcess = vi.fn();
    const result = await installFeishuFromOfficialPackage({
      stateDir: root,
      nodePath: join(nodeDir, 'node.exe'),
      cliPath: join(root, 'openclaw.mjs'),
      pluginVersion: '   ',
      spawnProcess: spawnProcess as never,
      readRecord: () => null,
    });
    expect(result).toMatchObject({ ok: false, reason: 'version-missing' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('安装命令失败 ⇒ install-failed（带尾部输出）', async () => {
    const nodeDir = makeNodeDir();
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const spawnProcess = vi.fn(() => {
      process.nextTick(() => {
        child.stderr.emit('data', Buffer.from('npm ERR! offline cache miss'));
        child.emit('close', 1);
      });
      return child;
    });
    const result = await installFeishuFromOfficialPackage({
      stateDir: root,
      nodePath: join(nodeDir, 'node.exe'),
      cliPath: join(root, 'openclaw.mjs'),
      pluginVersion: '2026.9.3',
      spawnProcess: spawnProcess as never,
      readRecord: () => null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('install-failed');
      expect(result.detail).toContain('offline cache miss');
    }
  });
});
