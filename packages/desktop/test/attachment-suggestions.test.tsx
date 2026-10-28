// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { AttachmentAction } from '../src/renderer/lib/attachment-actions';

const t = (key: string) => key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('../src/renderer/lib/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}));

import AttachmentSuggestions from '../src/renderer/components/ChatInput/AttachmentSuggestions';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function click(container: HTMLElement, label: string): void {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(label));
  if (!button) throw new Error(`button not found: ${label}`);
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('AttachmentSuggestions', () => {
  it('图片 → 三个「识别图片」动作都在（提取文字 / 总结图片 / 分析内容）', () => {
    const { container, unmount } = render(
      <AttachmentSuggestions
        files={[{ fileName: 'shot.png', mimeType: 'image/png' }]}
        imageInput="supported"
        onAction={vi.fn()}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('chatInput.attachmentActions.extractImageText');
    expect(text).toContain('chatInput.attachmentActions.summarizeImage');
    expect(text).toContain('chatInput.attachmentActions.analyzeImage');
    unmount();
  });

  it('点击动作把**整个动作**交回去（发送 / 预填由上层决定）', () => {
    const onAction = vi.fn<(action: AttachmentAction) => void>();
    const { container, unmount } = render(
      <AttachmentSuggestions
        files={[{ fileName: 'shot.png', mimeType: 'image/png' }]}
        imageInput="supported"
        onAction={onAction}
      />,
    );
    click(container, 'chatInput.attachmentActions.extractImageText');
    expect(onAction).toHaveBeenCalledTimes(1);
    const action = onAction.mock.calls[0]![0];
    expect(action.id).toBe('extract-image-text');
    expect(action.autoSend).toBe(true);
    unmount();
  });

  it('表格：修改 / 生成汇报也出现在建议里（写类动作亮明身份）', () => {
    const { container, unmount } = render(
      <AttachmentSuggestions files={[{ fileName: '报表.xlsx' }]} imageInput="unknown" onAction={vi.fn()} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('chatInput.attachmentActions.analyzeData');
    expect(text).toContain('chatInput.attachmentActions.modifyFile');
    expect(text).toContain('chatInput.attachmentActions.generateReport');
    unmount();
  });

  it('模型确实不看图时如实说明（不假装能识别）——行里还有其他文件动作时给这句诚实说明', () => {
    const { container, unmount } = render(
      <AttachmentSuggestions
        files={[{ fileName: '报表.xlsx' }, { fileName: 'shot.png', mimeType: 'image/png' }]}
        imageInput="unsupported"
        onAction={vi.fn()}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('chatInput.attachmentActions.imageUnsupported');
    // 图片动作本身仍不露出（诚实说明 ≠ 承诺能识别）
    expect(text).not.toContain('chatInput.attachmentActions.extractImageText');
    unmount();
  });

  /**
   * ⭐ 2026-10-07（vision 入口降级 · 用户拍板）：非 supported（unknown / unsupported）时
   * 「识别图片」入口不露出 —— 拖图后模型读不到，露出动作就是一句兑现不了的承诺。
   * 只拖图片时整行都不渲染（不占位）；能力恢复（目录自述 image）后自动回来，无需改代码。
   */
  it('⭐ 模型没自述支持看图（unknown / unsupported）→ 图片动作不露出（只拖图时整行不渲染）', () => {
    for (const imageInput of ['unknown', 'unsupported'] as const) {
      const { container, unmount } = render(
        <AttachmentSuggestions
          files={[{ fileName: 'shot.png', mimeType: 'image/png' }]}
          imageInput={imageInput}
          onAction={vi.fn()}
        />,
      );
      const text = container.textContent ?? '';
      expect(text, imageInput).not.toContain('chatInput.attachmentActions.extractImageText');
      expect(text, imageInput).not.toContain('chatInput.attachmentActions.summarizeImage');
      expect(text, imageInput).not.toContain('chatInput.attachmentActions.analyzeImage');
      expect(container.querySelector('[data-testid="attachment-suggestions"]'), imageInput).toBeNull();
      unmount();
    }
  });

  it('模型能看图 / 能力未知时都不说那句（不替模型下结论）', () => {
    for (const imageInput of ['supported', 'unknown'] as const) {
      const { container, unmount } = render(
        <AttachmentSuggestions
          files={[{ fileName: 'shot.png', mimeType: 'image/png' }]}
          imageInput={imageInput}
          onAction={vi.fn()}
        />,
      );
      expect(container.textContent).not.toContain('chatInput.attachmentActions.imageUnsupported');
      unmount();
    }
  });

  it('没有可给的动作时整行不渲染（不占位）', () => {
    const { container, unmount } = render(<AttachmentSuggestions files={[]} imageInput="unknown" onAction={vi.fn()} />);
    expect(container.textContent).toBe('');
    unmount();
  });
});
