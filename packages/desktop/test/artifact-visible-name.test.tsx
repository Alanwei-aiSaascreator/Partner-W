// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '@clawwork/shared';

/**
 * 成果的**可见身份 = 注册的文件名**（2026-10-04 真机缺陷）。
 *
 * 现场：真实登记的视频「Partner-W测试.mp4」在文件卡与预览标题上都显示成「文件」——
 * FileCard / FilePreview / 搜索结果把**类型名**（`getArtifactLabel`）当身份标题用了。
 * 这条链之所以单测全绿还是漏了：`file-browser-workspace.test.tsx` 把真实 FileCard
 * 替成「直接输出 artifact.name」的 mock ⇒ 真实卡标题从没被任何测试看过。
 *
 * 所以这里**不 mock 目标组件、不 mock 翻译**：真实 FileCard / FilePreview /
 * 真实 zh 文案，断言的就是用户眼睛看到的那个字符串。
 */

const scope = vi.hoisted(() => ({ workspaceEpoch: 0, tasks: [], setActiveTask: vi.fn() }));
vi.mock('../src/renderer/stores/taskStore', () => ({
  useTaskStore: Object.assign((select: (s: typeof scope) => unknown) => select(scope), { getState: () => scope }),
}));
vi.mock('../src/renderer/stores/messageStore', () => ({
  useMessageStore: (select: (s: unknown) => unknown) => select({ setHighlightedMessage: vi.fn() }),
}));
vi.mock('../src/renderer/stores/uiStore', () => ({
  useUiStore: (select: (s: unknown) => unknown) => select({ setMainView: vi.fn() }),
}));
vi.mock('../src/renderer/layouts/FileBrowser/WorkspaceAccessSummary', () => ({ default: () => null }));
vi.mock('../src/renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../src/renderer/hooks/useResizePanel', () => ({
  useResizePanel: () => ({ width: 360, isDragging: false, handleMouseDown: vi.fn() }),
}));
vi.mock('../src/renderer/components/ContextMenu', () => ({ TaskContextMenuPopover: () => null }));

import i18n from '../src/renderer/i18n';
import FileCard from '../src/renderer/components/FileCard';
import FilePreview from '../src/renderer/components/FilePreview';
import FileBrowser from '../src/renderer/layouts/FileBrowser';
import { useFileStore } from '../src/renderer/stores/fileStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 真实登记行的字段形状（视频行取自 2026-10-04 真机证据；PPT 为明确标记的受控夹具）。 */
const videoArtifact: Artifact = {
  id: 'video-registered',
  taskId: 'task-1',
  messageId: 'msg-1',
  name: 'Partner-W测试.mp4',
  type: 'file',
  availability: 'available',
  filePath: 'task-1/Partner-W测试.mp4',
  localPath: 'task-1/Partner-W测试.mp4',
  mimeType: 'video/mp4',
  size: 6092,
  createdAt: '2026-10-04T00:00:00Z',
};
const pptxArtifact: Artifact = {
  ...videoArtifact,
  id: 'pptx-controlled',
  name: 'Controlled version 2.pptx',
  mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(async () => {
  await i18n.changeLanguage('zh');
  Object.assign(window, {
    clawwork: {
      previewArtifact: vi.fn().mockResolvedValue({ ok: false, error: 'unsupported' }),
      readArtifactFile: vi.fn().mockResolvedValue({ ok: true, result: { content: '', encoding: 'utf-8' } }),
      listArtifacts: vi.fn().mockResolvedValue({ ok: true, result: [] }),
      searchArtifacts: vi.fn(),
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = undefined;
  vi.useRealTimers();
});

async function render(node: ReactNode): Promise<void> {
  await act(async () => root!.render(node));
}

describe('成果可见名 = 注册文件名', () => {
  it('⭐ FileCard 标题与可访问名都是注册名，不是「文件」', async () => {
    await render(
      <FileCard
        artifact={videoArtifact}
        taskTitle="任务"
        selected={false}
        onClick={() => {}}
        onContextMenu={() => {}}
      />,
    );
    // 类型助手本身没坏：它仍会说「文件」——错的是拿它当标题。
    expect(i18n.t('artifactKinds.file')).not.toBe(videoArtifact.name);
    expect(container.querySelector('p.type-label')?.textContent).toBe('Partner-W测试.mp4');
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));
    expect(labels).toContain('Partner-W测试.mp4');
    expect(labels).not.toContain(i18n.t('artifactKinds.file'));
  });

  it('⭐ FilePreview 的 h3 标题是注册名（PPTX 受控夹具）', async () => {
    await render(<FilePreview artifact={pptxArtifact} onNavigateToTask={() => {}} />);
    expect(container.querySelector('h3')?.textContent).toBe('Controlled version 2.pptx');
  });

  it('遗留空名行只在**确实为空**时回落到类型名，不裁剪、不从路径猜', async () => {
    await render(
      <FileCard
        artifact={{ ...videoArtifact, id: 'legacy', name: '   ', mimeType: 'text/plain' }}
        taskTitle="任务"
        selected={false}
        onClick={() => {}}
        onContextMenu={() => {}}
      />,
    );
    expect(container.querySelector('p.type-label')?.textContent).toBe(i18n.t('artifactKinds.text'));
  });

  it('⭐ 列表/搜索里两个同类型不同名的成果必须可区分', async () => {
    vi.useFakeTimers();
    const search = window.clawwork.searchArtifacts as unknown as ReturnType<typeof vi.fn>;
    search.mockResolvedValue({
      ok: true,
      result: [
        { ...videoArtifact, id: 'a', name: '合同-A.txt', mimeType: 'text/plain' },
        { ...videoArtifact, id: 'b', name: '合同-B.txt', mimeType: 'text/plain' },
      ],
    });
    useFileStore.setState({
      artifacts: [],
      selectedArtifactId: null,
      searchQuery: '',
      searchResults: null,
      isSearching: false,
      typeFilter: 'all',
    });
    await render(<FileBrowser />);
    await act(async () => useFileStore.getState().setSearchQuery('合同'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const text = container.textContent ?? '';
    expect(text).toContain('合同-A.txt');
    expect(text).toContain('合同-B.txt');
    // 两个同类型成果都显示类型名的话，这两条断言不可能同时成立。
    expect(text).not.toBe(i18n.t('artifactKinds.text'));
  });
});
