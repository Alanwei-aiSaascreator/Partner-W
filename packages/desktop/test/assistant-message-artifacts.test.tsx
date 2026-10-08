// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact, Message } from '@clawwork/shared';
import i18n from '../src/renderer/i18n';

// 与 assistant-block-stability 同款：framer-motion 换成"原样渲染"。
vi.mock('framer-motion', async () => {
  const React = await import('react');
  const MOTION_ONLY = new Set([
    'initial',
    'animate',
    'exit',
    'transition',
    'variants',
    'whileHover',
    'whileTap',
    'whileInView',
    'layout',
    'layoutId',
  ]);
  const cache = new Map<string, unknown>();
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        const cached = cache.get(tag);
        if (cached) return cached;
        const component = React.forwardRef<HTMLElement, Record<string, unknown>>((props, ref) => {
          const { children, ...rest } = props;
          const clean = Object.fromEntries(Object.entries(rest).filter(([key]) => !MOTION_ONLY.has(key)));
          return React.createElement(tag, { ...clean, ref }, children as React.ReactNode);
        });
        cache.set(tag, component);
        return component;
      },
    },
  );
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion,
    useReducedMotion: () => false,
  };
});

import AssistantBlock from '../src/renderer/components/AssistantBlock';
import { useFileStore } from '../src/renderer/stores/fileStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * T8 接线回归（2026-10-08 · Codex 总审闭环令 §4.1）：
 * 聊天内产物卡接**真源**（fileStore + listArtifacts，任务级水合），**先对完整任务归并、
 * 后按 messageId 分发**；水合/交付期间不得先闪「无回答 → 重新尝试」；打开走既有链。
 * （`message.artifacts` 在桌面链路上恒为空 —— 本测试全程不给它任何值。）
 */
const identity = { agentName: '内容助手', agentRoleLabel: '内容', localAvatarUrl: 'file:///avatar.png' };

function artifactOf(partial: Partial<Artifact>): Artifact {
  return {
    id: 'a-1',
    taskId: 'task-a',
    messageId: 'm-1',
    type: 'file',
    name: '报告-3f2a1b8c.pptx',
    filePath: 'S:/ws/报告-3f2a1b8c.pptx',
    localPath: '报告-3f2a1b8c.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    size: 1024,
    createdAt: '2026-10-08T00:00:00.000Z',
    availability: 'available',
    ...partial,
  };
}

function messageOf(partial: Partial<Message>): Message {
  return {
    id: 'm-1',
    taskId: 'task-a',
    role: 'assistant',
    content: '看结果',
    artifacts: [],
    toolCalls: [],
    timestamp: '2026-10-08T00:00:00.000Z',
    ...partial,
  };
}

const cleanups: Array<() => void> = [];

function render(ui: ReactElement): {
  container: HTMLDivElement;
  rerender: (next: ReactElement) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  const unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  cleanups.push(unmount);
  return { container, rerender: (next) => act(() => root.render(next)), unmount };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const cardCount = (container: HTMLElement): number =>
  container.querySelectorAll('[data-testid="artifact-card"]').length;

let listArtifacts: ReturnType<typeof vi.fn>;

beforeEach(() => {
  listArtifacts = vi.fn().mockResolvedValue({ ok: true, result: [] });
  Object.defineProperty(window, 'clawwork', {
    configurable: true,
    value: {
      listArtifacts,
      openArtifactFile: vi.fn().mockResolvedValue({ ok: true }),
      showArtifactInFolder: vi.fn().mockResolvedValue({ ok: true }),
      saveArtifactAs: vi.fn().mockResolvedValue({ ok: true, result: { status: 'cancelled' } }),
      readArtifactThumbnail: vi.fn().mockResolvedValue({ ok: false }),
    },
  });
  useFileStore.setState({ artifacts: [] });
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  document.body.innerHTML = '';
});

describe('聊天内产物卡（T8 接线）', () => {
  it('store 里同族两条（同消息）⇒ 只出最新一版的卡', async () => {
    useFileStore.setState({
      artifacts: [
        artifactOf({
          id: 'old',
          name: '报告-3f2a1b8c.pptx',
          filePath: 'S:/ws/报告-3f2a1b8c.pptx',
          localPath: '报告-3f2a1b8c.pptx',
          createdAt: '2026-10-08T00:00:00.000Z',
        }),
        artifactOf({
          id: 'new',
          name: '报告-7c4d2a90.pptx',
          filePath: 'S:/ws/报告-7c4d2a90.pptx',
          localPath: '报告-7c4d2a90.pptx',
          createdAt: '2026-10-08T01:00:00.000Z',
        }),
      ],
    });
    const view = render(<AssistantBlock state="finalized" message={messageOf({})} identity={identity} />);
    await flush();

    expect(cardCount(view.container)).toBe(1);
    expect(view.container.textContent).toContain('报告-7c4d2a90.pptx');
    expect(view.container.textContent).not.toContain('报告-3f2a1b8c.pptx');
    view.unmount();
  });

  it('⭐ 跨消息同族：先对完整任务归并再分发 —— 旧版所在消息不出卡，新版所在消息出卡', async () => {
    useFileStore.setState({
      artifacts: [
        artifactOf({
          id: 'old',
          taskId: 'task-b',
          messageId: 'm-1',
          name: '报告-3f2a1b8c.pptx',
          filePath: 'S:/ws/报告-3f2a1b8c.pptx',
          createdAt: '2026-10-08T00:00:00.000Z',
        }),
        artifactOf({
          id: 'new',
          taskId: 'task-b',
          messageId: 'm-2',
          name: '报告-7c4d2a90.pptx',
          filePath: 'S:/ws/报告-7c4d2a90.pptx',
          createdAt: '2026-10-08T02:00:00.000Z',
        }),
      ],
    });

    const older = render(
      <AssistantBlock
        state="finalized"
        message={messageOf({ id: 'm-1', taskId: 'task-b', content: '第一版' })}
        identity={identity}
      />,
    );
    await flush();
    expect(cardCount(older.container), '旧版不得以 current 的身份出现在 m1 上').toBe(0);
    older.unmount();

    const newer = render(
      <AssistantBlock
        state="finalized"
        message={messageOf({ id: 'm-2', taskId: 'task-b', content: '第二版' })}
        identity={identity}
      />,
    );
    await flush();
    expect(cardCount(newer.container)).toBe(1);
    expect(newer.container.textContent).toContain('报告-7c4d2a90.pptx');
    newer.unmount();
  });

  it('别的 messageId 的产物不串（隔离）', async () => {
    useFileStore.setState({
      artifacts: [artifactOf({ id: 'other', taskId: 'task-c', messageId: 'm-OTHER', name: '别处的文件.pptx' })],
    });
    const view = render(
      <AssistantBlock state="finalized" message={messageOf({ taskId: 'task-c' })} identity={identity} />,
    );
    await flush();
    expect(cardCount(view.container)).toBe(0);
    view.unmount();
  });

  it('水合：store 冷启动为空 ⇒ listArtifacts(message.taskId) 拉回后出卡', async () => {
    listArtifacts.mockResolvedValue({ ok: true, result: [artifactOf({ id: 'h-1', taskId: 'task-h' })] });
    const view = render(
      <AssistantBlock state="finalized" message={messageOf({ taskId: 'task-h' })} identity={identity} />,
    );
    expect(cardCount(view.container), '水合未回时不出卡（也不闪失败态）').toBe(0);
    await flush();

    expect(listArtifacts).toHaveBeenCalledWith('task-h');
    expect(cardCount(view.container)).toBe(1);
    view.unmount();
  });

  it('打开走既有链：openArtifactFile(id, taskId)', async () => {
    useFileStore.setState({ artifacts: [artifactOf({ id: 'a-1', taskId: 'task-o' })] });
    const view = render(
      <AssistantBlock state="finalized" message={messageOf({ taskId: 'task-o' })} identity={identity} />,
    );
    await flush();

    const openButton = view.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${i18n.t('artifactCard.open')}"]`,
    );
    expect(openButton).not.toBeNull();
    await act(async () => {
      openButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(window.clawwork.openArtifactFile).toHaveBeenCalledWith('a-1', 'task-o');
    view.unmount();
  });

  it('⭐ 水合期间不得先闪「无回答 → 重新尝试」；落定为空后才出现', async () => {
    let release: (value: unknown) => void = () => {};
    listArtifacts.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const view = render(
      <AssistantBlock
        state="finalized"
        message={messageOf({ id: 'm-pending', taskId: 'task-pending', content: '', toolCalls: [] })}
        identity={identity}
      />,
    );

    expect(
      view.container.querySelector('[data-testid="assistant-no-visible-answer"]'),
      '首水合未回 ⇒ 按"可能有内容"处理',
    ).toBeNull();

    await act(async () => {
      release({ ok: true, result: [] });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      view.container.querySelector('[data-testid="assistant-no-visible-answer"]'),
      '落定确实为空 ⇒ 如实给可重试失败态',
    ).not.toBeNull();
    view.unmount();
  });

  it('查询失败：不炸、不冒充核验成功（store 为空 ⇒ 无卡）', async () => {
    listArtifacts.mockResolvedValue({ ok: false, error: 'boom' });
    const view = render(
      <AssistantBlock state="finalized" message={messageOf({ taskId: 'task-fail' })} identity={identity} />,
    );
    await flush();
    expect(cardCount(view.container)).toBe(0);
    expect(view.container.textContent).toContain('看结果');
    view.unmount();
  });
});
