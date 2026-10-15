import { win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideWorkspaceStartup, type WorkspaceStartupDecision } from '../src/main/workspace/portable.js';

const handleMap = new Map<string, (...args: unknown[]) => unknown>();

const isWorkspaceConfiguredMock = vi.fn(() => false);
const getWorkspacePathMock = vi.fn<() => string | null>(() => '/tmp/old-workspace');
const writeConfigMock = vi.fn();
const updateConfigMock = vi.fn();
const getDefaultWorkspacePathMock = vi.fn(() => '/tmp/default-workspace');
const getPortableWorkspaceRootMock = vi.fn<() => string | null>(() => null);

const initWorkspaceMock = vi.fn();
const migrateWorkspaceMock = vi.fn();

const initDatabaseMock = vi.fn();
const reinitDatabaseMock = vi.fn();
const closeDatabaseMock = vi.fn();

/**
 * 可移动盘列表的**替身**（进程内记忆一次的语义与真模块一致）。
 * ⚠️ 真实现走 PowerShell 枚举（秒级）；入口测试不该为了它真开进程。
 */
const removableDrivesState = { current: [] as readonly string[] };

vi.mock('../src/main/workspace/removable-drives.js', () => ({
  removableDrives: () => removableDrivesState.current,
  setRemovableDrives: (drives: readonly string[]) => {
    removableDrivesState.current = [...drives];
  },
  refreshRemovableDrives: () => removableDrivesState.current,
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  dialog: {
    showOpenDialog: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handleMap.set(channel, handler);
    }),
  },
}));

vi.mock('../src/main/workspace/config.js', () => ({
  getWorkspacePath: getWorkspacePathMock,
  writeConfig: writeConfigMock,
  updateConfig: updateConfigMock,
  isWorkspaceConfigured: isWorkspaceConfiguredMock,
  getDefaultWorkspacePath: getDefaultWorkspacePathMock,
  // 补记盘符自愈线索时也要看"程序自己运行的那块盘"（本机安装形态 = null）。
  // ⚠️ 与上面 `getSqlite` 同一条纪律：mock 少一个被用到的导出，vitest 报的是
  //    `No "…" export is defined on the mock`，指向 mock 而不是被测代码。
  getPortableWorkspaceRoot: getPortableWorkspaceRootMock,
  // `workspace:setup` 收尾会 ensureDeviceId()（写入前在 writeConfig 之后调用）。
  ensureDeviceId: vi.fn(() => 'test-device-id'),
}));

vi.mock('../src/main/workspace/init.js', () => ({
  initWorkspace: initWorkspaceMock,
  migrateWorkspace: migrateWorkspaceMock,
  // P-A v2（2026-10-15）：locationPatch 会补铸/读工作区身份。替身返回 null（"读不到"）
  // ⇒ 判定保持老行为；少这个导出会让 handler 直接抛 "is not a function" 落到 {ok:false}。
  ensureWorkspaceId: vi.fn(() => null),
}));

vi.mock('../src/main/db/index.js', () => ({
  initDatabase: initDatabaseMock,
  reinitDatabase: reinitDatabaseMock,
  closeDatabase: closeDatabaseMock,
  // `workspace-handlers` 换库后会重建资料库运行时，而它要拿 sqlite。
  // ⚠️ mock 必须与真实模块的**被用到的那部分**对齐：少一个导出，
  //    vitest 直接抛 `No "getSqlite" export is defined on the mock`，
  //    报错指向的是 mock 而不是被测代码。返回 null ⇒ 运行时重建那条路静默跳过，
  //    本文件关心的"换库顺序"不受影响。
  getSqlite: () => null,
}));

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('registerWorkspaceHandlers', () => {
  beforeEach(() => {
    handleMap.clear();
    vi.clearAllMocks();
    getWorkspacePathMock.mockReturnValue('/tmp/old-workspace');
    isWorkspaceConfiguredMock.mockReturnValue(false);
    getDefaultWorkspacePathMock.mockReturnValue('/tmp/default-workspace');
    getPortableWorkspaceRootMock.mockReturnValue(null);
    removableDrivesState.current = [];
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('waits for workspace migration before reopening the database', async () => {
    const deferred = createDeferred();
    migrateWorkspaceMock.mockReturnValue(deferred.promise);

    const { registerWorkspaceHandlers } = await import('../src/main/ipc/workspace-handlers.js');

    registerWorkspaceHandlers();

    const handler = handleMap.get('workspace:change');
    expect(handler).toBeTypeOf('function');

    const pending = handler?.({}, '/tmp/new-workspace') as Promise<{ ok: boolean; error?: string }>;

    await Promise.resolve();

    expect(closeDatabaseMock).toHaveBeenCalledTimes(1);
    expect(migrateWorkspaceMock).toHaveBeenCalledWith('/tmp/old-workspace', '/tmp/new-workspace');
    expect(reinitDatabaseMock).not.toHaveBeenCalled();
    expect(updateConfigMock).not.toHaveBeenCalled();

    deferred.resolve();

    await expect(pending).resolves.toEqual({ ok: true });
    expect(closeDatabaseMock).toHaveBeenCalledTimes(1);
    expect(reinitDatabaseMock).toHaveBeenCalledWith('/tmp/new-workspace');
    expect(updateConfigMock).toHaveBeenCalledWith({ workspacePath: '/tmp/new-workspace' });
  });

  it('⭐ 运行中换工作区先同步 runtime main.workspace，再提交客户端配置', async () => {
    const order: string[] = [];
    migrateWorkspaceMock.mockImplementation(async () => {
      order.push('migrate');
    });
    const syncRuntimeWorkspace = vi.fn(async () => {
      order.push('runtime');
    });
    updateConfigMock.mockImplementation(() => {
      order.push('config');
    });

    const { registerWorkspaceHandlers } = await import('../src/main/ipc/workspace-handlers.js');
    registerWorkspaceHandlers({ syncRuntimeWorkspace });
    const handler = handleMap.get('workspace:change');

    await expect(handler?.({}, '/tmp/new-workspace')).resolves.toEqual({ ok: true });
    expect(syncRuntimeWorkspace).toHaveBeenCalledWith('/tmp/new-workspace');
    expect(order).toEqual(['migrate', 'runtime', 'config']);
  });

  it('⭐ runtime main.workspace 同步失败 ⇒ 不报成功、不改客户端配置，并恢复旧数据库', async () => {
    const syncRuntimeWorkspace = vi.fn(async () => {
      throw new Error('runtime config busy');
    });

    const { registerWorkspaceHandlers } = await import('../src/main/ipc/workspace-handlers.js');
    registerWorkspaceHandlers({ syncRuntimeWorkspace });
    const handler = handleMap.get('workspace:change');

    await expect(handler?.({}, '/tmp/new-workspace')).resolves.toEqual({
      ok: false,
      error: 'runtime config busy',
    });
    expect(updateConfigMock).not.toHaveBeenCalled();
    expect(reinitDatabaseMock).toHaveBeenLastCalledWith('/tmp/old-workspace');
  });

  it('returns error without closing database when migration fails', async () => {
    migrateWorkspaceMock.mockRejectedValue(new Error('copy failed'));

    const { registerWorkspaceHandlers } = await import('../src/main/ipc/workspace-handlers.js');

    registerWorkspaceHandlers();

    const handler = handleMap.get('workspace:change');
    expect(handler).toBeTypeOf('function');

    await expect(handler?.({}, '/tmp/new-workspace')).resolves.toEqual({
      ok: false,
      error: 'copy failed',
    });

    expect(closeDatabaseMock).toHaveBeenCalledTimes(1);
    expect(reinitDatabaseMock).toHaveBeenCalledWith('/tmp/old-workspace');
  });

  it('joins workspace and slug using path.join so the host separator is used', async () => {
    const { registerWorkspaceHandlers } = await import('../src/main/ipc/workspace-handlers.js');
    registerWorkspaceHandlers();

    const handler = handleMap.get('workspace:team-path');
    expect(handler).toBeTypeOf('function');

    getWorkspacePathMock.mockReturnValue('/tmp/claw-workspace');
    const result = (await handler?.({}, 'test-team')) as string;
    const expected = (await import('path')).join('/tmp/claw-workspace', 'test-team');

    expect(result).toBe(expected);
    expect(result.endsWith(`${(await import('path')).sep}test-team`)).toBe(true);
    expect(result.includes('//test-team')).toBe(false);
  });

  /**
   * ⚠️ 2026-09-20 U 盘交付实机**改掉的旧行为**：以前这里 `return slug`（把 slug 本身
   *    当路径发出去）。调用方拿到的是相对路径，交给网关进程按它自己的 home 解释
   *    ⇒ 每个助手都建失败，界面只剩 `No agents were created successfully`。
   *    现在**拒绝**：拿不到工作区就不许伪造一条路径。
   */
  it('⭐ 没有工作区时拒绝，不再把 slug 当路径发出去', async () => {
    getWorkspacePathMock.mockReturnValue(null);
    const { registerWorkspaceHandlers } = await import('../src/main/ipc/workspace-handlers.js');
    registerWorkspaceHandlers();

    const handler = handleMap.get('workspace:team-path');
    expect(handler).toBeTypeOf('function');

    expect(() => handler?.({}, 'lonely-team')).toThrow('workspace not configured');
  });

  it('rejects invalid team workspace slugs', async () => {
    const { registerWorkspaceHandlers } = await import('../src/main/ipc/workspace-handlers.js');
    registerWorkspaceHandlers();

    const handler = handleMap.get('workspace:team-path');
    expect(handler).toBeTypeOf('function');

    for (const slug of ['', '../invalid', 'invalid/path', String.raw`invalid\path`, 'bad..slug', 123]) {
      expect(() => handler?.({}, slug)).toThrow('Invalid team slug');
    }
  });
});

/**
 * 便携首次启动硬合同（2026-10-15）P-A —— **真实入口**：setup/change 的归属保存。
 *
 * 事故链（合同 §3 P-A / 核查单 §2）：`workspace:setup` / `workspace:change` 对**同盘
 * （当前运行卷）手选目录**也写 `explicit-path`（workspace-handlers.ts:70 旧行为）⇒
 * 换机器/换盘符后旧绝对路径失效 ⇒ `decideWorkspaceStartup` 直接 ask-user —— 即使唯一
 * 候选就在当前盘上、带着我们自己的工作区标记。
 *
 * 期望语义：用户选的是**当前卷上、身份可确认**的目录 ⇒ 按**可重定位绑定**（app-volume
 * 同族）保存，换盘符后同盘自愈，不再问人；真外部目录（别的卷 / 本机安装形态）仍
 * explicit-path，恢复时仍按 R1 询问（控制项）。
 *
 * ⚠️ 终态判据用**真实 `decideWorkspaceStartup`**（不是断言内部字段就完）：把 handler
 *    实际写出的配置原样喂给判定函数，模拟"同一支盘换了个盘符的下一次启动"。
 */
describe('P-A：同盘工作区的保存归属（换盘符硬合同）', () => {
  const WS = '我的工作区';
  const on = (drive: string): string => win32.join(drive, WS);

  beforeEach(() => {
    handleMap.clear();
    vi.clearAllMocks();
    getWorkspacePathMock.mockReturnValue('/tmp/old-workspace');
    getPortableWorkspaceRootMock.mockReturnValue(null);
    removableDrivesState.current = [];
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /** 虚拟文件系统（win32 路径、大小写不敏感），只给判定函数用。 */
  function vfs(...items: string[]): (p: string) => boolean {
    const set = new Set(items.map((p) => win32.normalize(p).toLowerCase()));
    return (p) => set.has(win32.normalize(p).toLowerCase());
  }

  /** 把 handler 写出的配置 + "换盘符后的运行环境"组合成一次真实启动判定。 */
  function decisionAfterLetterChange(
    written: Record<string, unknown>,
    runVolume: string,
    runVolumeFiles: string[],
  ): WorkspaceStartupDecision {
    return decideWorkspaceStartup({
      recordedPath: written.workspacePath as string,
      recordedRelPath: (written.workspaceRelPath as string | undefined) ?? null,
      volumeMarker: (written.volumeMarker as string | undefined) ?? null,
      workspaceBinding: (written.workspaceBinding as 'app-volume' | 'explicit-path' | undefined) ?? null,
      portableRoot: runVolume,
      defaultPath: win32.join('C:\\', 'Users', 'u', 'ClawWork-Workspace'),
      removableDrives: [],
      exists: vfs(...runVolumeFiles),
    });
  }

  it('⭐ A1：`workspace:setup` 选**当前运行卷**上的目录 ⇒ 随盘语义保存；换盘符后 healed、不问人', async () => {
    getPortableWorkspaceRootMock.mockReturnValue('E:\\');
    removableDrivesState.current = ['E:'];

    const { registerWorkspaceHandlers } = await import('../src/main/ipc/workspace-handlers.js');
    registerWorkspaceHandlers();
    const handler = handleMap.get('workspace:setup');
    expect(handler).toBeTypeOf('function');

    await expect(handler?.({}, on('E:\\'))).resolves.toEqual({ ok: true });

    const written = writeConfigMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(written.workspacePath).toBe(on('E:\\'));
    expect(written.workspaceRelPath).toBe(WS);

    // 终态：同一支盘换了个盘符（E: → F:）——目录还在、身份（工作区标记）还在，
    // 判定必须自己找回它。现状：binding=explicit-path ⇒ ask-user = 事故复现。
    const decision = decisionAfterLetterChange(written, 'F:\\', [
      on('F:\\'),
      win32.join(on('F:\\'), '.clawwork-workspace.json'),
      win32.join('F:\\', 'openclaw-runtime-manifest.json'),
    ]);
    expect(decision.kind, '同盘手选目录换盘符后不该再问人').toBe('healed');
    if (decision.kind !== 'healed') throw new Error('unreachable');
    expect(decision.path).toBe(on('F:\\'));

    // 根因：保存时就必须记"随盘"归属（app-volume 同族），不是 explicit-path。
    expect(written.workspaceBinding).toBe('app-volume');
  });

  it('⭐ A2：`workspace:change` 选**当前运行卷**上的目录 ⇒ 同上（随盘语义）', async () => {
    getPortableWorkspaceRootMock.mockReturnValue('E:\\');
    removableDrivesState.current = ['E:'];

    const { registerWorkspaceHandlers } = await import('../src/main/ipc/workspace-handlers.js');
    registerWorkspaceHandlers();
    const handler = handleMap.get('workspace:change');
    expect(handler).toBeTypeOf('function');

    await expect(handler?.({}, on('E:\\'))).resolves.toEqual({ ok: true });

    const written = updateConfigMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(written.workspacePath).toBe(on('E:\\'));

    const decision = decisionAfterLetterChange(written, 'F:\\', [
      on('F:\\'),
      win32.join(on('F:\\'), '.clawwork-workspace.json'),
      win32.join('F:\\', 'openclaw-runtime-manifest.json'),
    ]);
    expect(decision.kind, '同盘换工作区后换盘符也不该再问人').toBe('healed');
    expect(written.workspaceBinding).toBe('app-volume');
  });

  it('⚠️ A3 控制：选**别的卷**上的目录 ⇒ 仍 explicit-path；恢复时仍按 R1 询问', async () => {
    getPortableWorkspaceRootMock.mockReturnValue('E:\\');
    removableDrivesState.current = ['E:', 'D:'];

    const { registerWorkspaceHandlers } = await import('../src/main/ipc/workspace-handlers.js');
    registerWorkspaceHandlers();
    const handler = handleMap.get('workspace:setup');

    await expect(handler?.({}, on('D:\\'))).resolves.toEqual({ ok: true });

    const written = writeConfigMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    // 外部目录：归属照旧（显式选择遵从用户），迁移线索照记（D: 是可移动盘）
    expect(written.workspaceBinding).toBe('explicit-path');
    expect(written.workspaceRelPath).toBe(WS);

    // 原来的 D: 目录不在、当前卷（F:）上有同名目录 ⇒ 不许静默改指，必须问人
    const decision = decisionAfterLetterChange(written, 'F:\\', [
      on('F:\\'),
      win32.join('F:\\', 'openclaw-runtime-manifest.json'),
    ]);
    expect(decision.kind).toBe('ask-user');
  });

  it('⚠️ A4 控制：本机安装形态（无运行卷）⇒ 全部线索清掉、归属不变（老行为）', async () => {
    getPortableWorkspaceRootMock.mockReturnValue(null);
    removableDrivesState.current = [];

    const { registerWorkspaceHandlers } = await import('../src/main/ipc/workspace-handlers.js');
    registerWorkspaceHandlers();
    const handler = handleMap.get('workspace:setup');

    await expect(handler?.({}, on('C:\\'))).resolves.toEqual({ ok: true });

    const written = writeConfigMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(written.workspaceRelPath).toBeUndefined();
    expect(written.workspaceBinding).toBeUndefined();
  });
});
