import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * S-R1 补充（reviews/2026-10-14-closeout-security-s-review.md）：
 * grant 自己带着 pick 打开时刻的 **scope/revision**，`kb:add-file` 必须**亲自**做同代校验 ——
 * 不能只依赖 `subscribeWorkspaceScope` 的清理通知（通知丢了/顺序变了都不能复活授权）。
 *
 * 本档把 scope 模块换成替身，提供一条**换代但不通知订阅者**的路径：
 * 如果 add 只看订阅清理，这条会放行（红）；同代校验在位则必须拒绝并清理。
 * 正向对照：代次未变 ⇒ 照常放行。
 */

const handleMap = new Map<string, (event: unknown, params?: unknown) => unknown>();

const mocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  getRuntime: vi.fn(),
  getWorkspacePath: vi.fn(),
}));

const scopeStub = vi.hoisted(() => ({
  current: { scope: 'gen-1' as string | null, revision: 41 },
  /** 静默换代：推进 scope/revision，但**不**通知 subscribeWorkspaceScope 的订阅者 */
  bumpSilently(nextScope: string | null) {
    scopeStub.current = { scope: nextScope, revision: scopeStub.current.revision + 1 };
  },
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
vi.mock('../src/main/workspace/scope.js', () => ({
  getWorkspaceScope: () => ({ ...scopeStub.current }),
  subscribeWorkspaceScope: (_listener: (scope: { scope: string | null; revision: number }) => void) => () => {},
}));

import { registerKbHandlers } from '../src/main/ipc/kb-handlers.js';

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

function makeFile(dir: string, name: string, body = 'hello 资料'): string {
  const file = path.join(dir, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, 'utf-8');
  return file;
}

const OUTCOME = { status: 'indexed', sourceId: 'src-1', chunkCount: 1, embeddedCount: 1, pendingCount: 0 };
let addFile: ReturnType<typeof vi.fn>;

describe('kb grant 的 add 侧同代校验（不依赖 scope 订阅通知）', () => {
  beforeEach(() => {
    handleMap.clear();
    mocks.showOpenDialog.mockReset();
    mocks.getWorkspacePath.mockReset();
    mocks.getRuntime.mockReset();
    addFile = vi.fn(async () => OUTCOME);
    mocks.getRuntime.mockReturnValue({ service: { addFile } });
    mocks.getWorkspacePath.mockReturnValue(tempDir('kb-epoch-ws-'));
    registerKbHandlers();
  });

  afterEach(() => {
    tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it('静默换代（订阅没通知）⇒ add 仍必须拒绝 + service 零调用（同代校验在位）', async () => {
    const outside = makeFile(tempDir('kb-epoch-out-'), '笔记.txt');
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [outside] });
    await call('kb:pick-files', sender(801));

    const openedAt = { ...scopeStub.current }; // pick 打开时刻的代次（原值）
    scopeStub.bumpSilently('gen-2'); // 换库了，但订阅者没收到通知

    const denied = (await call('kb:add-file', sender(801), { path: outside })) as { ok: boolean };
    expect(denied.ok, 'grant 必须自己比 scope/revision，不能只靠订阅清理').toBe(false);
    expect(addFile).not.toHaveBeenCalled();

    // 被拒即清理：把代次逐字段**原样恢复**（scope+revision 都回到 pick 时刻的值）——
    // 若 grant 还留在 map 里，这次同代校验会放行；拒绝才证明它真的被清掉了。
    scopeStub.current = { ...openedAt };
    const again = (await call('kb:add-file', sender(801), { path: outside })) as { ok: boolean };
    expect(again.ok, '被拒的 grant 必须已清理，不能留在 map 里').toBe(false);
    expect(addFile).not.toHaveBeenCalled();
  });

  it('picker 打开期间静默换代 ⇒ 迟到结果不建立授权', async () => {
    const outside = makeFile(tempDir('kb-epoch-out-'), '笔记.txt');
    let finish!: (result: unknown) => void;
    mocks.showOpenDialog.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const pending = call('kb:pick-files', sender(802));

    scopeStub.bumpSilently('gen-2'); // 订阅没通知：只能靠 pick 结果回来时的同代比对
    finish({ canceled: false, filePaths: [outside] });

    const picked = (await pending) as { ok: boolean; paths: string[]; stale?: string };
    expect(picked.stale).toBe('workspace-changed');
    expect(picked.paths).toEqual([]);

    const denied = (await call('kb:add-file', sender(802), { path: outside })) as { ok: boolean };
    expect(denied.ok).toBe(false);
    expect(addFile).not.toHaveBeenCalled();
  });

  it('正向对照：代次未变 ⇒ 照常放行', async () => {
    const outside = makeFile(tempDir('kb-epoch-out-'), '笔记.txt');
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [outside] });
    await call('kb:pick-files', sender(803));

    const reply = (await call('kb:add-file', sender(803), { path: outside })) as { ok: boolean };
    expect(reply.ok).toBe(true);
    expect(addFile).toHaveBeenCalledTimes(1);
  });
});
