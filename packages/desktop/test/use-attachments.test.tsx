// @vitest-environment jsdom

/**
 * `useAttachments` 的 blob URL 生命周期（2026-10-07 · 质量战役区 2 · P2-5）。
 *
 * 为什么单独钉：`previewUrl` 是 `URL.createObjectURL` 造的 blob URL，**回收是义务** ——
 * 不回收，粘贴过的每张图都常驻内存。修复前 unmount 清理是**过期闭包空转**
 * （`useEffect([], ...)` 捕获首渲染的空数组，永远 revoke 不到任何东西；
 * 从 2026-03-26 `useImageAttachments.ts` 起就带着这个洞）。这里钉两处：
 *   ① 卸载时**真的**回收当时在场的每一个 URL（ref 镜像修复的回归钉）；
 *   ② 一键裁剪（`trimAttachments`）把裁掉的那一段也回收（裁剪 = 一次丢一堆）。
 */

import { act, type ClipboardEvent as ReactClipboardEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { useAttachments } from '../src/renderer/components/ChatInput/useAttachments';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type AttachmentsApi = ReturnType<typeof useAttachments>;
let latest: AttachmentsApi | null = null;

function Harness() {
  latest = useAttachments();
  return <div data-testid="count">{latest.pendingAttachments.length}</div>;
}

function render(): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(<Harness />));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** 直接调 `handlePaste`（真机上由 textarea 的 onPaste 驱动；形状与真事件一致）。 */
function paste(files: File[]): void {
  const event = {
    clipboardData: { items: files.map((file) => ({ kind: 'file', getAsFile: () => file })) },
    preventDefault: vi.fn(),
  } as unknown as ReactClipboardEvent;
  act(() => latest!.handlePaste(event));
}

let urlSeq = 0;

beforeEach(() => {
  urlSeq = 0;
  latest = null;
  document.body.innerHTML = '';
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:mock-${++urlSeq}`),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAttachments blob URL 生命周期', () => {
  it('⭐ 卸载时回收**当时在场**的每个 blob URL（修过期闭包空转）', () => {
    const view = render();
    paste([new File(['a'], 'shot-1.png', { type: 'image/png' })]);
    paste([new File(['b'], 'shot-2.png', { type: 'image/png' })]);
    expect(latest!.pendingAttachments).toHaveLength(2);

    view.unmount();

    // 修复前：清理闭包捕获的是首渲染的空数组 ⇒ 一次都不会调用（本断言红）
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-2');
  });

  it('⭐ trimAttachments：只保留前 N 个，裁掉的当场回收（一次丢一堆也不漏）', () => {
    const view = render();
    paste([
      new File(['a'], 'shot-1.png', { type: 'image/png' }),
      new File(['b'], 'shot-2.png', { type: 'image/png' }),
      new File(['c'], 'shot-3.png', { type: 'image/png' }),
    ]);
    expect(latest!.pendingAttachments).toHaveLength(3);

    act(() => latest!.trimAttachments(2));

    expect(latest!.pendingAttachments.map((att) => att.file.name)).toEqual(['shot-1.png', 'shot-2.png']);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-3');
    view.unmount();
  });

  it('裁剪数 ≥ 当前个数时原样不动（不制造无谓的 state 变更与回收）', () => {
    const view = render();
    paste([new File(['a'], 'shot-1.png', { type: 'image/png' })]);

    act(() => latest!.trimAttachments(30));

    expect(latest!.pendingAttachments).toHaveLength(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    view.unmount();
  });
});
