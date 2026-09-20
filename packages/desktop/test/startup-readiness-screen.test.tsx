// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { StartupReadiness } from '../src/renderer/lib/startup-readiness';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).join('|')}` : key,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import StartupReadinessScreen from '../src/renderer/layouts/StartupReadiness';
import StartupReadinessPanel from '../src/renderer/layouts/MainArea/StartupReadinessPanel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseReadiness: StartupReadiness = {
  gatewayId: 'gw-1',
  ai: { phase: 'starting' },
  assistants: {
    phase: 'waiting',
    completed: 0,
    total: 6,
    missingIds: [],
  },
  workspaceAvailable: true,
  conversationReady: false,
  isReady: false,
  hasError: false,
};

function render(ui: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('StartupReadinessScreen', () => {
  it('explains AI startup and exposes a busy state', () => {
    const { container, unmount } = render(<StartupReadinessScreen readiness={baseReadiness} onRetry={vi.fn()} />);

    expect(container.firstElementChild?.getAttribute('aria-busy')).toBe('true');
    expect(container.textContent).toContain('startupReadiness.aiStarting');
    expect(container.textContent).toContain('startupReadiness.assistantsWaiting');
    unmount();
  });

  /**
   * ⭐⭐ C（2026-09-19，明天出 U 盘内测版）：**必须说清"这不是安装"**。
   *
   * 实测的误解来源：U 盘版首次启动会**把运行环境解压到本机缓存**（约 2–3 分钟，
   * 设计如此 —— 为了拔盘后还能继续用），那个进度界面**看起来就是在装软件**。
   * 同事确实这么反馈过（"双击 exe 装到电脑"）。
   *
   * ⇒ 这句要写死在这儿：**程序不写进系统、不创建桌面图标、不出现在「程序和功能」里**。
   */
  it('⭐⭐ 说清「这不是安装」（否则首启那 2–3 分钟会被当成在装软件）', () => {
    const { container, unmount } = render(<StartupReadinessScreen readiness={baseReadiness} onRetry={vi.fn()} />);

    expect(container.textContent, '首启界面必须有一句"这不是安装"').toContain('startupReadiness.notAnInstall');
    unmount();
  });

  it('⭐ 那句在**错误态**也要在，而且要**看得见**（那时用户最容易怀疑"装坏了"）', () => {
    // ⚠️ 断言**可见性**，不只是"在不在 DOM 里"：`hidden` / `display:none` 都不会把文字
    //    从 `textContent` 里去掉 ⇒ 只断 textContent 的话，"把它藏起来"这种改法**抓不住**。
    //    （变异验证实测过：加 `hidden={!isReady}` 时，只断 textContent 是全绿的。）
    const readiness: StartupReadiness = { ...baseReadiness, ai: { phase: 'error' }, hasError: true };
    const { container, unmount } = render(<StartupReadinessScreen readiness={readiness} onRetry={vi.fn()} />);

    const line = container.querySelector<HTMLElement>('[data-testid="not-an-install"]');
    expect(line, '错误态也必须有这句').not.toBeNull();
    expect(line!.hidden, '不许把它藏起来').toBe(false);
    expect(line!.style.display, '也不许用 CSS 藏').not.toBe('none');
    expect(line!.textContent).toContain('startupReadiness.notAnInstall');
    unmount();
  });

  it('renders the real assistant count and current localized role', () => {
    const readiness: StartupReadiness = {
      ...baseReadiness,
      ai: { phase: 'ready' },
      assistants: {
        phase: 'installing',
        completed: 2,
        total: 6,
        currentId: 'rongying-office',
        missingIds: ['rongying-office'],
      },
    };
    const { container, unmount } = render(<StartupReadinessScreen readiness={readiness} onRetry={vi.fn()} />);
    const progress = container.querySelector('[role="progressbar"]');

    expect(progress?.getAttribute('aria-valuenow')).toBe('2');
    expect(progress?.getAttribute('aria-valuemax')).toBe('6');
    expect(container.textContent).toContain('presetAgents.roles.office');
    unmount();
  });

  it('names missing roles and retries after a failure', () => {
    const onRetry = vi.fn();
    const readiness: StartupReadiness = {
      ...baseReadiness,
      ai: { phase: 'ready' },
      assistants: {
        phase: 'error',
        completed: 4,
        total: 6,
        missingIds: ['rongying-research', 'rongying-family'],
        error: 'write denied',
      },
      hasError: true,
    };
    const { container, unmount } = render(<StartupReadinessScreen readiness={readiness} onRetry={onRetry} />);

    expect(container.textContent).toContain('presetAgents.roles.research');
    expect(container.textContent).toContain('presetAgents.roles.family');
    const button = container.querySelector('button');
    act(() => button?.click());
    expect(onRetry).toHaveBeenCalledOnce();
    unmount();
  });

  /**
   * ⭐⭐ 2026-09-20 U 盘交付实机（T-a28）：**「这些助手尚未完成：… 0 / 6」说不出"为什么"**。
   *
   * `preset-agent-bootstrap` 在**抛错**（`refreshAgents` 失败等）和**全部失败**两种情况下
   * 填的 `missingIds` 都是"全部 6 个" ⇒ 两种截然不同的原因，在界面上**长得一模一样**；
   * 而它其实**把原因放进了 `snapshot.error`**（`Failed to create agent "X": <网关原文>`），
   * 门禁屏与工作台面板**都从来没渲染过这个字段**。
   * ⇒ 同事那边"一些助手安装失败了"我们看到的就是一个 0 / 6，没有可定位的原文。
   *
   * ⚠️ 断言**原文出现在屏幕上**（`textContent` + 没被 `hidden`），不是"某个 state 变了"。
   */
  it('⭐⭐ 助手没就绪时要说出**原因原文**（不只是"0 / 6"）', () => {
    const readiness: StartupReadiness = {
      ...baseReadiness,
      ai: { phase: 'ready' },
      assistants: {
        phase: 'error',
        completed: 0,
        total: 6,
        missingIds: ['rongying-office'],
        error: 'Failed to create agent "rongying-office": gateway not connected',
      },
      hasError: true,
    };
    const { container, unmount } = render(<StartupReadinessScreen readiness={readiness} onRetry={vi.fn()} />);

    expect(container.textContent).toContain('Failed to create agent "rongying-office": gateway not connected');
    const reason = container.querySelector<HTMLElement>('[data-testid="readiness-reason"]');
    expect(reason, '原因要有一个能定位的节点').not.toBeNull();
    expect(reason!.hidden, '不许把它藏起来').toBe(false);
    unmount();
  });

  it('没有原因原文时不许编一句（节点照着不渲染）', () => {
    const readiness: StartupReadiness = {
      ...baseReadiness,
      ai: { phase: 'ready' },
      assistants: { phase: 'error', completed: 0, total: 6, missingIds: ['rongying-office'] },
      hasError: true,
    };
    const { container, unmount } = render(<StartupReadinessScreen readiness={readiness} onRetry={vi.fn()} />);

    expect(container.querySelector('[data-testid="readiness-reason"]')).toBeNull();
    expect(container.textContent).toContain('startupReadiness.assistantsError');
    unmount();
  });

  it('uses explicit ready copy for completed capability rows', () => {
    const readiness: StartupReadiness = {
      ...baseReadiness,
      ai: { phase: 'ready' },
      assistants: {
        phase: 'ready',
        completed: 6,
        total: 6,
        missingIds: [],
      },
      isReady: true,
    };
    const { container, unmount } = render(<StartupReadinessScreen readiness={readiness} onRetry={vi.fn()} />);

    expect(container.textContent).toContain('startupReadiness.aiReady');
    expect(container.textContent).toContain('startupReadiness.assistantsReady');
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
    unmount();
  });
});

describe('StartupReadinessPanel', () => {
  it('shows one truthful assistant progress indicator and the current stage', () => {
    const readiness: StartupReadiness = {
      ...baseReadiness,
      ai: { phase: 'ready' },
      assistants: { ...baseReadiness.assistants, phase: 'installing', completed: 2 },
    };
    const { container, unmount } = render(<StartupReadinessPanel readiness={readiness} onRetry={vi.fn()} />);
    const progress = container.querySelector('[role="progressbar"]');

    expect(container.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
    expect(progress?.getAttribute('aria-valuemax')).toBe('6');
    expect(progress?.getAttribute('aria-valuenow')).toBe('2');
    expect(container.textContent).toContain('startupReadiness.assistantsInstalling');
    expect(container.textContent).not.toContain('%');
    unmount();
  });

  it('uses an indeterminate bar instead of inventing a percentage while the AI service starts', () => {
    const { container, unmount } = render(<StartupReadinessPanel readiness={baseReadiness} onRetry={vi.fn()} />);
    const progress = container.querySelector('[role="progressbar"]');

    expect(progress?.hasAttribute('aria-valuenow')).toBe(false);
    expect(container.textContent).toContain('startupReadiness.aiStarting');
    expect(container.textContent).not.toContain('%');
    unmount();
  });

  it('⭐⭐ 面板上也要有原因原文（同一个原因，两个面都不许吞）', () => {
    const readiness: StartupReadiness = {
      ...baseReadiness,
      ai: { phase: 'ready' },
      assistants: {
        phase: 'error',
        completed: 0,
        total: 6,
        missingIds: ['rongying-office'],
        error: 'Failed to create agent "rongying-office": gateway not connected',
      },
      hasError: true,
    };
    const { container, unmount } = render(<StartupReadinessPanel readiness={readiness} onRetry={vi.fn()} />);

    expect(container.textContent).toContain('Failed to create agent "rongying-office": gateway not connected');
    expect(container.querySelector('[data-testid="readiness-reason"]')).not.toBeNull();
    unmount();
  });

  it('offers recovery after ninety seconds', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn(async () => undefined);
    const { container, unmount } = render(<StartupReadinessPanel readiness={baseReadiness} onRetry={onRetry} />);

    act(() => vi.advanceTimersByTime(90_000));
    expect(container.textContent).toContain('startupReadiness.takingLonger');
    const retry = [...container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('startupReadiness.retry'),
    );
    act(() => retry?.click());
    expect(onRetry).toHaveBeenCalledOnce();

    unmount();
    vi.useRealTimers();
  });
});
