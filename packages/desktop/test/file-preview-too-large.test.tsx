// @vitest-environment jsdom

/**
 * "文件太大"这件事在界面上的**两条路**（2026-09-27）。
 *
 * ## 这个缺口原来长什么样
 *
 * `.html` 超过 `MAX_HTML_PREVIEW_BYTES`(4 MiB) ⇒ 主进程回 `unsupported` ⇒ 界面掉到
 * `artifact:read-file` —— **那条路没有上限**。于是"太大所以不给富预览"直接变成
 * "太大所以整份读进内存、跨 IPC、再整份进同步高亮"，界面卡死，而且**一句话都没有**。
 *
 * ## 判据为什么是这两条
 *
 *  1. **正**：没超限的文件照旧走富预览 —— 补上限不能顺手把正常路径掐死；
 *  2. **反**：超限时界面说一句**带大小的人类话**，且**一个字节的文件内容都不进 DOM**
 *     （没有 `<pre>`、没有高亮节点）—— 这才是"不整份进高亮链"在界面这一层的样子。
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ⚠️ `t` 必须**把插值参数露出来**（不能只回一个裸键）：这个测试要证明的是
 *    "大小真的传到了文案里"，而不是"界面上出现了某个键"。
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}|${JSON.stringify(options)}` : key),
  }),
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
  name: '大页面.html',
  size: 30 * 1024 * 1024,
  mimeType: 'text/html',
  localPath: 't1/大页面.html',
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
  Object.assign(window, {
    clawwork: { previewArtifact: previewArtifactSpy, readArtifactFile: readArtifactFileSpy },
  });
});

describe('FilePreview — 文件太大', () => {
  it('⭐ 正：没超限 ⇒ 富预览照旧（补上限不能把正常路径掐死）', async () => {
    previewArtifactSpy.mockResolvedValue({ ok: true, result: { kind: 'html', html: '<p>正文</p>' } });
    const { container, unmount } = render(<FilePreview artifact={artifact} onNavigateToTask={() => {}} />);
    await flush();

    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toContain('<p>正文</p>');
    expect(readArtifactFileSpy, '富预览成功时不该再走文本这条路').not.toHaveBeenCalled();
    unmount();
  });

  it('⭐ 反：超限 ⇒ 说一句带大小的话，且**内容一个字节都不进 DOM**', async () => {
    // 主进程：太大，不给富预览（这就是 4 MiB 那条分支的输出）
    previewArtifactSpy.mockResolvedValue({ ok: true, result: { kind: 'unsupported' } });
    // 主进程：朴素读法也拒绝整份搬（回结构化结果，**没有 content**）
    readArtifactFileSpy.mockResolvedValue({ ok: true, result: { tooLarge: true, size: 30 * 1024 * 1024 } });

    const { container, unmount } = render(<FilePreview artifact={artifact} onNavigateToTask={() => {}} />);
    await flush();

    const note = container.querySelector('[data-testid="preview-too-large"]');
    expect(note, '要有一句可读提示（不是白屏）').toBeTruthy();
    expect(note?.textContent).toContain('filePreview.tooLargeToRead');
    // ⭐ 大小必须真的传进文案 —— 只说"太大"用户没法判断下一步
    expect(note?.textContent).toContain('"size":"30.0 MB"');
    // ⭐ 高亮链一个字都没进：这条路的内容本该整份进 `hljs.highlight`
    expect(container.querySelector('pre'), '不许把内容渲染成代码块').toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    unmount();
  });

  it('⭐ `tooLarge` 不能被当成"空文件"（那会渲染出一块空白，用户以为文件本来就是空的）', async () => {
    previewArtifactSpy.mockResolvedValue({ ok: true, result: { kind: 'unsupported' } });
    readArtifactFileSpy.mockResolvedValue({ ok: true, result: { tooLarge: true, size: 5 * 1024 * 1024 } });

    const { container, unmount } = render(<FilePreview artifact={artifact} onNavigateToTask={() => {}} />);
    await flush();

    expect(container.textContent).not.toContain('undefined');
    expect(container.querySelector('pre')).toBeNull();
    unmount();
  });

  it('对照：真读坏了 ⇒ 照旧报错（别把"文件坏了"也吞成"太大"）', async () => {
    previewArtifactSpy.mockResolvedValue({ ok: true, result: { kind: 'unsupported' } });
    readArtifactFileSpy.mockResolvedValue({ ok: false, error: 'artifact unsafe' });

    const { container, unmount } = render(<FilePreview artifact={artifact} onNavigateToTask={() => {}} />);
    await flush();

    // ⚠️ 2026-10-09 有意改写（Task 1）：错误态**仍在**（与 tooLarge 不混，本用例的语义不变），
    //    只是不再把内部标记（`artifact unsafe`）原样上屏 —— 换成用户能读懂、可行动的一句话。
    expect(container.textContent).toContain('filePreview.readFailed');
    expect(container.textContent).not.toContain('artifact unsafe');
    expect(container.querySelector('[data-testid="preview-too-large"]')).toBeNull();
    unmount();
  });
});
