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
    pendingNewTask: { gatewayId: 'gw-1', agentId: 'rongying-content', tags: [PRESET_TAG, 'my-own-tag'] },
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
  it('⭐ 四步都做了：改选择 / 改待发任务 / 离开旧会话 / 回到对话', () => {
    const { unmount } = render(<Probe />);

    act(() => selectAgent('rongying-office'));

    expect(useUiStore.getState().selectedAgentByGateway['gw-1']).toBe('rongying-office');
    expect(useUiStore.getState().mainView).toBe('chat');
    expect(useTaskStore.getState().activeTaskId).toBeNull();
    expect(useTaskStore.getState().pendingNewTask).toMatchObject({
      gatewayId: 'gw-1',
      agentId: 'rongying-office',
    });
    unmount();
  });

  it('⭐ 顺带把旧助手的任务预设标签清掉（普通标签留着）', () => {
    const { unmount } = render(<Probe />);

    act(() => selectAgent('rongying-office'));

    expect(useTaskStore.getState().pendingNewTask?.tags).toEqual(['my-own-tag']);
    unmount();
  });

  it('选择会落盘（下次启动还认得）', () => {
    const { unmount } = render(<Probe />);

    act(() => selectAgent('rongying-office'));

    // ⚠️ 这是 **core** 的存储键（`packages/core/src/stores/ui-store.ts` 里的私有常量）。
    //    写死在这里是故意的：core 换键时这条要红，让人回来看一眼 ——
    //    比"只断言 store 内存里变了"要强，因为内存变了不等于活得比进程久。
    const raw = window.localStorage.getItem('cw:selectedAgentByGateway');
    expect(JSON.parse(raw ?? '{}')).toMatchObject({ 'gw-1': 'rongying-office' });
    unmount();
  });
});
