// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

let setSettingsSection: ReturnType<typeof vi.fn> = vi.fn();
let setSettingsOpen: ReturnType<typeof vi.fn> = vi.fn();

vi.mock('../src/renderer/stores/uiStore', () => ({
  useUiStore: (selector: (s: { setSettingsSection: unknown; setSettingsOpen: unknown }) => unknown) =>
    selector({ setSettingsSection, setSettingsOpen }),
}));

import WorkspaceRecreatedNotice, {
  resetWorkspaceNoticeForTest,
} from '../src/renderer/components/WorkspaceRecreatedNotice';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let noticeResult: unknown = null;

function mount(): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render((<WorkspaceRecreatedNotice />) as ReactElement));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}
const flush = (): Promise<void> => act(async () => {});

describe('WorkspaceRecreatedNotice', () => {
  beforeEach(() => {
    resetWorkspaceNoticeForTest();
    setSettingsSection = vi.fn();
    setSettingsOpen = vi.fn();
    noticeResult = null;
    Object.assign(window, {
      clawwork: { workspaceStartupNotice: async () => ({ ok: true, result: noticeResult }) },
    });
  });

  it('没有通知 ⇒ 什么都不渲染', async () => {
    const { container, unmount } = mount();
    await flush();
    expect(container.textContent).toBe('');
    unmount();
  });

  it('⭐ recreated ⇒ 出告知 + 两个出口（去设置 / 知道了）', async () => {
    noticeResult = { kind: 'recreated', path: 'C:\\ws', at: 1 };
    const { container, unmount } = mount();
    await flush();
    expect(container.textContent).toContain('workspaceNotice.recreated');
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent ?? '');
    expect(buttons.some((t) => t.includes('workspaceNotice.openSettings'))).toBe(true);
    expect(buttons.some((t) => t.includes('workspaceNotice.dismiss'))).toBe(true);
    unmount();
  });

  it('⭐ [知道了] 之后本次会话不再出现（另一个挂点重挂载也不许回来）', async () => {
    noticeResult = { kind: 'recreated', path: 'C:\\ws', at: 1 };
    const first = mount();
    await flush();
    const dismiss = [...first.container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('workspaceNotice.dismiss'),
    );
    expect(dismiss, '必须有一个"知道了"出口').toBeTruthy();
    act(() => dismiss?.click());
    expect(first.container.textContent).toBe('');
    first.unmount();

    const second = mount();
    await flush();
    expect(second.container.textContent, '同一会话里的另一个挂点不许重新冒出来').toBe('');
    second.unmount();
  });

  it('[打开工作区设置] 打开设置的系统页', async () => {
    noticeResult = { kind: 'recreated', path: 'C:\\ws', at: 1 };
    const { container, unmount } = mount();
    await flush();
    const open = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('workspaceNotice.openSettings'),
    );
    act(() => open?.click());
    expect(setSettingsSection).toHaveBeenCalledWith('system');
    expect(setSettingsOpen).toHaveBeenCalledWith(true);
    unmount();
  });
});
