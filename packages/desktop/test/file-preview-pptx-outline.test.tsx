// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `.pptx` 预览的**渲染层**：用户做完一份演示文稿，在应用里要能看见它写了什么。
 *
 * 判据是"屏幕上真的有那些字、且**一页一块**"：
 *  - 只有"读到 slides 数组"不算 —— 那一层不渲染的话，用户看到的是一个空框；
 *  - 顺序与页码要钉住：`slide10` 排在 `slide2` 前面是这类代码最经典的坑，
 *    而主进程已经按数字排好了，这里验的是**渲染时没有把顺序丢掉**。
 *
 * ⚠️ 这里如实说"这是文字大纲"：界面不许把它装成像素级还原（主进程那份注释也是这么定的）。
 */

const { previewArtifactSpy, readArtifactFileSpy } = vi.hoisted(() => ({
  previewArtifactSpy: vi.fn(),
  readArtifactFileSpy: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // 把参数渲染出来，这样"第几页"这种**值**也进得了断言（只断言 key 绑不住值）
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}(${JSON.stringify(options)})` : key),
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import FilePreview from '../src/renderer/components/FilePreview';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const artifact = {
  id: 'a1',
  taskId: 't1',
  name: '九月经营简报.pptx',
  size: 24_000,
  mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  localPath: 't1/九月经营简报.pptx',
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

const SLIDES = [
  { index: 1, lines: ['九月经营简报', '2026-09-26 · 产品组'] },
  { index: 2, lines: ['本月完成情况', '文档生成能力已落地', '2 / 6'] },
  { index: 3, lines: ['关键指标', '周活 1,240', '3 / 6'] },
];

beforeEach(() => {
  vi.clearAllMocks();
  previewArtifactSpy.mockResolvedValue({ ok: true, result: { kind: 'pptx', slides: SLIDES, truncated: false } });
  readArtifactFileSpy.mockResolvedValue({ ok: true, result: { content: '', encoding: 'utf-8' } });
  Object.assign(window, {
    clawwork: { previewArtifact: previewArtifactSpy, readArtifactFile: readArtifactFileSpy },
  });
});

describe('FilePreview — .pptx 文字大纲', () => {
  it('⭐ 每一页的中文内容都真的上屏了', async () => {
    const { container, unmount } = render(<FilePreview artifact={artifact} onNavigateToTask={() => {}} />);
    await flush();

    const text = container.textContent ?? '';
    expect(text).toContain('九月经营简报');
    expect(text).toContain('本月完成情况');
    expect(text).toContain('文档生成能力已落地');
    expect(text).toContain('周活 1,240');
    unmount();
  });

  it('⭐ 一页一块，且**页号来自数据**（不是数组下标）', async () => {
    const { container, unmount } = render(<FilePreview artifact={artifact} onNavigateToTask={() => {}} />);
    await flush();

    const sections = [...container.querySelectorAll('section')];
    expect(sections).toHaveLength(3);
    // 页号必须是主进程给的那个值 —— 用下标渲染的话，跳页/截断时会整体错位
    expect(sections.map((s) => s.querySelector('h4')?.textContent)).toEqual([
      'filePreview.slideLabel({"index":1})',
      'filePreview.slideLabel({"index":2})',
      'filePreview.slideLabel({"index":3})',
    ]);
    // 块与块之间不能串页
    expect(sections[1].textContent).toContain('本月完成情况');
    expect(sections[1].textContent).not.toContain('九月经营简报');
    unmount();
  });

  it('页码那行也在里面（用户要靠它跟 PowerPoint 的页码对上）', async () => {
    const { container, unmount } = render(<FilePreview artifact={artifact} onNavigateToTask={() => {}} />);
    await flush();
    expect(container.textContent).toContain('2 / 6');
    expect(container.textContent).toContain('3 / 6');
    unmount();
  });

  it('空页给一句"这页没有文字"，不留一个看着像坏了的空白块', async () => {
    previewArtifactSpy.mockResolvedValue({
      ok: true,
      result: { kind: 'pptx', slides: [{ index: 1, lines: [] }], truncated: false },
    });
    const { container, unmount } = render(<FilePreview artifact={artifact} onNavigateToTask={() => {}} />);
    await flush();
    expect(container.textContent).toContain('filePreview.slideEmpty');
    unmount();
  });

  it('截断了要说（装作完整会让用户以为"我的 PPT 就这么点内容"）', async () => {
    previewArtifactSpy.mockResolvedValue({ ok: true, result: { kind: 'pptx', slides: SLIDES, truncated: true } });
    const { container, unmount } = render(<FilePreview artifact={artifact} onNavigateToTask={() => {}} />);
    await flush();
    const text = container.textContent ?? '';
    expect(text.toLowerCase()).toContain('truncat');
    unmount();
  });

  it('负对照：没写过的字必须不在屏上（否则上面的 toContain 可能恒真）', async () => {
    const { container, unmount } = render(<FilePreview artifact={artifact} onNavigateToTask={() => {}} />);
    await flush();
    expect(container.textContent).not.toContain('这句话压根没写过');
    unmount();
  });
});
