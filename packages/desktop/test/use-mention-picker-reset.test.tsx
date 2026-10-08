// @vitest-environment jsdom

/**
 * `useMentionPicker` 的 **@ 选择清理边界**（2026-10-07 · 质量战役区 3 · 问题 3）。
 *
 * 原实现 `useEffect(..., [activeTaskId])` **无条件清** —— 发送时那次 `pending → 真任务`
 * （`null → task-1`）也被当成"换了对话"，发送失败时用户刚 @ 的任务/产物/助手当场没了。
 * 判据换成与输入框其余会话级状态同一份纯函数
 * （`shouldResetComposerOnConversationChange`：null→X 不清 / A→B 清 / A→null 清）。
 */

import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@clawwork/shared';

const mocks = vi.hoisted(() => ({ activeTaskId: 'task-A' as string | null }));

vi.mock('../src/renderer/stores/taskStore', () => ({
  useTaskStore: <T,>(selector: (s: { activeTaskId: string | null }) => T) => selector(mocks),
}));
const fileState = { artifacts: [] as unknown[] };
vi.mock('../src/renderer/stores/fileStore', () => ({
  useFileStore: Object.assign(
    <T,>(selector?: (s: typeof fileState) => T) => (selector ? selector(fileState) : fileState),
    { getState: () => fileState },
  ),
}));

import { useMentionPicker } from '../src/renderer/components/ChatInput/useMentionPicker';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MentionApi = ReturnType<typeof useMentionPicker>;
let latest: MentionApi | null = null;

function Harness() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  latest = useMentionPicker({ textareaRef, hasContextSources: false, loadLocalFiles: async () => [] });
  return (
    <>
      <textarea ref={textareaRef} />
      <div data-testid="tasks">{latest.selectedTasks.length}</div>
      <div data-testid="artifacts">{latest.selectedArtifacts.length}</div>
      <div data-testid="local">{latest.selectedLocalFiles.length}</div>
      <div data-testid="agents">{latest.selectedAgents.length}</div>
    </>
  );
}

function render(): { container: HTMLDivElement; rerender: () => void; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const doRender = () => act(() => root.render(<Harness />));
  doRender();
  return {
    container,
    rerender: doRender,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const taskMention = { id: 'task-2', title: 'Task 2' } as Task;

function selectSomething(): void {
  act(() => {
    latest!.setSelectedTasks([taskMention]);
    latest!.setSelectedArtifacts([{ id: 'a-1', name: 'x.pptx' } as never]);
    latest!.setSelectedLocalFiles([]);
    latest!.setSelectedAgents([]);
  });
}

function counts(container: HTMLElement): { tasks: string; artifacts: string } {
  return {
    tasks: container.querySelector('[data-testid="tasks"]')!.textContent!,
    artifacts: container.querySelector('[data-testid="artifacts"]')!.textContent!,
  };
}

beforeEach(() => {
  mocks.activeTaskId = 'task-A';
  latest = null;
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useMentionPicker 的 @ 选择清理边界（质量战役区 3）', () => {
  it('⭐ null → task-B（发送把待发任务提交成真任务）⇒ **不清**：发送失败不丢 @ 引用', () => {
    mocks.activeTaskId = null;
    const view = render();
    selectSomething();
    expect(counts(view.container).tasks).toBe('1');

    mocks.activeTaskId = 'task-B';
    view.rerender();

    expect(counts(view.container).tasks, '刚发出去的那一轮，@ 选择必须还在').toBe('1');
    expect(counts(view.container).artifacts).toBe('1');
    view.unmount();
  });

  it('A → B（真的换了一段已有对话）⇒ 清', () => {
    const view = render();
    selectSomething();
    expect(counts(view.container).tasks).toBe('1');

    mocks.activeTaskId = 'task-B';
    view.rerender();

    expect(counts(view.container).tasks).toBe('0');
    expect(counts(view.container).artifacts).toBe('0');
    view.unmount();
  });

  it('A → null（新建对话 / 回欢迎屏）⇒ 清', () => {
    const view = render();
    selectSomething();
    expect(counts(view.container).tasks).toBe('1');

    mocks.activeTaskId = null;
    view.rerender();

    expect(counts(view.container).tasks).toBe('0');
    expect(counts(view.container).artifacts).toBe('0');
    view.unmount();
  });

  it('A → A（原地重渲染）⇒ 不清', () => {
    const view = render();
    selectSomething();

    view.rerender();

    expect(counts(view.container).tasks).toBe('1');
    view.unmount();
  });
});
