// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

const { previewArtifactSpy, readArtifactFileSpy } = vi.hoisted(() => ({
  previewArtifactSpy: vi.fn(),
  readArtifactFileSpy: vi.fn(),
}));

import FilePreview from '../src/renderer/components/FilePreview';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const artifact = {
  id: 'a1',
  taskId: 't1',
  name: '页面.html',
  size: 128,
  mimeType: 'text/html',
  localPath: 't1/页面.html',
  // H4：真实 Artifact 必带 availability（缺省=unknown ≠ 可读）——夹具补上，语义不变。
  availability: 'available',
} as never;

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

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  readArtifactFileSpy.mockResolvedValue({ ok: true, result: { content: '<p>原文</p>', encoding: 'utf-8' } });
  Object.assign(window, {
    clawwork: { previewArtifact: previewArtifactSpy, readArtifactFile: readArtifactFileSpy },
  });
});

/**
 * `.html` 预览的**渲染层**（2026-09-26）。
 *
 * ⚠️ 这一条测的不是"画得好不好看"，而是**封堵**：一份 HTML 是唯一一种
 *    "内容本身可执行"的产物，而它要被画在**应用自己的界面**里。
 *    判据三条：
 *      1. 用 iframe 画，**不把 HTML 注进应用自己的文档**；
 *      2. iframe 必须带 `sandbox`，且**不含** `allow-scripts` / `allow-same-origin`
 *         （这两个一给，iframe 里的脚本就能摸到父窗口的 `window.clawwork`）；
 *      3. 走 `srcdoc`（不是把内容拼进 src、也不是 file://）。
 */
describe('FilePreview — .html 预览', () => {
  it('⭐ 用带 sandbox 的 iframe 画，且 srcdoc 是主进程读过的那份', async () => {
    previewArtifactSpy.mockResolvedValue({
      ok: true,
      result: { kind: 'html', html: '<meta http-equiv="Content-Security-Policy"><p>正文</p>' },
    });
    const { container, unmount } = render(<FilePreview artifact={artifact} onNavigateToTask={() => {}} />);
    await flush();

    const iframe = container.querySelector('iframe');
    expect(iframe, '要用 iframe 画').toBeTruthy();
    expect(iframe?.getAttribute('srcdoc')).toContain('<p>正文</p>');
    unmount();
  });

  it('⭐ sandbox 里**不许**出现 allow-scripts / allow-same-origin', async () => {
    previewArtifactSpy.mockResolvedValue({ ok: true, result: { kind: 'html', html: '<p>x</p>' } });
    const { container, unmount } = render(<FilePreview artifact={artifact} onNavigateToTask={() => {}} />);
    await flush();

    const sandbox = container.querySelector('iframe')?.getAttribute('sandbox');
    expect(sandbox, 'sandbox 属性必须在').not.toBeNull();
    expect(sandbox).not.toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    unmount();
  });

  it('⭐ HTML 不许被注进应用自己的文档（只进 iframe）', async () => {
    previewArtifactSpy.mockResolvedValue({ ok: true, result: { kind: 'html', html: '<p id="外来内容">x</p>' } });
    const { container, unmount } = render(<FilePreview artifact={artifact} onNavigateToTask={() => {}} />);
    await flush();

    // 如果哪天有人改成 dangerouslySetInnerHTML，这个探测元素就会出现在应用的 DOM 里
    expect(container.querySelector('#外来内容')).toBeNull();
    expect(readArtifactFileSpy, '富预览成功时不该再走文本这条路').not.toHaveBeenCalled();
    unmount();
  });

  it('主进程说 unsupported（比如文件太大）⇒ 退回文本视图，不当成错误', async () => {
    previewArtifactSpy.mockResolvedValue({ ok: true, result: { kind: 'unsupported' } });
    readArtifactFileSpy.mockResolvedValue({ ok: true, result: { content: '<p>原文</p>', encoding: 'utf-8' } });
    const { container, unmount } = render(<FilePreview artifact={artifact} onNavigateToTask={() => {}} />);
    await flush();

    expect(container.querySelector('iframe')).toBeNull();
    expect(container.textContent).toContain('原文');
    unmount();
  });
});
