// @vitest-environment jsdom
/**
 * H5 + H6（2026-10-09 复审）：**真实 App** 里的右栏抽屉与拖拽。
 *
 * H5（抽屉焦点 / 去来源）：
 * - 窄窗下预览是 Radix 抽屉；按 Escape 关闭后焦点不许落到 body —— 要归还**仍连接的入口**，
 *   入口已随布局卸载时退到当前聊天视图的稳定控件（已挂载 Composer 的输入框）；
 * - 「去来源」必须**先关抽屉**再切会话（旧实现只切会话不关模式 ⇒ 弹层继续盖住目标对话）。
 *
 * H6（拖拽跟手）：拖拽期间右栏**只**取消宽度的过渡；释放后恢复正常动画。
 * 断言读 `motion.aside` 的真实 `style.width`（不是只验 store 数值）。
 *
 * ⚠️ 壳：App 的重型布局（LeftNav / MainArea / Settings …）按既有 `app-entry-account-race.test.tsx`
 * 的做法打桩 —— 但**右栏 RightPanel、zustand stores、Radix Dialog 都是真的**。
 * MainArea 桩按真实结构（`[data-testid="composer-drop-zone"]` 包着 composer 的 textarea，
 * 见 `components/ChatInput/index.tsx`）提供焦点兜底的落点。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact, TeamMeetingRecord } from '@clawwork/shared';
import type { OnboardingProfile } from '../src/renderer/lib/user-onboarding';

const fixtures = vi.hoisted(() => ({
  startup: {
    gatewayId: 'local-runtime',
    retry: vi.fn(async () => {}),
  },
  assistants: { phase: 'ready', completed: 6, total: 6, missingIds: [] as string[] },
}));

/**
 * 团队会议实例在模块加载期就读 `ports`（`lib/session-sync.ts` 顶层），而测试的
 * `window.clawwork` 是每个用例才装的 —— 桩掉这一个只读 store（其余全真）。
 * （既有 `right-panel-artifact-preview.test.tsx` 同款做法。）
 */
const meetingState = vi.hoisted(() => ({ records: [] as TeamMeetingRecord[] }));
vi.mock('../src/renderer/features/team-meeting/instance', () => ({
  useTeamMeetingStore: (selector: (state: typeof meetingState) => unknown) => selector(meetingState),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('../src/renderer/lib/toast', () => ({
  Toaster: () => null,
  TOAST_DURATION_MS: 5000,
  TOAST_OPTIONS: {},
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock('../src/renderer/layouts/LeftNav', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/TopBar', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/MainArea', async () => {
  const React = await import('react');
  return {
    default: () =>
      React.createElement(
        'div',
        { 'data-testid': 'stub-main-area' },
        React.createElement('button', { 'data-testid': 'stub-chat-entry', type: 'button' }, 'chat entry'),
        React.createElement(
          'div',
          { 'data-testid': 'composer-drop-zone' },
          React.createElement('textarea', { 'data-testid': 'stub-composer' }),
        ),
      ),
  };
});
vi.mock('../src/renderer/layouts/Settings', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/Setup', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/Onboarding', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/EntryPreparation', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ApprovalDialog', () => ({ default: () => null }));
vi.mock('../src/renderer/components/CommandPalette', () => ({ default: () => null }));
vi.mock('../src/renderer/hooks/useGatewayBootstrap', () => ({ useGatewayBootstrap: vi.fn() }));
vi.mock('../src/renderer/hooks/useWorkspaceRefresh', () => ({ useWorkspaceRefresh: vi.fn() }));
vi.mock('../src/renderer/hooks/useUpdateCheck', () => ({ useUpdateCheck: vi.fn() }));
vi.mock('../src/renderer/hooks/useTraySync', () => ({ useTraySync: vi.fn() }));
vi.mock('../src/renderer/hooks/useModuleOpenTracking', () => ({ useModuleOpenTracking: vi.fn() }));
vi.mock('../src/renderer/hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: vi.fn() }));
vi.mock('../src/renderer/hooks/useSettingsBootstrap', () => ({ useSettingsBootstrap: vi.fn() }));
vi.mock('../src/renderer/hooks/useStartupReadiness', () => ({ useStartupReadiness: () => fixtures.startup }));
vi.mock('../src/renderer/hooks/useDocgenFailureToast', () => ({ useDocgenFailureToast: vi.fn() }));
vi.mock('../src/renderer/hooks/useHtmlgenFailureToast', () => ({ useHtmlgenFailureToast: vi.fn() }));
vi.mock('../src/renderer/hooks/useVideogenFailureToast', () => ({ useVideogenFailureToast: vi.fn() }));
vi.mock('../src/renderer/hooks/useSlidegenToast', () => ({ useSlidegenToast: vi.fn() }));
vi.mock('../src/renderer/hooks/useClaimGuardToast', () => ({ useClaimGuardToast: vi.fn() }));
vi.mock('../src/renderer/hooks/useDeliveryActivitySubscription', () => ({
  useDeliveryActivitySubscription: vi.fn(),
}));
vi.mock('../src/renderer/hooks/useAutoRetryFailedTurn', () => ({ useAutoRetryFailedTurn: vi.fn() }));
vi.mock('../src/renderer/hooks/useEntryRuntimeStatus', () => ({ useEntryRuntimeStatus: () => ({ ok: true }) }));
vi.mock('../src/renderer/lib/gateway-disappearance', () => ({ useGatewayDisappearanceNotice: vi.fn() }));
vi.mock('../src/renderer/lib/preset-agent-bootstrap', () => ({
  presetAgentBootstrapCoordinator: { getSnapshot: () => fixtures.assistants },
}));
vi.mock('../src/renderer/lib/user-onboarding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/lib/user-onboarding')>();
  /**
   * 诊断入口与旧入口**共用同一把 mock**（BUG-034 集成在途）：`loadOnboardingProfileResult` 的
   * reason/profile 从被覆盖的 `loadOnboardingProfile` 派生，App 走哪条读取路径都拿到
   * `localProfile()` ⇒ 这些 H5/H6 布局用例不必知道 App 用的是哪个读取口。
   */
  const loadOnboardingProfile = vi.fn((_userId: string) => localProfile());
  return {
    ...actual,
    loadOnboardingProfile,
    loadOnboardingProfileResult: vi.fn((userId: string) => {
      const profile = loadOnboardingProfile(userId);
      return {
        reason: profile ? 'ok' : 'missing',
        profile,
        diagnostic: { keyKind: profile ? 'v3' : null, recordVersion: null, sections: [] },
      };
    }),
    saveOnboardingProfile: vi.fn(),
  };
});

import App from '../src/renderer/App';
import { requestArtifactPreview } from '../src/renderer/lib/artifact-preview-navigation';
import { useFileStore } from '../src/renderer/stores/fileStore';
import { useMessageStore } from '../src/renderer/stores/messageStore';
import { useTaskStore } from '../src/renderer/stores/taskStore';
import { useUiStore } from '../src/renderer/stores/uiStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 本地模式（无 supabase 配置）下的合法档案：App 直接进工作区，不经过登录/准备页。 */
function localProfile(): OnboardingProfile {
  return {
    version: 3,
    userId: 'local',
    nickname: '本机用户',
    useCases: ['office'],
    customGoal: '整理资料',
    completedAt: '2026-10-09T00:00:00.000Z',
  };
}

const artifact: Artifact = {
  id: 'artifact-1',
  taskId: 'task-1',
  messageId: 'message-1',
  type: 'file',
  name: 'deck.docx',
  filePath: 'E:/workspace/task-1/deck.docx',
  localPath: 'task-1/deck.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size: 12,
  createdAt: '2026-10-09T08:00:00.000Z',
  availability: 'available',
};

let container: HTMLDivElement;
let root: Root;
let appMounted = false;

const listArtifacts = vi.fn();

function installBridge(): void {
  const unsubscribe = () => () => {};
  Object.assign(window, {
    clawwork: {
      reportPortableUpdateRendererReady: vi.fn(),
      setWindowButtonVisibility: vi.fn(),
      // 本地模式：没配置 supabase ⇒ 无登录、无许可门（App 快速进工作区）。
      commercialGetConfig: async () => ({ ok: true, result: { hasAnonKey: false } }),
      // 本地模式分支会回写 onboarding profile（App.tsx `entryMode === 'local'`）。
      saveProfile: vi.fn(async () => ({ ok: true })),
      isWorkspaceConfigured: async () => true,
      listArtifacts,
      onArtifactSaved: unsubscribe,
      onQuickLaunchSubmit: unsubscribe,
      onTrayNavigateTask: unsubscribe,
      onNotificationNavigateTask: unsubscribe,
      onTrayOpenSettings: unsubscribe,
      readArtifactThumbnail: vi.fn(async () => ({ ok: true, result: { dataUrl: null } })),
      previewArtifact: vi.fn(async () => ({
        ok: true,
        result: { kind: 'docx', paragraphs: ['预览里的正文'], truncated: false },
      })),
      readArtifactFile: vi.fn(async () => ({ ok: true, result: { content: '', encoding: 'utf-8' } })),
    },
  });
}

async function renderApp(): Promise<void> {
  appMounted = true;
  await act(async () => root.render(<App />));
  // 入口判定是两条异步链（配置 + 工作区就绪），再等一帧让工作区子树挂上。
  await flushUi();
}

function unmountApp(): void {
  if (!appMounted) return;
  appMounted = false;
  act(() => root.unmount());
}

async function flushUi(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 4; i += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
}

/** 等到某个条件成立（真实计时器；超时即让断言去报失败）。 */
async function waitFor(check: () => boolean, timeoutMs = 1500): Promise<void> {
  const started = Date.now();
  while (!check() && Date.now() - started < timeoutMs) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(window, { innerWidth: 1024 });
  useFileStore.setState({ selectedArtifactId: null });
  useMessageStore.setState({ highlightedMessageId: null });
  useTaskStore.setState({ activeTaskId: 'task-1', workspaceEpoch: 0 });
  useUiStore.setState({
    rightPanelOpen: false,
    artifactPanelMode: 'list',
    artifactPreviewWidth: 500,
    mainView: 'chat',
    settingsOpen: false,
    leftNavCollapsed: false,
  });
  listArtifacts.mockResolvedValue({ ok: true, result: [artifact] });
  installBridge();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  unmountApp();
  container.remove();
  // 拖拽会写 body 样式，别把状态漏给下一个文件/用例。
  document.body.style.userSelect = '';
  document.body.style.cursor = '';
});

const openDrawerLayout = (): void => {
  Object.assign(window, { innerWidth: 900 }); // 900 - 224 = 676 < 720 ⇒ 抽屉
  useUiStore.setState({ rightPanelOpen: true, artifactPanelMode: 'list' });
};

describe('H5 · 窄窗抽屉：关闭、焦点归还、去来源', () => {
  it('⭐ Escape 关闭抽屉：焦点归还仍连接的入口（不是 body）', async () => {
    openDrawerLayout();
    await renderApp();
    expect(container.querySelector('[data-testid="stub-main-area"]')).not.toBeNull();

    const entry = container.querySelector<HTMLButtonElement>('[data-testid="stub-chat-entry"]')!;
    entry.focus();
    expect(document.activeElement, '前置：入口已聚焦').toBe(entry);

    await act(async () => {
      requestArtifactPreview(artifact);
    });
    await flushUi();

    const drawer = document.querySelector('.artifact-drawer');
    expect(drawer, '窄窗下预览必须是抽屉').not.toBeNull();
    expect(drawer!.contains(document.activeElement), '前置：焦点在弹层里').toBe(true);

    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
    });

    expect(document.querySelector('.artifact-drawer'), 'Escape 之后弹层必须关掉').toBeNull();
    expect(useUiStore.getState().artifactPanelMode).toBe('list');
    expect(entry.isConnected, '前置：入口仍在文档里').toBe(true);
    expect(document.activeElement, '焦点必须回到仍连接的入口').toBe(entry);
  });

  it('⭐ 入口已随布局卸载（列表卡被预览态换下）⇒ 兜底到已挂载 Composer 的输入框，不落 body', async () => {
    openDrawerLayout();
    await renderApp();
    await flushUi();

    const cardButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="artifact-card"] [data-action="artifact-preview"]',
    )!;
    cardButton.focus();
    await act(async () => cardButton.click());
    await flushUi();
    expect(document.querySelector('.artifact-drawer')).not.toBeNull();
    expect(cardButton.isConnected, '列表被抽屉换下 ⇒ 入口已脱开文档').toBe(false);

    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
    });

    const composer = container.querySelector<HTMLTextAreaElement>('[data-testid="stub-composer"]')!;
    expect(document.activeElement, '兜底 = 当前聊天视图的稳定输入控件').toBe(composer);
    expect(document.activeElement).not.toBe(document.body);
  });

  it('⭐ 窄窗「去来源」：先关弹层，再切会话与高亮（目标对话不再被盖住）', async () => {
    openDrawerLayout();
    useUiStore.setState({ artifactPanelMode: 'preview' });
    useFileStore.setState({ selectedArtifactId: artifact.id });
    await renderApp();
    await flushUi();

    const drawer = document.querySelector('.artifact-drawer');
    expect(drawer).not.toBeNull();
    await waitFor(() =>
      [...document.querySelectorAll<HTMLButtonElement>('.artifact-drawer button')].some((button) =>
        button.textContent?.includes('filePreview.goToSource'),
      ),
    );
    const goToSource = [...document.querySelectorAll<HTMLButtonElement>('.artifact-drawer button')].find((button) =>
      button.textContent?.includes('filePreview.goToSource'),
    );
    expect(goToSource, '预览窗格里要有「去来源」').toBeTruthy();

    await act(async () => goToSource!.click());
    await flushUi();

    expect(useUiStore.getState().artifactPanelMode, '去来源必须先关掉预览模式').toBe('list');
    expect(document.querySelector('.artifact-drawer'), '弹层必须关掉（不能继续盖住目标对话）').toBeNull();
    expect(useUiStore.getState().mainView).toBe('chat');
    expect(useTaskStore.getState().activeTaskId).toBe('task-1');
    expect(useMessageStore.getState().highlightedMessageId, '来源消息要被定位').toBe('message-1');
    expect(container.querySelector('[data-testid="stub-main-area"]'), '目标会话可见').not.toBeNull();
  });

  it('⭐ 预览期间切任务：旧入口仍连接也要作废，焦点交给当前 Composer（E5）', async () => {
    openDrawerLayout();
    await renderApp();
    const entry = container.querySelector<HTMLButtonElement>('[data-testid="stub-chat-entry"]')!;
    entry.focus();
    await act(async () => requestArtifactPreview(artifact));
    await flushUi();
    expect(document.querySelector('.artifact-drawer'), '前置：抽屉已打开').not.toBeNull();

    // 切任务后新范围的权威查询里没有这份文件 ⇒ 预览退回列表、抽屉关闭。
    // 此刻旧入口（聊天入口按钮）**仍然连接** —— 但它属于上一个任务，不许归还。
    listArtifacts.mockResolvedValue({ ok: true, result: [] });
    await act(async () => {
      useTaskStore.setState({ activeTaskId: 'task-2' });
    });
    await flushUi();

    expect(document.querySelector('.artifact-drawer')).toBeNull();
    expect(entry.isConnected, '前置：旧入口仍在文档里（所以不能只靠 isConnected 判废）').toBe(true);
    const composer = container.querySelector<HTMLTextAreaElement>('[data-testid="stub-composer"]')!;
    expect(document.activeElement, '跨任务后旧入口必须作废，改用当前聊天视图的 Composer').toBe(composer);
  });

  it('⭐ 预览期间换工作区（epoch 变化）：旧入口同样作废（E5）', async () => {
    openDrawerLayout();
    await renderApp();
    const entry = container.querySelector<HTMLButtonElement>('[data-testid="stub-chat-entry"]')!;
    entry.focus();
    await act(async () => requestArtifactPreview(artifact));
    await flushUi();
    expect(document.querySelector('.artifact-drawer'), '前置：抽屉已打开').not.toBeNull();

    listArtifacts.mockResolvedValue({ ok: true, result: [] });
    await act(async () => {
      useTaskStore.setState({ workspaceEpoch: 1 });
    });
    await flushUi();

    expect(document.querySelector('.artifact-drawer')).toBeNull();
    expect(entry.isConnected, '前置：旧入口仍在文档里').toBe(true);
    const composer = container.querySelector<HTMLTextAreaElement>('[data-testid="stub-composer"]')!;
    expect(document.activeElement, '跨 epoch 后旧入口必须作废，改用当前 Composer').toBe(composer);
  });
});

describe('H6 · 拖拽跟手（真实 style.width）', () => {
  const rightAside = (): HTMLElement => container.querySelectorAll('aside')[1] as HTMLElement;

  it('⭐ 拖拽中真实宽度立即跟手；释放后恢复正常过渡', async () => {
    Object.assign(window, { innerWidth: 1280 }); // 1280 - 224 = 1056 ≥ 720 ⇒ 并排
    useUiStore.setState({ rightPanelOpen: true, artifactPanelMode: 'preview' });
    useFileStore.setState({ selectedArtifactId: artifact.id });
    await renderApp();
    await waitFor(() => container.querySelectorAll('aside').length >= 2);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 400)); // 等首次入场动画走完
    });
    expect(useUiStore.getState().artifactPanelMode, '前置：预览态（拖拽手柄用预览宽）').toBe('preview');

    const panel = rightAside();
    const handle = panel.previousElementSibling as HTMLElement;
    expect(handle, '右栏要有拖拽手柄').not.toBeNull();
    expect(parseFloat(panel.style.width), '前置：入场结束后的宽度 = 偏好').toBe(500);

    act(() => handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 780 })));
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 680 })));
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 60));
    });

    expect(useUiStore.getState().artifactPreviewWidth, 'store 里的目标宽').toBe(600);
    expect(parseFloat(panel.style.width), '拖拽中真实 DOM 宽度必须立即跟手（不能还在播 width 动画）').toBe(600);

    act(() => window.dispatchEvent(new MouseEvent('mouseup')));
    expect(document.body.style.cursor, '释放后 body 光标收干净').toBe('');

    // 释放之后：宽度变化必须重新走动画（中途采样落在起止之间），而不是又一次瞬移。
    act(() => useUiStore.getState().setArtifactPreviewWidth(650));
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
    });
    const mid = parseFloat(panel.style.width);
    expect(mid, `释放后应恢复过渡（中途值应在 600 与 650 之间，实际 ${mid}）`).toBeGreaterThan(600);
    expect(mid).toBeLessThan(650);

    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
    });
    expect(parseFloat(panel.style.width), '动画终点回到目标宽').toBe(650);
  });

  it('⭐ 拖拽中途卸载 App：全局监听与 body 样式都收干净（宽不再被改动）', async () => {
    Object.assign(window, { innerWidth: 1280 });
    useUiStore.setState({ rightPanelOpen: true, artifactPanelMode: 'preview' });
    useFileStore.setState({ selectedArtifactId: artifact.id });
    await renderApp();
    await waitFor(() => container.querySelectorAll('aside').length >= 2);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
    });

    const panel = rightAside();
    const handle = panel.previousElementSibling as HTMLElement;
    act(() => handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 780 })));
    expect(document.body.style.cursor, '拖拽中 body 是列宽光标').toBe('col-resize');

    unmountApp();
    expect(document.body.style.cursor, '卸载即收尾').toBe('');
    expect(document.body.style.userSelect).toBe('');

    const widthAfterUnmount = useUiStore.getState().artifactPreviewWidth;
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 600 })));
    expect(useUiStore.getState().artifactPreviewWidth, '卸载后监听必须摘掉（宽度不再被拖动改）').toBe(
      widthAfterUnmount,
    );
    container.remove();
  });

  it('⭐ 拖拽中途窗口失焦（收不到 mouseup）：同样收尾，宽度不再被后续移动改', async () => {
    Object.assign(window, { innerWidth: 1280 });
    useUiStore.setState({ rightPanelOpen: true, artifactPanelMode: 'preview' });
    useFileStore.setState({ selectedArtifactId: artifact.id });
    await renderApp();
    await waitFor(() => container.querySelectorAll('aside').length >= 2);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
    });

    const panel = rightAside();
    const handle = panel.previousElementSibling as HTMLElement;
    act(() => handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 780 })));
    act(() => window.dispatchEvent(new Event('blur')));
    expect(document.body.style.cursor, '失焦即收尾').toBe('');

    const widthAfterBlur = useUiStore.getState().artifactPreviewWidth;
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 600 })));
    expect(useUiStore.getState().artifactPreviewWidth).toBe(widthAfterBlur);
  });

  it('⭐ 拖拽期间刷新把预览退回列表：旧拖拽当场作废（E6）', async () => {
    Object.assign(window, { innerWidth: 1280 });
    useUiStore.setState({ rightPanelOpen: true, artifactPanelMode: 'preview', rightPanelWidth: 400 });
    useFileStore.setState({ selectedArtifactId: artifact.id });
    await renderApp();
    await flushUi();
    expect(useUiStore.getState().artifactPanelMode, '前置：预览态').toBe('preview');

    const panel = rightAside();
    const handle = panel.previousElementSibling as HTMLElement;
    // 先发起刷新（在途），再按住预览手柄；让刷新在拖动中途回来并判 missing。
    let resolveRefresh!: (value: { ok: true; result: Artifact[] }) => void;
    const inFlightRefresh = new Promise<{ ok: true; result: Artifact[] }>((resolve) => {
      resolveRefresh = resolve;
    });
    listArtifacts.mockReturnValue(inFlightRefresh);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="artifactCard.refresh"]')!.click();
    });
    act(() => handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 780 })));
    expect(document.body.style.cursor, '前置：拖拽中 body 是列宽光标').toBe('col-resize');

    await act(async () => resolveRefresh({ ok: true, result: [{ ...artifact, availability: 'missing' }] }));
    await flushUi();
    expect(useUiStore.getState().artifactPanelMode, '刷新判 missing ⇒ 预览退回列表').toBe('list');
    expect(document.body.style.cursor, '模式已变 ⇒ 旧拖拽必须收尾，body 光标还原').toBe('');

    const width = useUiStore.getState().artifactPreviewWidth;
    act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 680 })));
    expect(useUiStore.getState().artifactPreviewWidth, '后续 mousemove 不许再改预览宽度偏好').toBe(width);
  });
});
