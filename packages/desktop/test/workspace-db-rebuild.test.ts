/**
 * 「重建工作区」在**真 sqlite** 上到底修不修得好（T-U1 的高危路径）。
 *
 * 为什么不接着用 `workspace-startup-flow.test.ts` 那个假库：
 *   那份替身的 `init` 只是"库文件还在就 throw"，**从来不真开句柄** ——
 *   正好绕过这条路上唯一会挡路的东西。真机上断的恰恰是句柄：
 *   库文件损坏时 `new Database()` 是成功的，炸在第一条 `pragma`（SQLITE_NOTADB），
 *   句柄就此留在进程里；「重建工作区」紧接着要 `rename` 这个坏文件，
 *   而 Windows 上 sqlite 打开文件用的共享模式**不含** FILE_SHARE_DELETE ⇒ 必 EBUSY。
 *   改名失败 ⇒ 下一轮 init 还是同一个坏文件 ⇒ 转满 5 轮退出 —— "可恢复"是假的。
 *
 * ⚠️ 驱动换成 `node:sqlite`（`helpers/node-sqlite-shim.ts`）：本仓库的 better-sqlite3
 *    是按 **Electron ABI** 编译的，vitest 跑在纯 node 里加载不了（ERR_DLOPEN_FAILED）。
 *    shim 是真 SQLite、真文件、真句柄，这里要验的三件事（句柄有没有放掉、坏文件能不能
 *    改名、新库能不能用）全都在它身上成立 —— 实测 `pragma journal_mode = WAL` 对
 *    "非数据库文件"同样抛错、同样留下句柄、同样让 rename EBUSY。
 */

import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_FILE_NAME } from '@clawwork/shared';

const electronMock = vi.hoisted(() => {
  const state = { userData: '' };
  return {
    state,
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return state.userData;
      throw new Error(`unexpected app path: ${name}`);
    }),
  };
});

vi.mock('electron', () => ({
  app: { getPath: electronMock.getPath },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}));

// 真 SQLite（node:sqlite），接口与 better-sqlite3 相同 —— 见文件头说明。
vi.mock('better-sqlite3', async () => ({
  default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim,
}));

import { closeDatabase, getSqlite, initDatabase, isDbReady } from '../src/main/db/index.js';
import { setPortableWorkspaceRoot, writeConfig } from '../src/main/workspace/config.js';
import { prepareWorkspaceAtStartup, type WorkspaceDatabasePort } from '../src/main/workspace/startup.js';

/** 一段**不是**数据库的普通文本：真 sqlite 读到它会 `file is not a database`。 */
const CORRUPT_CONTENT = '这不是数据库，只是一段普通文本。\n'.repeat(64);

let userDataDir = '';
let realRoot = '';

/** 真端口（要真句柄、真改名，就得用真模块）。 */
const realPort: WorkspaceDatabasePort = { init: initDatabase, close: closeDatabase };

function corruptWorkspace(): string {
  const dir = mkdtempSync(join(realRoot, 'ws-corrupt-'));
  writeFileSync(join(dir, DB_FILE_NAME), CORRUPT_CONTENT);
  return dir;
}

function quarantinedFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes('.corrupt-'));
}

interface Harness {
  dialogs: {
    askForMissingWorkspace: ReturnType<typeof vi.fn>;
    browseForDirectory: ReturnType<typeof vi.fn>;
    askForUnusableWorkspace: ReturnType<typeof vi.fn>;
    notifyFatal: ReturnType<typeof vi.fn>;
  };
  quit: ReturnType<typeof vi.fn>;
  events: Array<{ event: string; data?: Record<string, unknown> }>;
  run(
    overrides?: Partial<Parameters<typeof prepareWorkspaceAtStartup>[0]>,
  ): ReturnType<typeof prepareWorkspaceAtStartup>;
}

function makeHarness(): Harness {
  const events: Harness['events'] = [];
  const dialogs: Harness['dialogs'] = {
    askForMissingWorkspace: vi.fn(async () => ({ kind: 'quit' }) as const),
    browseForDirectory: vi.fn(async () => null),
    askForUnusableWorkspace: vi.fn(async () => 'quit' as const),
    notifyFatal: vi.fn(async () => {}),
  };
  const quit = vi.fn(() => {});

  return {
    dialogs,
    quit,
    events,
    run: (overrides = {}) =>
      prepareWorkspaceAtStartup({
        exePath: join('C:', '荣盈魔方便携版', '荣盈魔方.exe'),
        dialogs,
        database: realPort,
        removableDrives: [],
        quit,
        onEvent: (event, data) => events.push({ event, data }),
        ...overrides,
      }),
  };
}

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'clawwork-rebuild-'));
  realRoot = mkdtempSync(join(tmpdir(), 'clawwork-rebuild-ws-'));
  electronMock.state.userData = userDataDir;
  setPortableWorkspaceRoot(null);
  closeDatabase();
});

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(realRoot, { recursive: true, force: true });
});

describe('真 sqlite：打不开时不许把句柄留在外面', () => {
  it('⭐ init 失败后，那个坏文件必须马上能被改名（rename 不 EBUSY）', () => {
    const ws = corruptWorkspace();
    const dbPath = join(ws, DB_FILE_NAME);

    expect(() => initDatabase(ws)).toThrow(/not a database/i);
    expect(isDbReady()).toBe(false);
    expect(getSqlite()).toBeNull();

    // ← 这一行就是「重建工作区」现场：还开着句柄时它在 Windows 上必 EBUSY。
    expect(() => renameSync(dbPath, `${dbPath}.corrupt-manual`)).not.toThrow();
    expect(existsSync(`${dbPath}.corrupt-manual`)).toBe(true);
  });

  it('失败不留"半个"状态：同一个位置可以再 init 一次', () => {
    const ws = corruptWorkspace();

    expect(() => initDatabase(ws)).toThrow();
    // 坏文件挪走 ⇒ 同一个位置重新 init 应该建出一份能用的新库
    renameSync(join(ws, DB_FILE_NAME), join(ws, `${DB_FILE_NAME}.corrupt-manual`));

    expect(() => initDatabase(ws)).not.toThrow();
    expect(isDbReady()).toBe(true);
    expect(getSqlite()?.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toBeTruthy();
  });
});

describe('真 sqlite：「重建工作区」端到端', () => {
  it('⭐ 真坏库 ⇒ 用户点「重建工作区」⇒ 新库真的能用，坏文件改名保留', async () => {
    const ws = corruptWorkspace();
    writeConfig({ workspacePath: ws, gateways: [] });
    const h = makeHarness();
    h.dialogs.askForUnusableWorkspace.mockResolvedValue('rebuild');

    const result = await h.run();

    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('unreachable');
    expect(result.path).toBe(ws);
    expect(h.quit).not.toHaveBeenCalled(); // 失败路径**没有**退出

    // 新库真的能用（不是"没抛错"就算过）：库是开着的，而且能查
    expect(isDbReady()).toBe(true);
    const row = getSqlite()?.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number } | undefined;
    expect(row?.n).toBe(0);

    // 坏文件被改名保留（对话框承诺过"不会删除你的文件"），新库文件在该在的地方
    expect(quarantinedFiles(ws)).toHaveLength(1);
    expect(existsSync(join(ws, DB_FILE_NAME))).toBe(true);
    expect(h.events.map((e) => e.event)).toContain('workspace.db.rebuild');
  });

  it('真实路径也修不好（工作区指向一个文件）⇒ 有上限、说清后果，绝不抛异常空转', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 连 mkdir 都做不成的坏位置：工作区路径本身是个**文件**。
    const notADir = join(realRoot, 'this-is-a-file');
    writeFileSync(notADir, 'x');
    writeConfig({ workspacePath: notADir, gateways: [] });
    const h = makeHarness();
    h.dialogs.askForUnusableWorkspace.mockResolvedValue('rebuild');

    const result = await h.run();

    expect(result.kind).toBe('quit');
    expect(h.dialogs.askForUnusableWorkspace.mock.calls.length).toBeLessThanOrEqual(5);
    expect(h.dialogs.notifyFatal).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled(); // 标记写不进去只是"少一条线索"，不该把设置工作区弄失败
  });
});
