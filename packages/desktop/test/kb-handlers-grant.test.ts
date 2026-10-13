import { mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `kb:pick-files` → `kb:add-file` 的**短期授权（grant）**（BUG-056④）。
 *
 * 现状：`kb:add-file` 直接拿渲染层给的任意路径去入库，主进程**无 allowlist** ——
 * 也就是"只要有一条 IPC 调用能力，就能让应用替你读任意文本文件并建索引"。
 * 修复方向（计划 ④）：picker 建立**短期 grant**，绑定
 *   · sender / frame（A 窗口选的文件，B 窗口用不了）
 *   · canonical path（选择后把文件换成指向别处的链接 ⇒ canonical 变了 ⇒ 拒绝）
 *   · 当前工作区（换 scope 即失效并清理）
 * add-file 只接受"本次 pick 选出来、且还在有效期里"的路径，并校验格式（文本类）与
 * 目标形态（必须仍是普通文件）。失败**安全重试**（服务抛错不消耗 grant）；成功后
 * 同一条路径**一次性消耗**（重放拒绝）。合法外部资料照常允许。
 *
 * ⚠️ 与 `kb-rebuild-handlers.test.ts` 同款：桩掉 electron 与 kb runtime，只测
 *    "通道注册 + 授权边界 + 转发"这一层；真文件用临时目录。
 */
const handleMap = new Map<string, (event: unknown, params?: unknown) => unknown>();

const mocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  getRuntime: vi.fn(),
  getWorkspacePath: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, params?: unknown) => unknown) =>
      handleMap.set(channel, handler),
  },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  dialog: { showOpenDialog: mocks.showOpenDialog },
}));

vi.mock('../src/main/kb/runtime.js', () => ({ getKbRuntime: () => mocks.getRuntime() }));
vi.mock('../src/main/workspace/config.js', () => ({ getWorkspacePath: () => mocks.getWorkspacePath() }));

import { registerKbHandlers, KB_FILE_GRANT_TTL_MS } from '../src/main/ipc/kb-handlers.js';

interface SenderEvent {
  sender: { id: number };
  senderFrame?: { routingId: number };
}

function sender(senderId: number, frameId = 1): SenderEvent {
  return { sender: { id: senderId }, senderFrame: { routingId: frameId } };
}

function call(channel: string, event: unknown, params?: unknown): Promise<unknown> {
  const fn = handleMap.get(channel);
  if (!fn) throw new Error(`没有注册 ${channel} 这个通道`);
  return Promise.resolve(fn(event, params));
}

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

let workspace: string;

function makeFile(dir: string, name: string, body = 'hello 资料'): string {
  const file = path.join(dir, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, 'utf-8');
  return file;
}

/** 走一次真实的"用户选文件"流程：设置 dialog 返回值 → 调 `kb:pick-files`。 */
async function pick(event: SenderEvent, paths: string[] | null): Promise<{ ok: boolean; paths: string[] }> {
  mocks.showOpenDialog.mockResolvedValue(
    paths === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: paths },
  );
  return (await call('kb:pick-files', event)) as { ok: boolean; paths: string[] };
}

const OUTCOME = { status: 'indexed', sourceId: 'src-1', chunkCount: 1, embeddedCount: 1, pendingCount: 0 };
let addFile: ReturnType<typeof vi.fn>;

describe('kb:pick-files / kb:add-file 的短期授权（BUG-056④）', () => {
  beforeEach(() => {
    handleMap.clear();
    mocks.showOpenDialog.mockReset();
    mocks.getWorkspacePath.mockReset();
    mocks.getRuntime.mockReset();
    addFile = vi.fn(async () => OUTCOME);
    mocks.getRuntime.mockReturnValue({ service: { addFile } });
    workspace = tempDir('kb-grant-ws-');
    mocks.getWorkspacePath.mockReturnValue(workspace);
    registerKbHandlers();
  });

  afterEach(() => {
    vi.useRealTimers();
    tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it('⭐ 没 pick 直接 IPC ⇒ 拒绝，服务**一次都没被调用**', async () => {
    const outside = makeFile(tempDir('kb-grant-out-'), 'note.txt');

    const reply = (await call('kb:add-file', sender(1), { path: outside })) as { ok: boolean; error?: string };

    expect(reply.ok).toBe(false);
    expect(addFile).not.toHaveBeenCalled();
  });

  it('⭐ 正常流程：pick 一个**工作区外**的 txt ⇒ add 放行（合法外部资料仍允许）', async () => {
    const outside = makeFile(tempDir('kb-grant-out-'), '预算.txt');
    const picked = await pick(sender(1), [outside]);
    expect(picked).toEqual({ ok: true, paths: [outside] });

    const reply = (await call('kb:add-file', sender(1), { path: outside })) as { ok: boolean };

    expect(reply.ok).toBe(true);
    expect(addFile).toHaveBeenCalledTimes(1);
    // 传给服务的是 canonical 路径（大小写/写法已收敛）
    const passed = addFile.mock.calls[0][0] as string;
    expect(passed.toLowerCase()).toBe(outside.toLowerCase());
  });

  it('⭐ A 窗口 pick 的文件，B 窗口 use ⇒ 拒绝', async () => {
    const outside = makeFile(tempDir('kb-grant-out-'), 'note.txt');
    await pick(sender(1), [outside]);

    const reply = (await call('kb:add-file', sender(2), { path: outside })) as { ok: boolean };

    expect(reply.ok).toBe(false);
    expect(addFile).not.toHaveBeenCalled();
  });

  it('同一窗口但另一个 frame（子帧）也说不上话 ⇒ 拒绝', async () => {
    const outside = makeFile(tempDir('kb-grant-out-'), 'note.txt');
    await pick(sender(1, 1), [outside]);

    const reply = (await call('kb:add-file', sender(1, 2), { path: outside })) as { ok: boolean };

    expect(reply.ok).toBe(false);
    expect(addFile).not.toHaveBeenCalled();
  });

  it('⭐ pick 后链接被改指别处 ⇒ canonical 变了 ⇒ 拒绝（选择时看的那个文件已不是它）', async () => {
    // 用**目录 junction** 表达"同一路径、换了指向"：文件级 symlink 在没开开发者模式的
    // Windows 上要管理员权限（本机实测 EPERM），junction 免权限且语义一致。
    const real1 = tempDir('kb-grant-real1-');
    const real2 = tempDir('kb-grant-real2-');
    makeFile(real1, 'note.txt', '原始');
    makeFile(real2, 'note.txt', '替换目标');
    const alias = path.join(tempDir('kb-grant-alias-'), 'alias');
    try {
      symlinkSync(real1, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // 环境建不了链接 ⇒ 不假装通过
    }
    const pickedPath = path.join(alias, 'note.txt');
    await pick(sender(1), [pickedPath]);

    // 同一路径改指另一个真实目录（删链接本身；junction 的 rmdir 不会带走目标目录）
    if (process.platform === 'win32') rmdirSync(alias);
    else rmSync(alias, { force: true });
    symlinkSync(real2, alias, process.platform === 'win32' ? 'junction' : 'dir');

    const reply = (await call('kb:add-file', sender(1), { path: pickedPath })) as { ok: boolean };

    expect(reply.ok).toBe(false);
    expect(addFile).not.toHaveBeenCalled();
  });

  it('⭐ 用户在对话框点取消 ⇒ 零 grant（add 一律拒绝）', async () => {
    const outside = makeFile(tempDir('kb-grant-out-'), 'note.txt');
    const missed = await pick(sender(1), [outside]);
    expect(missed.ok).toBe(true);

    // 第二次 pick：取消
    const canceled = await pick(sender(1), null);
    expect(canceled.paths).toEqual([]);

    const reply = (await call('kb:add-file', sender(1), { path: outside })) as { ok: boolean };
    expect(reply.ok).toBe(false);
    expect(addFile).not.toHaveBeenCalled();
  });

  it('⭐ 换工作区（scope）⇒ grant 失效并清理（换回来也不能再用）', async () => {
    const outside = makeFile(tempDir('kb-grant-out-'), 'note.txt');
    await pick(sender(1), [outside]);

    const otherWorkspace = tempDir('kb-grant-ws2-');
    mocks.getWorkspacePath.mockReturnValue(otherWorkspace);
    const inOtherScope = (await call('kb:add-file', sender(1), { path: outside })) as { ok: boolean };
    expect(inOtherScope.ok).toBe(false);
    expect(addFile).not.toHaveBeenCalled();

    // 切回来：grant 已被清掉，不许复活
    mocks.getWorkspacePath.mockReturnValue(workspace);
    const backAgain = (await call('kb:add-file', sender(1), { path: outside })) as { ok: boolean };
    expect(backAgain.ok, '切 scope 要清理，不是"离开就冻结、回来就复活"').toBe(false);
  });

  it('⭐ grant 是会过期的短期授权（默认 5 分钟）', async () => {
    const outside = makeFile(tempDir('kb-grant-out-'), 'note.txt');
    await pick(sender(1), [outside]);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + KB_FILE_GRANT_TTL_MS + 1);
      const reply = (await call('kb:add-file', sender(1), { path: outside })) as { ok: boolean };
      expect(reply.ok).toBe(false);
      expect(addFile).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('⭐ 失败安全重试：服务抛错 ⇒ 拒绝但不消耗 grant；同一条路径重试仍被放行', async () => {
    const outside = makeFile(tempDir('kb-grant-out-'), 'note.txt');
    await pick(sender(1), [outside]);

    addFile.mockRejectedValueOnce(new Error('database is locked'));
    const first = (await call('kb:add-file', sender(1), { path: outside })) as { ok: boolean; error?: string };
    expect(first.ok).toBe(false);
    expect(first.error).toBe('database is locked');

    const second = (await call('kb:add-file', sender(1), { path: outside })) as { ok: boolean };
    expect(second.ok, '失败重试不该被 grant 消耗挡住').toBe(true);
    expect(addFile).toHaveBeenCalledTimes(2);
  });

  it('⭐ 成功后同一条路径一次性消耗：重放 add 拒绝', async () => {
    const outside = makeFile(tempDir('kb-grant-out-'), 'note.txt');
    await pick(sender(1), [outside]);

    expect(((await call('kb:add-file', sender(1), { path: outside })) as { ok: boolean }).ok).toBe(true);
    const replay = (await call('kb:add-file', sender(1), { path: outside })) as { ok: boolean };

    expect(replay.ok).toBe(false);
    expect(addFile).toHaveBeenCalledTimes(1);
  });

  it('格式校验：趁 dialog 过滤器被绕过选到的二进制文件 ⇒ 拒绝（不给模型/渲染层入库任意文件）', async () => {
    const dir = tempDir('kb-grant-bin-');
    const exe = makeFile(dir, 'tool.exe', 'MZ');
    await pick(sender(1), [exe]);

    const reply = (await call('kb:add-file', sender(1), { path: exe })) as { ok: boolean };

    expect(reply.ok).toBe(false);
    expect(addFile).not.toHaveBeenCalled();
  });

  it('目标形态校验：目录（或 pick 后被删掉的文件）⇒ 明确失败', async () => {
    const dir = tempDir('kb-grant-dir-');
    const folder = path.join(dir, 'folder.txt');
    mkdirSync(folder, { recursive: true });
    const gone = makeFile(dir, 'gone.txt');
    await pick(sender(1), [folder, gone]);
    rmSync(gone, { force: true });

    const folderReply = (await call('kb:add-file', sender(1), { path: folder })) as { ok: boolean };
    expect(folderReply.ok).toBe(false);
    const goneReply = (await call('kb:add-file', sender(1), { path: gone })) as { ok: boolean };
    expect(goneReply.ok).toBe(false);
    expect(addFile).not.toHaveBeenCalled();
  });

  it('runtime 没就绪（grant 合法）⇒ not-ready（保持既有语义）', async () => {
    const outside = makeFile(tempDir('kb-grant-out-'), 'note.txt');
    await pick(sender(1), [outside]);
    mocks.getRuntime.mockReturnValue(null);

    const reply = (await call('kb:add-file', sender(1), { path: outside })) as { ok: boolean; code?: string };

    expect(reply.ok).toBe(false);
    expect(reply.code).toBe('not-ready');
  });
});
