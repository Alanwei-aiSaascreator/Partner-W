// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zh from '../src/renderer/i18n/locales/zh.json';

const translationMode = vi.hoisted(() => ({ localized: false }));

/**
 * 输入框上方的活动条。
 *
 * 用户原话：「卡住好久突然跳出来，用户体验感很差」。
 * 正文不流式是上游的事（改不了），但"等待期界面上一片空白"是我们的 ——
 * 验证真实收到的动作与本地等待计时分别可见；秒数不是后台心跳。
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (translationMode.localized && key === 'chatInput.waiting.writing') {
        return zh.chatInput.waiting.writing.replace('{{count}}', String(opts?.count));
      }
      if (translationMode.localized && key.startsWith('chatInput.waiting.line.')) {
        return zh.chatInput.waiting.line[
          key.slice('chatInput.waiting.line.'.length) as keyof typeof zh.chatInput.waiting.line
        ];
      }
      return opts && 'what' in opts
        ? `${key}(${String(opts.what)})`
        : opts && 'count' in opts
          ? `${key}(${opts.count})`
          : opts && 'attempt' in opts
            ? `${key}(${opts.attempt}/${opts.maxAttempts})`
            : key;
    },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SK = 'agent:main:clawwork:dev:task:t1';
const T0 = Date.parse('2026-09-18T10:00:00.000Z');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  translationMode.localized = false;
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
  /** 重试到第几次了（`run_status` 的 `phase:"retrying"` 才带）。 */
  runRetry?: { attempt: number; maxAttempts: number };
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
    runRetryBySession: storeState.runRetry ? { [SK]: storeState.runRetry } : {},
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
  it.each([['error'], ['done', 'error']])(
    'counts ended tool calls without claiming success: %j',
    async (...statuses) => {
      translationMode.localized = true;
      await setup({
        toolCalls: statuses.map((status, index) => ({
          id: `ended-${index}`,
          name: 'web_search',
          status,
          startedAt: new Date(T0).toISOString(),
        })),
      });
      const text = q('composer-activity')?.textContent ?? '';
      expect(text).toContain(`${statuses.length} 次工具调用已结束`);
      expect(text).not.toContain('已完成');
      expect(text).not.toContain('正在写');
    },
  );

  it('shows neutral waiting copy as elapsed time advances without a new gateway update', async () => {
    translationMode.localized = true;
    await setup({ startedAgoMs: 31_000 });
    expect(q('composer-activity-quip')?.textContent).toContain('等待响应');
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(q('composer-activity-quip')?.textContent).toContain('等待响应');
    expect(q('composer-activity-elapsed')?.textContent).toBe('91.0s');
  });

  it.each([
    ['web_search', 'search'],
    ['image_generate', 'generateImage'],
    ['video_generate', 'generateVideo'],
  ])('shows a readable activity for %s when the gateway omits its title', async (name, kind) => {
    await setup({ toolCalls: [{ id: 'activity', name, status: 'running', startedAt: new Date(T0).toISOString() }] });
    expect(q('composer-activity')?.textContent).toContain(`toolActivity.actions.${kind}`);
    expect(q('composer-activity')?.textContent).not.toContain(`(${name})`);
  });

  it('没在跑的时候整条不显示', async () => {
    await setup({ processing: false });
    expect(q('composer-activity')).toBeNull();
  });

  it('在等待时显示本地计算的已等待时长', async () => {
    await setup({ startedAgoMs: 12_400 });

    expect(q('composer-activity')).not.toBeNull();
    expect(q('composer-activity-elapsed')?.textContent).toBe('12.4s');

    // 本地再经过 3 秒，等待时长随之增加；不依赖后台状态事件。
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
    // 图12（2026-10-06）：人话部分照显，开头的原始工具名不上屏。
    expect(q('composer-activity')?.textContent).toContain('游戏 爆款 创作 内容');
    expect(q('composer-activity')?.textContent).not.toContain('memory_search');
  });

  it('unknown tools fall back to the productized generic label (图12：原始工具名不上屏)', async () => {
    await setup({
      toolCalls: [{ id: 'call_1', name: 'unknown_tool', status: 'running', startedAt: new Date(T0).toISOString() }],
    });

    expect(q('composer-activity')?.textContent).toContain('toolActivity.actions.other');
    expect(q('composer-activity')?.textContent).not.toContain('unknown_tool');
  });

  it('还没开跑工具时显示网关报的准备阶段', async () => {
    await setup({ runPhase: 'preparing_workspace' });

    expect(q('composer-activity')?.textContent).toContain('chatInput.runPhase.preparing_workspace');
  });

  it('按已等待时长选择中性提示（30s / 90s 两档边界）', async () => {
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
 * 多智能体 / 会议任务：真正在跑的是 performer 会话（区1 体检 P2-6）。
 *
 * 活动条原来只认 `activeTask.sessionKey`（主会话）—— performer 在跑时整条不显示，
 * 而正文里的 `TurnActivityRow` 照样在动：同一条链两种观感，用户以为输入框这边卡死了。
 */
describe('多智能体任务：主会话没跑、performer 在跑', () => {
  const PERFORMER = 'agent:main:clawwork:dev:task:t1:performer:1';

  async function renderComposer(state: {
    processing: string[];
    startedAgoMsFor?: Record<string, number>;
    toolCallsFor?: Record<string, { id: string; name: string; status: string; title?: string; startedAt: string }[]>;
  }) {
    const { useMessageStore } = await import('../src/renderer/stores/messageStore');
    const { default: ComposerActivity } = await import('../src/renderer/components/ComposerActivity');

    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const startedAt: Record<string, number> = {};
    for (const [key, ago] of Object.entries(state.startedAgoMsFor ?? {})) startedAt[key] = T0 - ago;
    const turns: Record<string, unknown> = {};
    for (const [key, calls] of Object.entries(state.toolCallsFor ?? {})) turns[key] = { toolCalls: calls };
    useMessageStore.setState({
      processingBySession: new Set(state.processing),
      turnStartedAtBySession: startedAt,
      runPhaseBySession: {},
      runRetryBySession: {},
      progressTextBySession: {},
      compactingBySession: {},
      activeTurnBySession: turns as never,
    });
    act(() =>
      root.render(
        (<ComposerActivity sessionKey={SK} sessionKeys={[SK, PERFORMER]} onCancel={vi.fn()} />) as ReactElement,
      ),
    );
  }

  it('⭐ 只有 performer 在跑时，活动条显示它的真实活动（不是整条消失）', async () => {
    await renderComposer({
      processing: [PERFORMER],
      startedAgoMsFor: { [PERFORMER]: 12_000 },
      toolCallsFor: {
        [PERFORMER]: [
          {
            id: 'c1',
            name: 'exec',
            status: 'running',
            title: '正在执行 deck-layout',
            startedAt: new Date(T0).toISOString(),
          },
        ],
      },
    });

    expect(q('composer-activity')).not.toBeNull();
    expect(q('composer-activity')?.getAttribute('data-status')).toBe('running-tool');
    expect(q('composer-activity')?.textContent).toContain('chatInput.waiting.runningTool(正在执行 deck-layout)');
    // 计时也来自真正在跑的那个会话（本地等待计时，不是猜的）
    expect(q('composer-activity-elapsed')?.textContent).toBe('12.0s');
  });

  it('主会话在跑时仍然只认主会话（不跳到 performer 身上）', async () => {
    await renderComposer({
      processing: [SK, PERFORMER],
      startedAgoMsFor: { [SK]: 3_000, [PERFORMER]: 90_000 },
      toolCallsFor: {
        [SK]: [{ id: 'm1', name: 'ls', status: 'running', title: 'ls 工作区', startedAt: new Date(T0).toISOString() }],
        [PERFORMER]: [
          {
            id: 'p1',
            name: 'exec',
            status: 'running',
            title: '正在执行 deck-layout',
            startedAt: new Date(T0).toISOString(),
          },
        ],
      },
    });

    const text = q('composer-activity')?.textContent ?? '';
    expect(text).toContain('chatInput.waiting.runningTool(ls 工作区)');
    expect(text).not.toContain('deck-layout');
    expect(q('composer-activity-elapsed')?.textContent).toBe('3.0s');
  });

  it('谁都没在跑 ⇒ 整条不显示（候选列表再长也不造假）', async () => {
    await renderComposer({ processing: [] });

    expect(q('composer-activity')).toBeNull();
  });
});

/**
 * ⭐ **重试相位**（`run_status` 的 `phase:"retrying"`）—— 我们此前不认它。
 *
 * 网关在重试时会带上**次数**（"第 2/4 次"）—— 那比"正在重试…"有用得多：
 * 它同时回答了"在动吗"和"还要等几轮"。次数是**跟着相位**来的，相位一换就必须收掉。
 */
describe('重试相位要说得出"第几次"', () => {
  it('⭐ 有次数 ⇒ 文案带上 `attempt`/`maxAttempts`', async () => {
    await setup({ runPhase: 'retrying', runRetry: { attempt: 2, maxAttempts: 4 } });

    const text = q('composer-activity')?.textContent ?? '';
    expect(text).toContain('chatInput.runPhase.retrying');
    expect(text, '次数是这句话的重点，不能丢').toContain('2');
    expect(text).toContain('4');
  });

  it('⚠️ 认得出这个相位（不再走"认不出的相位"那条泛化路）', async () => {
    await setup({ runPhase: 'retrying', runRetry: { attempt: 1, maxAttempts: 3 } });

    expect(q('composer-activity')?.textContent).not.toContain('chatInput.runPhase.unknown');
  });

  it('⚠️ 相位是 `retrying` 但**没有次数**（畸形帧）⇒ 退回泛化文案，不显示"第 / 次"', async () => {
    await setup({ runPhase: 'retrying' });

    const text = q('composer-activity')?.textContent ?? '';
    expect(text).not.toContain('chatInput.runPhase.retrying');
    expect(text).toContain('chatInput.runPhase.unknown');
  });

  it('⚠️ **次数粘不到别的相位上**', async () => {
    await setup({ runPhase: 'preparing_workspace' });

    expect(q('composer-activity')?.textContent).not.toContain('chatInput.runPhase.retrying');
  });
});

/**
 * 「进行中」反馈的**四个相位**（§12）—— 驱动**真实的 store 动作**，不是手塞状态。
 *
 * 为什么单开一组：上面那些用例都是把 `toolCalls` 直接摆好再断言渲染，
 * 覆盖的是"给定状态长什么样"；而真正会坏的是**相位之间的转换** ——
 * 起跑之后收不掉（转圈永远不停）、失败之后还显示"正在执行"（在说谎）、
 * 那一轮取消了还挂着。这三种坏法在"手塞状态"的写法里**根本表达不出来**。
 *
 * ⚠️ 这条链正是"卡住好久突然跳出来"那 15 秒的可见性来源：`item` 流开工 → 活动条出现；
 *    跑完/失败/取消 → 收掉。所以每个相位都对着一个变异。
 */
describe('进行中反馈的四个相位（§7/§12）', () => {
  const TID = 't1';

  async function mountLive(initial: { processing?: boolean } = {}) {
    const { useMessageStore } = await import('../src/renderer/stores/messageStore');
    const { default: ComposerActivity } = await import('../src/renderer/components/ComposerActivity');

    vi.useFakeTimers();
    vi.setSystemTime(T0);
    useMessageStore.setState({
      processingBySession: initial.processing === false ? new Set() : new Set([SK]),
      turnStartedAtBySession: { [SK]: T0 },
      runPhaseBySession: { [SK]: null },
      progressTextBySession: { [SK]: null },
      compactingBySession: {},
      activeTurnBySession: {
        [SK]: {
          id: 'turn-1',
          streamingText: '',
          streamingThinking: '',
          toolCalls: [],
          finalized: false,
          content: '',
          timestamp: new Date(T0).toISOString(),
        },
      } as never,
    });

    const onCancel = vi.fn();
    act(() => root.render((<ComposerActivity sessionKey={SK} onCancel={onCancel} />) as ReactElement));

    const store = useMessageStore.getState();
    const upsert = (status: 'running' | 'done' | 'error') =>
      act(() => {
        store.upsertToolCall(SK, TID, {
          id: 'call_mem',
          name: 'memory_search',
          status,
          title: 'memory_search 游戏 爆款',
          startedAt: new Date(T0).toISOString(),
          ...(status === 'running' ? {} : { completedAt: new Date(T0 + 1000).toISOString() }),
        });
      });

    return { store, onCancel, upsert };
  }

  it('⭐ 起跑 ⇒ 显示"正在执行 XXX"（这就是那几秒里"它没死"的证据）', async () => {
    const { upsert } = await mountLive();

    upsert('running');

    expect(q('composer-activity')?.getAttribute('data-status')).toBe('running-tool');
    expect(q('composer-activity')?.textContent).toContain('游戏 爆款');
  });

  it('⭐ 跑完 ⇒ **收掉**（不能永远转圈；但那一轮还没结束，活动条本身要留着）', async () => {
    const { upsert } = await mountLive();
    upsert('running');

    upsert('done');

    expect(q('composer-activity'), '这一轮还在跑，整条不该消失').not.toBeNull();
    expect(q('composer-activity')?.getAttribute('data-status'), '跑完了还说"正在执行"就是撒谎').not.toBe(
      'running-tool',
    );
    expect(q('composer-activity')?.textContent).not.toContain('游戏 爆款');
  });

  it('⭐ 失败 ⇒ 也**收掉**（报错了还说在跑，与 `status:"blocked"` 那条是同一类谎）', async () => {
    const { upsert } = await mountLive();
    upsert('running');

    upsert('error');

    expect(q('composer-activity')?.getAttribute('data-status')).not.toBe('running-tool');
    expect(q('composer-activity')?.textContent).not.toContain('游戏 爆款');
  });

  it('⭐ 取消 ⇒ 整条**收掉**（那一轮已经作废了，不该还挂着一条"正在跑"）', async () => {
    const { store, upsert } = await mountLive();
    upsert('running');
    expect(q('composer-activity')).not.toBeNull();

    // 复刻真实的取消链路（`handleAbort`）：关忙 + 清掉这一轮
    act(() => {
      store.setProcessing(SK, false);
      store.clearActiveTurn(SK);
    });

    expect(q('composer-activity'), '取消了还留着活动条，用户会以为没取消成功').toBeNull();
  });

  it('连跑两个工具 ⇒ 显示**正在跑的那个**，收一个不会把另一个也收掉', async () => {
    const { store, upsert } = await mountLive();
    upsert('running');

    act(() => {
      store.upsertToolCall(SK, TID, {
        id: 'call_exec',
        name: 'exec',
        status: 'running',
        title: 'exec npm test',
        startedAt: new Date(T0).toISOString(),
      });
    });
    expect(q('composer-activity')?.textContent).toContain('npm test');

    upsert('done'); // 收掉 memory_search，exec 还在跑

    expect(q('composer-activity')?.getAttribute('data-status')).toBe('running-tool');
    expect(q('composer-activity')?.textContent).toContain('npm test');
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

  it('⭐⭐ A2：等在批准时说的是「等待批准」，**不是**「执行中」', async () => {
    await setup({
      toolCalls: [
        {
          id: 'call_1',
          name: 'exec',
          status: 'awaitingApproval',
          title: 'npm view diver name version description',
          startedAt: new Date(T0).toISOString(),
        },
      ],
    });

    const text = q('composer-activity')!.textContent ?? '';
    expect(text).toContain('chatInput.waiting.awaitingApproval(npm view diver name version description)');
    // ⚠️ 复用 `runningTool` 就等于什么都没说 —— 这条就是防那个。
    expect(text).not.toContain('chatInput.waiting.runningTool');
  });

  it('⭐⭐ A2：它**排在最前面** —— 正在跑的工具也要让位（它才是"为什么没进展"的答案）', async () => {
    await setup({
      toolCalls: [
        {
          id: 'call_1',
          name: 'memory_search',
          status: 'running',
          title: 'memory_search 游戏',
          startedAt: new Date(T0).toISOString(),
        },
        {
          id: 'call_2',
          name: 'exec',
          status: 'awaitingApproval',
          title: 'rm -rf /tmp/x',
          startedAt: new Date(T0).toISOString(),
        },
      ],
    });

    const text = q('composer-activity')!.textContent ?? '';
    /*
      ⚠️ 区1 体检 P3-8：POSIX 绝对路径现在与 Windows 盘符路径**同一套遮蔽**（`/tmp/x` → `x`）——
      活动条只是"此刻在干什么"的环境提示，本地目录结构不上屏；
      真正要用户做决定的那个面是 `ApprovalDialog`（它显示 `request.command` 原文）。
    */
    expect(text).toContain('chatInput.waiting.awaitingApproval(rm -rf x)');
    expect(text, '被"执行中"抢了头条就等于没说').not.toContain('chatInput.waiting.runningTool');
  });
});
