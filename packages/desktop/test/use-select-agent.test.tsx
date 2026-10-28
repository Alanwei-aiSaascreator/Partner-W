// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// 这个 hook 会顺手拉一次助手目录（网关 RPC）—— 单测里不该真的发请求
vi.mock('@/hooks/useGatewayBootstrap', () => ({ fetchAgentsForGateway: vi.fn() }));

import { useSelectAgent } from '../src/renderer/hooks/useSelectAgent';
import { useUiStore } from '../src/renderer/stores/uiStore';
import { useTaskStore } from '../src/renderer/stores/taskStore';
import { encodeAssistantTaskPresetTag } from '../src/renderer/lib/assistant-task-preset-tags';
import { ASSISTANT_TASK_PRESETS } from '../src/renderer/lib/assistant-task-presets';
import type { Task } from '@clawwork/shared';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let selectAgent!: (agentId: string) => void;

function Probe(): ReactElement {
  selectAgent = useSelectAgent();
  return <span />;
}

function render(ui: ReactElement): { unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const encoded = encodeAssistantTaskPresetTag(ASSISTANT_TASK_PRESETS[0]?.id ?? '');
if (!encoded) throw new Error('夹具：第一个任务预设 id 编不出标签');
const PRESET_TAG: string = encoded;

/**
 * 造一条真任务。`sessionKey` 里带着助手真身 —— 切回哪个助手靠它判归属
 * （`tasks` 表没有 `agent_id` 列，库里读回来的 `agentId` 是 undefined）。
 */
function task(id: string, agentId: string, updatedAt: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    sessionKey: `agent:${agentId}:clawwork:dev1:task:${id}`,
    sessionId: '',
    title: id,
    status: 'active',
    createdAt: updatedAt,
    updatedAt,
    tags: [],
    artifactDir: '',
    gatewayId: 'gw-1',
    ...extra,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  useUiStore.setState({
    gatewayInfoMap: { 'gw-1': { id: 'gw-1', name: 'Gateway 1' } },
    defaultGatewayId: 'gw-1',
    mainView: 'identity',
    selectedAgentByGateway: {},
  });
  useTaskStore.setState({
    activeTaskId: 'task-old',
    pendingNewTask: { gatewayId: 'gw-1', agentId: 'partner-w-content', tags: [PRESET_TAG, 'my-own-tag'] },
  });
});

/**
 * `useSelectAgent` —— **全应用唯一切助手的那条路**（2026-09-19 从 `LeftNav` 抽出）。
 *
 * 为什么要单独测：`LeftNav` 的「我的助手」和身份中心的「应用此画像」都走它，
 * 而 `identity-center.test.tsx` 把这一步**打桩**了。剩下这一段（四步到底做没做全）
 * 不测就没有任何东西守着 —— 而它最容易在"从 LeftNav 搬出来"时漏掉一步。
 */
describe('useSelectAgent', () => {
  it('⭐ 四步都做了：改选择 / 改待发任务 / 回到该助手的会话 / 走到对话页', () => {
    const { unmount } = render(<Probe />);
    // ⚠️ 这三条是**故意**放的：`content-最新` 更新更近（换了助手仍不许抢）、
    //    `office-归档` 更新更近（归档的也不算）⇒ 只有 `office-新` 该中选。
    useTaskStore.setState({
      tasks: [
        task('office-新', 'partner-w-office', '2026-09-20T00:00:00Z'),
        task('office-旧', 'partner-w-office', '2026-09-01T00:00:00Z'),
        task('content-最新', 'partner-w-content', '2026-09-25T00:00:00Z'),
        task('office-归档', 'partner-w-office', '2026-09-26T00:00:00Z', { status: 'archived' }),
      ],
    });

    act(() => selectAgent('partner-w-office'));

    expect(useUiStore.getState().selectedAgentByGateway['gw-1']).toBe('partner-w-office');
    expect(useUiStore.getState().mainView).toBe('chat');
    // ⭐ 2026-09-25 改了这里：原来断言 `null`（无条件离开旧会话 ⇒ 一片欢迎屏）。
    //    同事真机反馈「来回切换管家内容会丢失（不知道在哪里找到）」定性后改成"回到该助手的会话"。
    expect(useTaskStore.getState().activeTaskId).toBe('office-新');
    expect(useTaskStore.getState().pendingNewTask).toMatchObject({
      gatewayId: 'gw-1',
      agentId: 'partner-w-office',
    });
    unmount();
  });

  it('⭐ 这个助手还没有对话 ⇒ 离开旧会话、回欢迎屏（不是留着上一个人的）', () => {
    const { unmount } = render(<Probe />);
    useTaskStore.setState({ tasks: [task('content-的', 'partner-w-content', '2026-09-25T00:00:00Z')] });

    act(() => selectAgent('partner-w-office'));

    // `task-old` 是 beforeEach 里那段"上一个人的会话"——它必须被放下。
    expect(useTaskStore.getState().activeTaskId).toBeNull();
    unmount();
  });

  it('⭐ 顺带把旧助手的任务预设标签清掉（普通标签留着）', () => {
    const { unmount } = render(<Probe />);

    act(() => selectAgent('partner-w-office'));

    expect(useTaskStore.getState().pendingNewTask?.tags).toEqual(['my-own-tag']);
    unmount();
  });

  it('选择会落盘（下次启动还认得）', () => {
    const { unmount } = render(<Probe />);

    act(() => selectAgent('partner-w-office'));

    // ⚠️ 这是 **core** 的存储键（`packages/core/src/stores/ui-store.ts` 里的私有常量）。
    //    写死在这里是故意的：core 换键时这条要红，让人回来看一眼 ——
    //    比"只断言 store 内存里变了"要强，因为内存变了不等于活得比进程久。
    const raw = window.localStorage.getItem('cw:selectedAgentByGateway');
    expect(JSON.parse(raw ?? '{}')).toMatchObject({ 'gw-1': 'partner-w-office' });
    unmount();
  });
});
