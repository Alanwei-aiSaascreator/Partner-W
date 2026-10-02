// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 会话内的**运行行**（`TurnActivityRow`）。
 *
 * 用户（老板）要求："对话模型回复期间可视化交互体验不好，照抄主流智能体" ——
 * 主流的做法是把活动指示放在**回复位**。本行就是那一格：
 * 等待期可见（跳动条 + 正在干什么 + 已等待），没有活动时不渲染。
 *
 * 数据源与输入框上方的 ComposerActivity **共用** `useTurnActivity`（唯一出口），
 * 这里验证的就是这个共用面在会话内的表现。
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && 'what' in opts
        ? `${key}(${String(opts.what)})`
        : opts && 'count' in opts
          ? `${key}(${opts.count})`
          : opts && 'attempt' in opts
            ? `${key}(${opts.attempt}/${opts.maxAttempts})`
            : key,
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
  progressText?: string | null;
  toolCalls?: { id: string; name: string; status: string; title?: string; startedAt: string }[];
}): Promise<void> {
  const { useMessageStore } = await import('../src/renderer/stores/messageStore');
  const { default: TurnActivityRow } = await import('../src/renderer/components/TurnActivityRow');

  vi.useFakeTimers();
  vi.setSystemTime(T0);

  useMessageStore.setState({
    processingBySession: storeState.processing === false ? new Set() : new Set([SK]),
    turnStartedAtBySession: storeState.processing === false ? {} : { [SK]: T0 - (storeState.startedAgoMs ?? 0) },
    runPhaseBySession: { [SK]: null },
    runRetryBySession: {},
    // ⚠️ 必须**无条件**设：`setState` 是浅合并，漏设的键会留上一个用例的值
    progressTextBySession: { [SK]: storeState.progressText ?? null },
    compactingBySession: {},
    activeTurnBySession: storeState.toolCalls
      ? ({ [SK]: { toolCalls: storeState.toolCalls } } as never)
      : ({} as never),
  });

  await act(async () => {
    root.render((<TurnActivityRow sessionKey={SK} />) as ReactElement);
  });
}

/** 主行文案（`data-testid="turn-activity-row"` 里 span 的文本）。 */
function headlineText(): string {
  const row = container.querySelector('[data-testid="turn-activity-row"]');
  expect(row).toBeTruthy();
  return row!.querySelector('span')!.textContent ?? '';
}

describe('TurnActivityRow（会话内运行行）', () => {
  it('没有活动轮次 → 整行不渲染', async () => {
    await setup({ processing: false });
    expect(container.querySelector('[data-testid="turn-activity-row"]')).toBeNull();
  });

  it('等待期（什么都没到）→ 显示泛化"处理中"主行与已等待时长', async () => {
    const { formatElapsed } = await import('../src/renderer/lib/waiting-copy');
    await setup({ startedAgoMs: 65_000 });
    expect(headlineText()).toBe('chatInput.waiting.working');
    const elapsed = container.querySelector('[data-testid="turn-activity-row-elapsed"]');
    expect(elapsed?.textContent).toBe(formatElapsed(65_000));
  });

  it('有正在跑的工具 → 主行说得出工具名（比泛化文案有用）', async () => {
    await setup({
      startedAgoMs: 1_000,
      toolCalls: [
        {
          id: 'c1',
          name: 'exec',
          status: 'running',
          title: '正在执行 deck-layout',
          startedAt: new Date(T0).toISOString(),
        },
      ],
    });
    expect(headlineText()).toBe('chatInput.waiting.runningTool(正在执行 deck-layout)');
  });

  it('模型自述进度可见（正文不流式时的唯一"在动"信号）', async () => {
    await setup({ startedAgoMs: 2_000, progressText: '正在整理第 3 页' });
    expect(headlineText()).toBe('chatInput.waiting.modelProgress(正在整理第 3 页)');
  });
});
