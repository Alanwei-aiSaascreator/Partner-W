// @vitest-environment jsdom
/**
 * `useTaskArtifacts` —— 聊天产物卡的数据源（Codex 审核 P1-4）。
 *
 * 数据 = `fileStore.artifacts`（App 订阅 `artifact:saved` 全库 upsert，**只有 store 是全局视图**）
 *      + 每次**任务级** `window.clawwork.listArtifacts(taskId)`（逐行实时算 availability）。
 *
 * 本文件钉住的规则（每条一个用例）：
 *   1. 请求共享：同任务 N 个消费者只发 1 次 `listArtifacts`；
 *   2. fresh 优先：新查询的字段压过 store 行（旧 available 不压 fresh missing，反之亦然）；
 *   3. 合并：union by id，只在 store 里的行保留；
 *   4. 查询在途时该任务有新保存 ⇒ 本轮作废 + 有界跟进重查；
 *   5. epoch 变更 ⇒ 迟到响应弃用（不发到新展示）；
 *   6. unknown 短 TTL：20s 再核验；卸载后定时器不再触发；
 *   7. 发起者先卸载，其他消费者仍能落定；
 *   8. 失败可重试（保留 store 行、pending 落定、再挂载重试成功）；
 *   9. `selectCurrentArtifactsForMessage`：先按完整任务归并、再按消息分发。
 *
 * ⚠️ 被测 hook 的快照缓存是**模块级**的（键 = `${epoch}::${taskId}`）——
 *    因此每个用例都用**独立的 taskId**，用例之间不靠 resetModules 隔离。
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '@clawwork/shared';

/**
 * 本文件只 mock taskStore（要真的能 setState 出 epoch 变更）。
 * fileStore 用真件：hook 的订阅/合并语义就长在它身上。
 */
const taskScope = vi.hoisted(() => ({
  store: undefined as unknown,
}));

vi.mock('../src/renderer/stores/taskStore', async () => {
  const { create } = await import('zustand');
  const useTaskStore = create<{ workspaceEpoch: number }>(() => ({ workspaceEpoch: 0 }));
  taskScope.store = useTaskStore as unknown;
  return { useTaskStore };
});

import { selectCurrentArtifactsForMessage, useTaskArtifacts } from '../src/renderer/hooks/useTaskArtifacts';
import { useFileStore } from '../src/renderer/stores/fileStore';

type TaskStoreLike = {
  getState: () => { workspaceEpoch: number };
  setState: (partial: { workspaceEpoch: number }) => void;
};
const taskStore = () => taskScope.store as TaskStoreLike;

type TaskArtifacts = { artifacts: Artifact[]; pending: boolean };

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeArtifact(overrides: Partial<Artifact> & Pick<Artifact, 'id' | 'taskId'>): Artifact {
  return {
    messageId: 'message-1',
    type: 'file',
    name: `${overrides.id}.pptx`,
    filePath: `C:/ws/${overrides.id}.pptx`,
    localPath: `${overrides.id}.pptx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    size: 1024,
    createdAt: '2026-10-08T10:00:00.000Z',
    availability: 'available',
    ...overrides,
  };
}

/** 本仓没有 @testing-library/*，手写 renderHook（形状照 `test/entry-deploy-progress.test.tsx:48`）。 */
const disposers: (() => void)[] = [];
function renderHook(
  hook: (props: { taskId: string | undefined }) => TaskArtifacts,
  options = { initialProps: { taskId: 'task-1' as string | undefined } },
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const result: { current: TaskArtifacts } = { current: { artifacts: [], pending: true } };
  function Probe({ taskId }: { taskId: string | undefined }) {
    result.current = hook({ taskId });
    return null;
  }
  const rerender = (props: { taskId: string | undefined }) => act(() => root.render(<Probe {...props} />));
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    act(() => root.unmount());
    container.remove();
  };
  disposers.push(unmount);
  rerender(options.initialProps);
  return { result, rerender, unmount };
}

beforeEach(() => {
  taskStore().setState({ workspaceEpoch: 0 });
  useFileStore.setState({ artifacts: [] });
  delete (window as { clawwork?: unknown }).clawwork;
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  delete (window as { clawwork?: unknown }).clawwork;
  vi.useRealTimers();
});

describe('useTaskArtifacts', () => {
  it('1) 请求共享：同任务两个消费者只发 1 次 listArtifacts，结果两边共享', async () => {
    const read = deferred<{ ok: boolean; result: Artifact[] }>();
    const listArtifacts = vi.fn(() => read.promise);
    Object.assign(window, { clawwork: { listArtifacts } });
    const row = makeArtifact({ id: 'a1', taskId: 'task-1' });

    const first = renderHook(() => useTaskArtifacts('task-1'));
    const second = renderHook(() => useTaskArtifacts('task-1'));

    expect(listArtifacts).toHaveBeenCalledTimes(1);
    expect(first.result.current.pending).toBe(true);
    expect(second.result.current.pending).toBe(true);

    await act(async () => {
      read.resolve({ ok: true, result: [row] });
    });

    expect(listArtifacts).toHaveBeenCalledTimes(1);
    expect(first.result.current.artifacts.map((a) => a.id)).toEqual(['a1']);
    expect(second.result.current.artifacts.map((a) => a.id)).toEqual(['a1']);
    expect(first.result.current.pending).toBe(false);
    expect(second.result.current.pending).toBe(false);
  });

  it('2) store 里旧的 available **不许**压掉新查询的 missing（fresh 优先）', async () => {
    const stored = makeArtifact({ id: 'a1', taskId: 'task-2', availability: 'available' });
    useFileStore.setState({ artifacts: [stored] });
    const listArtifacts = vi.fn().mockResolvedValue({ ok: true, result: [{ ...stored, availability: 'missing' }] });
    Object.assign(window, { clawwork: { listArtifacts } });

    const { result } = renderHook(() => useTaskArtifacts('task-2'));
    await act(async () => {});

    expect(result.current.artifacts).toHaveLength(1);
    expect(result.current.artifacts[0]!.availability).toBe('missing');
    expect(result.current.pending).toBe(false);
  });

  it('3) store 里旧的 unknown **不许**压掉新查询的 available（fresh 优先）', async () => {
    const stored = makeArtifact({ id: 'a1', taskId: 'task-3', availability: 'unknown' });
    useFileStore.setState({ artifacts: [stored] });
    const listArtifacts = vi.fn().mockResolvedValue({ ok: true, result: [{ ...stored, availability: 'available' }] });
    Object.assign(window, { clawwork: { listArtifacts } });

    const { result } = renderHook(() => useTaskArtifacts('task-3'));
    await act(async () => {});

    expect(result.current.artifacts[0]!.availability).toBe('available');
  });

  it('4) 查询在途时该任务有新保存 ⇒ 本轮作废（不覆盖 store）+ 有界跟进重查，最新 store 行不丢', async () => {
    const stored = makeArtifact({ id: 'a1', taskId: 'task-4', availability: 'available' });
    useFileStore.setState({ artifacts: [stored] });
    const first = deferred<{ ok: boolean; result: Artifact[] }>();
    const follow = deferred<{ ok: boolean; result: Artifact[] }>();
    const listArtifacts = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => follow.promise);
    Object.assign(window, { clawwork: { listArtifacts } });

    const { result } = renderHook(() => useTaskArtifacts('task-4'));
    expect(listArtifacts).toHaveBeenCalledTimes(1);

    const saved = makeArtifact({ id: 'a2', taskId: 'task-4', createdAt: '2026-10-08T10:05:00.000Z' });
    await act(async () => {
      useFileStore.getState().upsertArtifact(saved);
    });

    // 这一轮回来的是"保存之前"的旧结论 ⇒ 作废：不许把 store 里刚保存的行盖成旧值
    await act(async () => {
      first.resolve({ ok: true, result: [{ ...stored, availability: 'missing' }] });
    });

    expect(listArtifacts, '作废之后必须排队一次跟进重查').toHaveBeenCalledTimes(2);
    expect(result.current.artifacts.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
    expect(result.current.artifacts.find((a) => a.id === 'a1')!.availability, '旧响应不许覆盖 store').toBe('available');

    // 跟进重查（以保存之后的计数为基线）落定 ⇒ fresh 重新获得权威
    await act(async () => {
      follow.resolve({ ok: true, result: [{ ...stored, availability: 'missing' }, saved] });
    });
    expect(result.current.artifacts.find((a) => a.id === 'a1')!.availability).toBe('missing');
    expect(result.current.artifacts.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
  });

  it('5) epoch 变更 ⇒ 迟到响应弃用（不发到新展示），新 epoch 自己重新查询', async () => {
    const staleRead = deferred<{ ok: boolean; result: Artifact[] }>();
    const listArtifacts = vi
      .fn()
      .mockImplementationOnce(() => staleRead.promise)
      .mockResolvedValue({ ok: true, result: [] });
    Object.assign(window, { clawwork: { listArtifacts } });

    const { result } = renderHook(() => useTaskArtifacts('task-5'));
    expect(listArtifacts).toHaveBeenCalledTimes(1);

    await act(async () => {
      taskStore().setState({ workspaceEpoch: 1 });
    });
    expect(listArtifacts, '新 epoch 必须重新查询').toHaveBeenCalledTimes(2);

    await act(async () => {
      staleRead.resolve({ ok: true, result: [makeArtifact({ id: 'stale', taskId: 'task-5' })] });
    });

    expect(result.current.artifacts, '旧 epoch 的迟到响应不许发到新展示').toEqual([]);
    expect(result.current.pending).toBe(false);
  });

  it('6) unknown 短 TTL：20s 后重查一次并合并更新；卸载后定时器不再触发', async () => {
    vi.useFakeTimers();
    const unknownRow = makeArtifact({ id: 'u1', taskId: 'task-6', availability: 'unknown' });
    const listArtifacts = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: [unknownRow] })
      .mockResolvedValueOnce({ ok: true, result: [{ ...unknownRow, availability: 'available' }] });
    Object.assign(window, { clawwork: { listArtifacts } });

    const { result, unmount } = renderHook(() => useTaskArtifacts('task-6'));
    await act(async () => {});
    expect(result.current.artifacts[0]!.availability).toBe('unknown');
    expect(listArtifacts).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(listArtifacts, 'unknown 挂满 20s（助手根负缓存时长）必须再核验一次').toHaveBeenCalledTimes(2);
    expect(result.current.artifacts[0]!.availability).toBe('available');

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(listArtifacts, '卸载后定时器不许再触发').toHaveBeenCalledTimes(2);
  });

  it('7) 发起者先卸载：另一消费者仍拿到结果、pending 正常落定', async () => {
    const read = deferred<{ ok: boolean; result: Artifact[] }>();
    const listArtifacts = vi.fn(() => read.promise);
    Object.assign(window, { clawwork: { listArtifacts } });

    const first = renderHook(() => useTaskArtifacts('task-7'));
    const second = renderHook(() => useTaskArtifacts('task-7'));
    expect(listArtifacts).toHaveBeenCalledTimes(1);

    first.unmount();
    const row = makeArtifact({ id: 'a1', taskId: 'task-7' });
    await act(async () => {
      read.resolve({ ok: true, result: [row] });
    });

    expect(second.result.current.pending).toBe(false);
    expect(second.result.current.artifacts.map((a) => a.id)).toEqual(['a1']);
    expect(listArtifacts).toHaveBeenCalledTimes(1);
  });

  // `sync-throw` = 宿主同步抛（不走 Promise）：这一档专门钉"entry 不许被钉死在已死的
  // Promise 上"——修之前，finally 会抢在 `entry.promise` 赋值之前把槽清掉，随后又被
  // 已死的 Promise 覆盖，再挂载永远重试不动。
  it.each(['reply', 'throw', 'sync-throw'] as const)(
    '8) 首次查询失败（%s）⇒ pending 落定、以 store 显示；再挂载重试成功',
    async (failure) => {
      // 每个变体各用各的 taskId：快照缓存是模块级的，同内容夹具会命中上一变体的缓存
      // （那是设计内行为——"内容没变就不重查"；用例隔离靠 taskId）。
      const taskId = `task-8-${failure}`;
      const stored = makeArtifact({ id: 's1', taskId });
      useFileStore.setState({ artifacts: [stored] });
      const fresh = makeArtifact({ id: 'f1', taskId, createdAt: '2026-10-08T10:09:00.000Z' });
      const listArtifacts = vi.fn();
      if (failure === 'reply') listArtifacts.mockResolvedValueOnce({ ok: false, error: 'boom' });
      else if (failure === 'throw') listArtifacts.mockRejectedValueOnce(new Error('boom'));
      else
        listArtifacts.mockImplementationOnce(() => {
          throw new Error('boom');
        });
      listArtifacts.mockResolvedValueOnce({ ok: true, result: [fresh] });
      Object.assign(window, { clawwork: { listArtifacts } });

      const first = renderHook(() => useTaskArtifacts(taskId));
      await act(async () => {});
      expect(first.result.current.pending).toBe(false);
      expect(first.result.current.artifacts.map((a) => a.id)).toEqual(['s1']);

      first.unmount();
      const second = renderHook(() => useTaskArtifacts(taskId));
      await act(async () => {});

      expect(listArtifacts, '再挂载必须重试').toHaveBeenCalledTimes(2);
      expect(second.result.current.pending).toBe(false);
      expect(second.result.current.artifacts.map((a) => a.id).sort()).toEqual(['f1', 's1']);
      expect(second.result.current.artifacts.find((a) => a.id === 'f1')).toBeDefined();
    },
  );

  it('宿主没有 listArtifacts 通道（旧 preload / pwa）⇒ 以 store 落定，不抛', async () => {
    const stored = makeArtifact({ id: 's1', taskId: 'task-10' });
    useFileStore.setState({ artifacts: [stored] });
    Object.assign(window, { clawwork: {} });

    const { result } = renderHook(() => useTaskArtifacts('task-10'));
    await act(async () => {});

    expect(result.current.pending).toBe(false);
    expect(result.current.artifacts.map((a) => a.id)).toEqual(['s1']);
  });

  it('taskId 为空 ⇒ 不查、不订阅，直接空结果并落定', async () => {
    const listArtifacts = vi.fn().mockResolvedValue({ ok: true, result: [] });
    Object.assign(window, { clawwork: { listArtifacts } });

    const { result } = renderHook(() => useTaskArtifacts(undefined));
    await act(async () => {});

    expect(listArtifacts).not.toHaveBeenCalled();
    expect(result.current).toEqual({ artifacts: [], pending: false });
  });
});

describe('selectCurrentArtifactsForMessage', () => {
  it('9) 先对完整任务归并、再按消息分发：同族的旧版绝不伪装成 current', () => {
    const v1 = makeArtifact({
      id: 'v1',
      taskId: 'task-9',
      messageId: 'm1',
      name: '报告-3f2a1b8c.pptx',
      createdAt: '2026-10-08T10:00:00.000Z',
    });
    const v2 = makeArtifact({
      id: 'v2',
      taskId: 'task-9',
      messageId: 'm2',
      name: '报告-7c4d2a90.pptx',
      createdAt: '2026-10-08T10:05:00.000Z',
    });
    const plain = makeArtifact({
      id: 'plain',
      taskId: 'task-9',
      messageId: 'm3',
      name: '报告.pptx',
      createdAt: '2026-10-08T10:06:00.000Z',
    });
    const all = [v1, v2, plain];

    // 同族（`报告` + `-<8hex>` 受控后缀）只有最新可用版是 current ⇒ 落在它所属的消息上。
    expect(selectCurrentArtifactsForMessage(all, 'm2').map((a) => a.id)).toEqual(['v2']);
    // 旧版属于同族、但被更新的版本取代 ⇒ 它那条消息上**没有** current（绝不伪装）。
    expect(selectCurrentArtifactsForMessage(all, 'm1')).toEqual([]);
    // `报告.pptx` 没有 `-<8hex>` 版本后缀 ⇒ 与两条哈希名**不同族**（既有族键口径，
    // 见 `lib/artifact-versions.ts`），所以它自己就是 current，照常出现在 m3 上。
    expect(selectCurrentArtifactsForMessage(all, 'm3').map((a) => a.id)).toEqual(['plain']);
    expect(selectCurrentArtifactsForMessage(all, 'missing-message')).toEqual([]);
  });
});

/**
 * Codex 总审（R2–R4）回归。
 *
 * R2：`reconcile.ts:776/912` 证明「同 ID、同 createdAt、等长文件覆盖、只变 sourceKey」是**正式路径**
 *     ⇒ 指纹漏算 sourceKey 就会把旧修订当新修订发布（或把新修订的核验吞掉）。
 * R3：已核验快照原先**永久有效** ⇒ 磁盘删除/恢复后切回任务仍显示旧状态 ⇒ 定 20s 时效。
 * R4：在途查询失败时只有成功分支比指纹 ⇒ "期间保存过"的触发被吞 ⇒ 三条落定路径都要比。
 */
describe('useTaskArtifacts · R2/R3/R4 回归', () => {
  it('R2-1) 仅 sourceKey 变化（同 id/createdAt/size）⇒ 重新核验；旧修订不许压过新修订', async () => {
    const taskId = 'task-11';
    const base = makeArtifact({
      id: 'c1',
      taskId,
      createdAt: '2026-10-08T10:00:00.000Z',
      size: 2048,
      sourceKey: 'file:/old',
    });
    useFileStore.setState({ artifacts: [base] });
    const follow = deferred<{ ok: boolean; result: Artifact[] }>();
    const listArtifacts = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: [base] })
      .mockImplementationOnce(() => follow.promise);
    Object.assign(window, { clawwork: { listArtifacts } });

    const { result } = renderHook(() => useTaskArtifacts(taskId));
    await act(async () => {});
    expect(listArtifacts).toHaveBeenCalledTimes(1);
    expect(result.current.artifacts[0]!.sourceKey).toBe('file:/old');

    // reconcile 的覆盖：同 ID、同 createdAt、同 size，只有 sourceKey 变
    await act(async () => {
      useFileStore.getState().upsertArtifact({ ...base, sourceKey: 'file:/new' });
    });

    expect(listArtifacts, '指纹必须看得见 sourceKey 的变化').toHaveBeenCalledTimes(2);
    expect(result.current.artifacts[0]!.sourceKey, '旧快照不许发布成当前修订').toBe('file:/new');

    await act(async () => {
      follow.resolve({ ok: true, result: [{ ...base, sourceKey: 'file:/new', availability: 'missing' }] });
    });
    expect(result.current.artifacts[0]!.sourceKey).toBe('file:/new');
    expect(result.current.artifacts[0]!.availability).toBe('missing');
  });

  it('R2-2) 查询在途时仅 sourceKey 变化 ⇒ 本轮作废 + 跟进；旧修订覆盖不回新修订', async () => {
    const taskId = 'task-12';
    const base = makeArtifact({
      id: 'c2',
      taskId,
      createdAt: '2026-10-08T10:00:00.000Z',
      size: 4096,
      sourceKey: 'file:/old',
    });
    useFileStore.setState({ artifacts: [base] });
    const first = deferred<{ ok: boolean; result: Artifact[] }>();
    const second = deferred<{ ok: boolean; result: Artifact[] }>();
    const listArtifacts = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    Object.assign(window, { clawwork: { listArtifacts } });

    const { result } = renderHook(() => useTaskArtifacts(taskId));
    await act(async () => {
      useFileStore.getState().upsertArtifact({ ...base, sourceKey: 'file:/new' });
    });
    await act(async () => {
      first.resolve({ ok: true, result: [base] }); // 旧修订（sourceKey 还是 old）
    });

    expect(listArtifacts, '期间有修订 ⇒ 作废本轮 + 排一次跟进').toHaveBeenCalledTimes(2);
    expect(result.current.artifacts[0]!.sourceKey, '旧修订不许覆盖 store 里的新修订').toBe('file:/new');

    await act(async () => {
      second.resolve({ ok: true, result: [{ ...base, sourceKey: 'file:/new', availability: 'missing' }] });
    });
    expect(result.current.artifacts[0]!.sourceKey).toBe('file:/new');
    expect(result.current.artifacts[0]!.availability).toBe('missing');
  });

  it('R2-3) messageId 变化的正常更新仍正确（生产路径正向）', async () => {
    const taskId = 'task-13';
    const base = makeArtifact({ id: 'c3', taskId, messageId: 'm1', createdAt: '2026-10-08T10:00:00.000Z' });
    useFileStore.setState({ artifacts: [base] });
    const listArtifacts = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: [base] })
      .mockResolvedValueOnce({ ok: true, result: [{ ...base, messageId: 'm2', availability: 'missing' }] });
    Object.assign(window, { clawwork: { listArtifacts } });

    const { result } = renderHook(() => useTaskArtifacts(taskId));
    await act(async () => {});
    expect(result.current.artifacts[0]!.messageId).toBe('m1');

    await act(async () => {
      useFileStore.getState().upsertArtifact({ ...base, messageId: 'm2' });
    });
    await act(async () => {});

    expect(listArtifacts, 'messageId 变化也必须触发重核验').toHaveBeenCalledTimes(2);
    expect(result.current.artifacts[0]!.messageId).toBe('m2');
    expect(result.current.artifacts[0]!.availability, '新核验落定后 fresh 重新权威').toBe('missing');
  });

  it.each([
    ['available', 'missing'],
    ['missing', 'available'],
  ] as const)('R3) 已核验快照的时效：%s → %s（过期重挂载必须重核验；时效内走共享快照）', async (before, after) => {
    vi.useFakeTimers();
    const taskId = `task-14-${before}`;
    const row = makeArtifact({ id: `row-${before}`, taskId, availability: before });
    const listArtifacts = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: [row] })
      .mockResolvedValueOnce({ ok: true, result: [{ ...row, availability: after }] });
    Object.assign(window, { clawwork: { listArtifacts } });

    const first = renderHook(() => useTaskArtifacts(taskId));
    await act(async () => {});
    expect(first.result.current.artifacts[0]!.availability).toBe(before);
    first.unmount();

    vi.setSystemTime(Date.now() + 19_000);
    const withinTtl = renderHook(() => useTaskArtifacts(taskId));
    await act(async () => {});
    expect(listArtifacts, '时效内重挂载要走共享快照，不许再查').toHaveBeenCalledTimes(1);
    expect(withinTtl.result.current.artifacts[0]!.availability).toBe(before);
    withinTtl.unmount();

    vi.setSystemTime(Date.now() + 2_000); // 累计 21s > 20s
    const expired = renderHook(() => useTaskArtifacts(taskId));
    await act(async () => {});
    expect(listArtifacts, '过期快照必须重新核验（在 ensureFetch 路径上，不轮询）').toHaveBeenCalledTimes(2);
    expect(expired.result.current.artifacts[0]!.availability, '磁盘状态已变，旧结论不许继续发布').toBe(after);
  });

  it('R3b) 仍为 unknown 时卸载 ⇒ 定时器必须真正清理（不靠"先变 available"兜底）', async () => {
    vi.useFakeTimers();
    const unknownRow = makeArtifact({ id: 'u2', taskId: 'task-15', availability: 'unknown' });
    const listArtifacts = vi.fn().mockResolvedValue({ ok: true, result: [unknownRow] });
    Object.assign(window, { clawwork: { listArtifacts } });

    const { unmount } = renderHook(() => useTaskArtifacts('task-15'));
    await act(async () => {});
    expect(listArtifacts).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(listArtifacts, '卸载后（仍是 unknown）定时器不许再触发').toHaveBeenCalledTimes(1);
  });

  it.each(['reply', 'throw'] as const)(
    'R4) 失败（%s）× 在途保存 ⇒ 恰好一次跟进；跟进失败且无新修订 ⇒ 不自旋',
    async (failure) => {
      const taskId = `task-16-${failure}`;
      const stored = makeArtifact({ id: 's1', taskId });
      useFileStore.setState({ artifacts: [stored] });
      const first = deferred<{ ok: boolean; result?: Artifact[]; error?: string }>();
      const second = deferred<{ ok: boolean; result?: Artifact[]; error?: string }>();
      const listArtifacts = vi
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise);
      Object.assign(window, { clawwork: { listArtifacts } });

      const { result } = renderHook(() => useTaskArtifacts(taskId));
      await act(async () => {
        useFileStore
          .getState()
          .upsertArtifact(makeArtifact({ id: 's2', taskId, createdAt: '2026-10-08T10:05:00.000Z' }));
      });
      await act(async () => {
        if (failure === 'reply') first.resolve({ ok: false, error: 'boom' });
        else first.reject(new Error('boom'));
      });

      expect(listArtifacts, '失败路径也必须看见"期间有修订"，恰好补一次跟进').toHaveBeenCalledTimes(2);

      await act(async () => {
        if (failure === 'reply') second.resolve({ ok: false, error: 'boom-again' });
        else second.reject(new Error('boom-again'));
      });
      await act(async () => {});

      expect(listArtifacts, '跟进失败且期间无新修订 ⇒ 不许形成重试循环').toHaveBeenCalledTimes(2);
      expect(result.current.pending).toBe(false);
      expect(result.current.artifacts.map((a) => a.id).sort()).toEqual(['s1', 's2']);
    },
  );

  it('R4b) 无保存变化的失败 ⇒ 只落定一次，不重试、不自旋', async () => {
    vi.useFakeTimers();
    const taskId = 'task-17';
    const stored = makeArtifact({ id: 's1', taskId });
    useFileStore.setState({ artifacts: [stored] });
    const listArtifacts = vi.fn().mockResolvedValue({ ok: false, error: 'boom' });
    Object.assign(window, { clawwork: { listArtifacts } });

    const { result } = renderHook(() => useTaskArtifacts(taskId));
    await act(async () => {});
    expect(listArtifacts).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(false);
    expect(result.current.artifacts.map((a) => a.id)).toEqual(['s1']);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(listArtifacts, '没有修订事件就不许自旋').toHaveBeenCalledTimes(1);
  });
});
