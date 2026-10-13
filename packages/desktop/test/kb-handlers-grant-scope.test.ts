import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * S 包复审 S-R1 / S-R2（reviews/2026-10-14-closeout-security-s-review.md）：
 * grant 必须绑**工作区生命周期**（scope+revision 同代），picker 必须按**代次**收敛。
 *
 * 三个反例（原来在 probe-20261014-s-kb-grants.cjs 里 3/3 都返回 ok:true）：
 *   ① A 选文件 → 切 B → 切回 A（期间不调 add）→ 旧 grant 仍放行；
 *   ② A 打开 picker → await 期间切到 B → picker 返回 → 在 B 添加放行；
 *   ③ 较新 picker 取消之后，较旧 picker 的迟到结果把授权写回。
 * 本档把三个反例变成**拒绝 + service 零调用**断言，并配正向对照（正常流程照常放行）。
 *
 * 工作区代次走**真实** `workspace/scope.ts`（与 db/index.ts 开/关库同一套调用：
 * 关库 → setWorkspaceDatabaseOwner(null)，开库 → setWorkspaceDatabaseOwner(db)）；
 * electron / 工作区路径 / kb service 是桩，选中的文件是临时目录里的真文件。
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

import { registerKbHandlers } from '../src/main/ipc/kb-handlers.js';
import { setWorkspaceDatabaseOwner } from '../src/main/workspace/scope.js';

interface SenderEvent {
  sender: { id: number };
  senderFrame?: { routingId: number };
}

interface PickReply {
  ok: boolean;
  paths: string[];
  /** 失效结果的可观察标记（不写 grant、不回可消费的 paths） */
  stale?: string;
}

interface AddReply {
  ok: boolean;
  error?: string;
  code?: string;
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

/**
 * 模拟一次**真实的工作区切换**：关库 + 开新库（与 db/index.ts 的
 * closeDatabase / openDatabaseAt 同款调用序列）⇒ scope 换 UUID、revision 推进
 * ⇒ 所有旧 grant 立即失效，且"切回原路径"也是新的一代。
 */
function switchWorkspace(nextPath: string): void {
  setWorkspaceDatabaseOwner(null); // closeDatabase()
  setWorkspaceDatabaseOwner({}); // openDatabaseAt(next)
  mocks.getWorkspacePath.mockReturnValue(nextPath);
}

async function pick(event: SenderEvent, paths: string[] | null): Promise<PickReply> {
  mocks.showOpenDialog.mockResolvedValue(
    paths === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: paths },
  );
  return (await call('kb:pick-files', event)) as PickReply;
}

async function add(event: SenderEvent, filePath: string): Promise<AddReply> {
  return (await call('kb:add-file', event, { path: filePath })) as AddReply;
}

/** 起一个"打开后悬着"的 picker：返回 resolve 函数，稍后手动收口那个 dialog。 */
function deferredPick(event: SenderEvent): { pending: Promise<unknown>; finish: (result: unknown) => void } {
  let finish!: (result: unknown) => void;
  mocks.showOpenDialog.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const pending = call('kb:pick-files', event);
  // 处理器在第一个 await 之前是同步的：call() 返回时 dialog 一定已经打开
  expect(typeof finish).toBe('function');
  return { pending, finish };
}

const OUTCOME = { status: 'indexed', sourceId: 'src-1', chunkCount: 1, embeddedCount: 1, pendingCount: 0 };
let addFile: ReturnType<typeof vi.fn>;
let workspace: string;

describe('kb grant ↔ 工作区生命周期 / picker 代次（S-R1 / S-R2）', () => {
  beforeEach(() => {
    handleMap.clear();
    mocks.showOpenDialog.mockReset();
    mocks.getWorkspacePath.mockReset();
    mocks.getRuntime.mockReset();
    addFile = vi.fn(async () => OUTCOME);
    mocks.getRuntime.mockReturnValue({ service: { addFile } });
    workspace = tempDir('kb-scope-ws-a-');
    // 收口上一档可能留下的"开库"状态（已是 null 则不动），再开本档的库
    setWorkspaceDatabaseOwner(null);
    setWorkspaceDatabaseOwner({});
    mocks.getWorkspacePath.mockReturnValue(workspace);
    registerKbHandlers();
  });

  afterEach(() => {
    tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  it('① 反例：A 选文件 → 切 B → 切回 A（期间不调 add）⇒ 旧 grant 拒绝、service 零调用', async () => {
    const outside = makeFile(tempDir('kb-scope-out-'), '预算.txt');
    expect(await pick(sender(901), [outside])).toEqual({ ok: true, paths: [outside] });

    switchWorkspace(tempDir('kb-scope-ws-b-'));
    switchWorkspace(workspace); // 切**回**原路径 —— 也是新一代，不能复活

    const reply = await add(sender(901), outside);
    expect(reply.ok, '切走再切回不能复活旧授权（不依赖在 B 有 add）').toBe(false);
    expect(addFile).not.toHaveBeenCalled();
  });

  it('① 正向对照：切回原路径后**重新 pick** ⇒ 照常放行', async () => {
    const outside = makeFile(tempDir('kb-scope-out-'), '预算.txt');
    await pick(sender(902), [outside]);
    switchWorkspace(tempDir('kb-scope-ws-b-'));
    switchWorkspace(workspace);

    expect((await pick(sender(902), [outside])).paths).toEqual([outside]);
    const reply = await add(sender(902), outside);
    expect(reply.ok).toBe(true);
    expect(addFile).toHaveBeenCalledTimes(1);
  });

  it('② 反例：picker 打开期间切换工作区 ⇒ 结果失效、不建立授权、B 里 add 拒绝', async () => {
    const outside = makeFile(tempDir('kb-scope-out-'), '预算.txt');
    const { pending, finish } = deferredPick(sender(903));

    switchWorkspace(tempDir('kb-scope-ws-b-')); // await 期间切到 B
    finish({ canceled: false, filePaths: [outside] });

    const picked = (await pending) as PickReply;
    expect(picked.stale, '迟到的选择结果必须标记为失效').toBe('workspace-changed');
    expect(picked.paths, '失效结果不能回可消费的 paths').toEqual([]);

    const reply = await add(sender(903), outside);
    expect(reply.ok, 'A 发起的授权不能落在 B 上').toBe(false);
    expect(addFile).not.toHaveBeenCalled();
  });

  it('③ 反例：较新 picker 取消、较旧 picker 迟到成功 ⇒ 授权不复活、add 拒绝', async () => {
    const outside = makeFile(tempDir('kb-scope-out-'), '预算.txt');
    const { pending, finish } = deferredPick(sender(904));

    // 较新的一次：用户点了取消并已返回
    const newer = await pick(sender(904), null);
    expect(newer).toEqual({ ok: true, paths: [] });

    // 较旧的迟到成功 —— 不能把授权写回
    finish({ canceled: false, filePaths: [outside] });
    const late = (await pending) as PickReply;
    expect(late.stale, '被后面那次 picker 顶掉的旧结果必须标记为失效').toBe('picker-superseded');
    expect(late.paths).toEqual([]);

    const reply = await add(sender(904), outside);
    expect(reply.ok).toBe(false);
    expect(addFile).not.toHaveBeenCalled();
  });

  it('④ 安全向：较新 picker 成功、较旧 picker 迟到取消 ⇒ 较新授权原样保留', async () => {
    const newerFile = makeFile(tempDir('kb-scope-out-'), '新选.txt');
    const olderFile = makeFile(tempDir('kb-scope-out-'), '旧选.txt');
    const { pending, finish } = deferredPick(sender(905));

    const newer = await pick(sender(905), [newerFile]);
    expect(newer).toEqual({ ok: true, paths: [newerFile] });

    finish({ canceled: true, filePaths: [] }); // 较旧：迟到取消
    const late = (await pending) as PickReply;
    expect(late.paths).toEqual([]);

    expect((await add(sender(905), newerFile)).ok, '较新一次的授权不许被旧结果清掉').toBe(true);
    expect((await add(sender(905), olderFile)).ok, '旧 picker 的文件从未被授权').toBe(false);
    expect(addFile).toHaveBeenCalledTimes(1);
  });

  it('⑤ 安全向：较新成功之后，较旧 picker 的迟到成功不得覆盖较新授权', async () => {
    const newerFile = makeFile(tempDir('kb-scope-out-'), '新选.txt');
    const olderFile = makeFile(tempDir('kb-scope-out-'), '旧选.txt');
    const { pending, finish } = deferredPick(sender(906));

    await pick(sender(906), [newerFile]);
    finish({ canceled: false, filePaths: [olderFile] }); // 较旧：迟到成功
    const late = (await pending) as PickReply;
    expect(late.stale).toBe('picker-superseded');
    expect(late.paths).toEqual([]);

    expect((await add(sender(906), newerFile)).ok, '授权必须仍是"最后一次 picker"的那份').toBe(true);
    expect((await add(sender(906), olderFile)).ok, '旧 picker 的结果不许覆盖较新授权').toBe(false);
    expect(addFile).toHaveBeenCalledTimes(1);
  });

  it('正向对照：正常单 picker 原行为保持（含取消语义与 canonical 路径）', async () => {
    const outside = makeFile(tempDir('kb-scope-out-'), '预算.txt');

    const picked = await pick(sender(907), [outside]);
    expect(picked).toEqual({ ok: true, paths: [outside] }); // 无 stale 标记，形状与原来一致
    const reply = await add(sender(907), outside);
    expect(reply.ok).toBe(true);
    const passed = addFile.mock.calls[0][0] as string;
    expect(passed.toLowerCase()).toBe(outside.toLowerCase());

    // 取消：零 grant（与既有档同款断言）
    const canceled = await pick(sender(907), null);
    expect(canceled).toEqual({ ok: true, paths: [] });
    expect((await add(sender(907), outside)).ok).toBe(false);
  });
});
