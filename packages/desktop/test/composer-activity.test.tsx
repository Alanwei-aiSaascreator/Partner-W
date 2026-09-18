// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 输入框上方的活动条。
 *
 * 用户原话：「卡住好久突然跳出来，用户体验感很差」。
 * 正文不流式是上游的事（改不了），但"等待期界面上一片空白"是我们的 ——
 * 这条测的就是那段时间里**用户能不能看出它还在动**：
 * 秒数在走、说得出在干什么、等久了会说人话。
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && 'what' in opts ? `${key}(${String(opts.what)})` : opts && 'count' in opts ? `${key}(${opts.count})` : key,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SK = 'agent:main:clawwork:dev:task:t1';
const T0 = Date.parse('2026-09-18T10:00:00.000Z');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

async function setup(storeState: {
  processing?: boolean;
  startedAgoMs?: number;
  runPhase?: string | null;
  /** 网关 `item` 流的 `kind:"preamble"` —— 模型自述的进度。 */
  progressText?: string | null;
  toolCalls?: { id: string; name: string; status: string; title?: string; startedAt: string }[];
}): Promise<{ onCancel: ReturnType<typeof vi.fn> }> {
  const { useMessageStore } = await import('../src/renderer/stores/messageStore');
  const { default: ComposerActivity } = await import('../src/renderer/components/ComposerActivity');

  vi.useFakeTimers();
  vi.setSystemTime(T0);

  useMessageStore.setState({
    processingBySession: storeState.processing === false ? new Set() : new Set([SK]),
    turnStartedAtBySession: storeState.processing === false ? {} : { [SK]: T0 - (storeState.startedAgoMs ?? 0) },
    runPhaseBySession: { [SK]: storeState.runPhase ?? null },
    // ⚠️ 必须**无条件**设：`setState` 是浅合并，漏设的键会留上一个用例的值
    progressTextBySession: { [SK]: storeState.progressText ?? null },
    activeTurnBySession: storeState.toolCalls
      ? ({
          [SK]: { toolCalls: storeState.toolCalls },
        } as never)
      : ({} as never),
  });

  const onCancel = vi.fn();
  act(() => root.render((<ComposerActivity sessionKey={SK} onCancel={onCancel} />) as ReactElement));
  return { onCancel };
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);

describe('ComposerActivity —— 等待期别让用户以为它死了', () => {
  it('没在跑的时候整条不显示', async () => {
    await setup({ processing: false });
    expect(q('composer-activity')).toBeNull();
  });

  it('⭐ 在跑的时候显示**一直在走的秒数**（这是"它没死"最直接的证据）', async () => {
    await setup({ startedAgoMs: 12_400 });

    expect(q('composer-activity')).not.toBeNull();
    expect(q('composer-activity-elapsed')?.textContent).toBe('12.4s');

    // 再走 3 秒 ⇒ 数字要跟着动（不动就等于没在走）
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(q('composer-activity-elapsed')?.textContent).toBe('15.4s');
  });

  it('⭐ 正在跑的工具显示网关拼的人话标题（不是工具名）', async () => {
    await setup({
      startedAgoMs: 5_000,
      toolCalls: [
        {
          id: 'call_1',
          name: 'memory_search',
          status: 'running',
          title: 'memory_search 游戏 爆款 创作 内容',
          startedAt: new Date(T0).toISOString(),
        },
      ],
    });

    expect(q('composer-activity')?.getAttribute('data-status')).toBe('running-tool');
    expect(q('composer-activity')?.textContent).toContain('memory_search 游戏 爆款 创作 内容');
  });

  it('拿不到工具标题时退回工具名（不能显示空白）', async () => {
    await setup({
      toolCalls: [{ id: 'call_1', name: 'ls', status: 'running', startedAt: new Date(T0).toISOString() }],
    });

    expect(q('composer-activity')?.textContent).toContain('ls');
  });

  it('还没开跑工具时显示网关报的准备阶段', async () => {
    await setup({ runPhase: 'preparing_workspace' });

    expect(q('composer-activity')?.textContent).toContain('chatInput.runPhase.preparing_workspace');
  });

  it('⭐ 等越久，俏皮话越自嘲（30s / 90s 两档边界）', async () => {
    await setup({ startedAgoMs: 0 });
    expect(q('composer-activity-quip')?.textContent).toContain('chatInput.waiting.line.fresh');

    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });
    expect(q('composer-activity-quip')?.textContent).toContain('chatInput.waiting.line.long');

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(q('composer-activity-quip')?.textContent).toContain('chatInput.waiting.line.veryLong');
  });

  it('⭐ 等待期能就地取消（用户这时唯一想做的事，别让他去别处找）', async () => {
    const { onCancel } = await setup({ startedAgoMs: 3_000 });

    await act(async () => {
      (q('composer-activity-cancel') as HTMLButtonElement).click();
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

/**
 * 模型自述的进度（网关 `item` 流的 `kind:"preamble"`）。
 *
 * 这是"卡住好久突然跳出来"那段时间里**唯一在动的东西** —— 正文本就不流式，
 * 而网关其实一直在报模型自己的进度叙述，我们此前整块丢掉了。
 */
describe('模型自述进度', () => {
  it('⭐ 没有正在跑的工具时，主行显示模型自述的进度', async () => {
    await setup({ progressText: '正在核对第三章的数字' });

    expect(q('composer-activity')!.textContent).toContain('chatInput.waiting.modelProgress(正在核对第三章的数字)');
  });

  it('有工具在跑时工具优先（模型的话不抢它）', async () => {
    await setup({
      progressText: '正在核对第三章的数字',
      toolCalls: [{ id: 'c1', name: 'ls', status: 'running', title: 'ls 目录', startedAt: new Date(T0).toISOString() }],
    });

    const text = q('composer-activity')!.textContent ?? '';
    expect(text).toContain('chatInput.waiting.runningTool(ls 目录)');
    expect(text, '工具是更具体的事实，模型的话不该盖过它').not.toContain('正在核对第三章的数字');
  });

  it('模型进度优先于网关的粗粒度阶段（那只是"在调用模型"这种级别）', async () => {
    await setup({ progressText: '正在核对第三章的数字', runPhase: 'starting_model' });

    const text = q('composer-activity')!.textContent ?? '';
    expect(text).toContain('modelProgress(正在核对第三章的数字)');
    expect(text).not.toContain('chatInput.runPhase.starting_model');
  });

  it('没有进度时退回原来的链（不显示空壳）', async () => {
    await setup({ runPhase: 'starting_model' });

    const text = q('composer-activity')!.textContent ?? '';
    expect(text).toContain('chatInput.runPhase.starting_model');
    expect(text).not.toContain('modelProgress');
  });
});
