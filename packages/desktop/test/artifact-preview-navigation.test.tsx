// @vitest-environment jsdom
/**
 * Task 3（WorkBuddy 产物 UI A 批）：**成果卡 → 右侧预览**的导航动作与视图门。
 *
 * - `requestArtifactPreview`：选中已有 fileStore 的 ID + 置 panelMode=preview + 开右栏；
 *   **不是 toggle**（重复点击不关栏）；不触发系统 open；不写第二份 Artifact 对象。
 * - `useArtifactPanelViewScope`（App 挂载的视图门）：离开聊天 / 打开设置 ⇒ 复位 list；
 *   回聊天**不自动恢复**上次预览；切 FileBrowser 改选中 ID 再回聊天同样不误开。
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '@clawwork/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import ArtifactCard from '../src/renderer/components/ArtifactCard';
import { requestArtifactPreview, useArtifactPanelViewScope } from '../src/renderer/lib/artifact-preview-navigation';
import { useFileStore } from '../src/renderer/stores/fileStore';
import { useUiStore } from '../src/renderer/stores/uiStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const artifact: Artifact = {
  id: 'a1',
  taskId: 't1',
  messageId: 'm1',
  type: 'file',
  name: 'deck.pptx',
  filePath: 'C:/ws/deck.pptx',
  localPath: 't1/deck.pptx',
  mimeType: 'application/octet-stream',
  size: 10,
  createdAt: '2026-10-09T00:00:00.000Z',
  availability: 'available',
};

const openSpy = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  useFileStore.setState({ selectedArtifactId: null });
  useUiStore.setState({ artifactPanelMode: 'list', rightPanelOpen: false, mainView: 'chat', settingsOpen: false });
  Object.assign(window, {
    clawwork: {
      openArtifactFile: openSpy,
      showArtifactInFolder: vi.fn(),
      saveArtifactAs: vi.fn(),
    },
  });
});

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

describe('Task3 · 成果卡上的预览动作', () => {
  it('⭐ 点击预览 ⇒ 选中该文件 + 开右栏预览模式；不调用系统打开', () => {
    const { container, unmount } = render(<ArtifactCard artifact={artifact} onPreview={requestArtifactPreview} />);
    const button = container.querySelector<HTMLButtonElement>('[data-action="artifact-preview"]');
    expect(button, '成果卡必须有明确的预览入口').not.toBeNull();

    act(() => button!.click());
    expect(useFileStore.getState().selectedArtifactId).toBe('a1');
    expect(useUiStore.getState().artifactPanelMode).toBe('preview');
    expect(useUiStore.getState().rightPanelOpen).toBe(true);
    expect(openSpy, '预览 ≠ 系统打开').not.toHaveBeenCalled();
    unmount();
  });

  it('⭐ 重复点击不关栏（不是 toggle）', () => {
    const { container, unmount } = render(<ArtifactCard artifact={artifact} onPreview={requestArtifactPreview} />);
    const button = container.querySelector<HTMLButtonElement>('[data-action="artifact-preview"]');
    act(() => button!.click());
    act(() => button!.click());
    expect(useUiStore.getState().artifactPanelMode).toBe('preview');
    expect(useUiStore.getState().rightPanelOpen).toBe(true);
    unmount();
  });

  it('未传 onPreview ⇒ 不渲染预览按钮（FileBrowser 等旧调用方零变化）', () => {
    const { container, unmount } = render(<ArtifactCard artifact={artifact} />);
    expect(container.querySelector('[data-action="artifact-preview"]')).toBeNull();
    unmount();
  });
});

describe('Task3 · 视图门（App 挂载）', () => {
  function Probe(): null {
    useArtifactPanelViewScope();
    return null;
  }

  it('⭐ 离开聊天（切 files）⇒ 复位 list；回聊天不自动恢复上次预览', () => {
    const { unmount } = render(<Probe />);
    requestArtifactPreview(artifact);
    expect(useUiStore.getState().artifactPanelMode).toBe('preview');

    act(() => {
      useUiStore.getState().setMainView('files');
    });
    expect(useUiStore.getState().artifactPanelMode, '离开聊天必须复位').toBe('list');

    act(() => {
      useUiStore.getState().setMainView('chat');
    });
    expect(useUiStore.getState().artifactPanelMode, '回聊天不自动恢复').toBe('list');
    unmount();
  });

  it('⭐ 打开设置再关闭 ⇒ 一直 stays list（不自动恢复）', () => {
    const { unmount } = render(<Probe />);
    requestArtifactPreview(artifact);

    act(() => {
      useUiStore.getState().setSettingsOpen(true);
    });
    expect(useUiStore.getState().artifactPanelMode).toBe('list');

    act(() => {
      useUiStore.getState().setSettingsOpen(false);
    });
    expect(useUiStore.getState().artifactPanelMode).toBe('list');
    unmount();
  });

  it('⭐ FileBrowser 改选 B 后回聊天：不自动预览 B（选中 ID 变化不是预览请求）', () => {
    const { unmount } = render(<Probe />);
    requestArtifactPreview(artifact);
    act(() => {
      useUiStore.getState().setMainView('files');
    });
    // FileBrowser 的既有行为：改共享 selectedArtifactId（这里换成 B）
    act(() => {
      useFileStore.getState().setSelectedArtifact('b2');
    });
    act(() => {
      useUiStore.getState().setMainView('chat');
    });
    expect(useUiStore.getState().artifactPanelMode, '回聊天必须回到列表').toBe('list');
    unmount();
  });
});
