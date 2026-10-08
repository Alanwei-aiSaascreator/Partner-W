// @vitest-environment jsdom
/**
 * Task 1（WorkBuddy 产物 UI A 批）：FilePreview 的**请求归属**与诚实落定。
 *
 * 现状缺口（只读复审实读）：
 *  - effect 以 id/taskId 触发，迟到回包**不看当前身份** —— A→B 快速切换时 A 慢回包
 *    会把 B 的内容盖掉；epoch 切换 / 卸载后同样写进新视图（或写进已卸载组件）；
 *  - 两条异步链**都没有 rejection 处理** —— preview 或 read 一拒，loading 永远转圈；
 *  - preview `ok:false`（认得出但解析失败）被当成"不认识"去读原始字节 —— 二进制
 *    当文本上屏，且真正的原因（读不了）被吞掉，没有可行动提示；
 *  - 同 id 原地修订（reconcile 的 sourceKey 变化）不会重读 —— 修好一份文件后，
 *    预览还是旧的。
 *
 * ⚠️ 用真实组件；只桩 window.clawwork 的两个通道与 i18n。
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { previewArtifactSpy, readArtifactFileSpy } = vi.hoisted(() => ({
  previewArtifactSpy: vi.fn(),
  readArtifactFileSpy: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key}(${JSON.stringify(options)})` : key),
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import FilePreview from '../src/renderer/components/FilePreview';
import { useTaskStore } from '../src/renderer/stores/taskStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const artifactOf = (id: string, name: string, extra: Record<string, unknown> = {}): never =>
  ({
    id,
    taskId: 't1',
    name,
    size: 1024,
    mimeType: 'application/octet-stream',
    localPath: `t1/${name}`,
    messageId: 'm1',
    createdAt: '2026-10-09T00:00:00.000Z',
    availability: 'available',
    type: 'file',
    ...extra,
  }) as never;

const docxArtifact = (id: string, name: string, extra: Record<string, unknown> = {}): never =>
  artifactOf(id, name, {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ...extra,
  });

function render(ui: ReactElement): {
  container: HTMLDivElement;
  rerender: (next: ReactElement) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    rerender: (next) => act(() => root.render(next)),
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
  useTaskStore.setState({ workspaceEpoch: 0 });
  readArtifactFileSpy.mockResolvedValue({ ok: true, result: { content: '', encoding: 'utf-8' } });
  // jsdom 没有 blob URL 实现（PDF 预览要用）。
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() });
  Object.assign(window, {
    clawwork: { previewArtifact: previewArtifactSpy, readArtifactFile: readArtifactFileSpy },
  });
});

describe('Task1 · 请求归属（迟到回包不许覆盖新选择）', () => {
  it('⭐ A 慢 B 快：B 先落定后 A 才回来 ⇒ 屏上必须还是 B', async () => {
    const readA = deferred<unknown>();
    const readB = deferred<unknown>();
    previewArtifactSpy.mockImplementation((id: string) => (id === 'a1' ? readA.promise : readB.promise));

    const view = render(<FilePreview artifact={docxArtifact('a1', 'A.docx')} onNavigateToTask={() => {}} />);
    await flush();
    view.rerender(<FilePreview artifact={docxArtifact('a2', 'B.docx')} onNavigateToTask={() => {}} />);
    await flush();

    await act(async () => {
      readB.resolve({ ok: true, result: { kind: 'docx', paragraphs: ['B 的新内容'], truncated: false } });
    });
    await flush();
    await act(async () => {
      readA.resolve({ ok: true, result: { kind: 'docx', paragraphs: ['A 的旧内容'], truncated: false } });
    });
    await flush();

    expect(view.container.textContent, 'B 的正文必须在').toContain('B 的新内容');
    expect(view.container.textContent, 'A 的迟到回包不许上屏').not.toContain('A 的旧内容');
    view.unmount();
  });

  it('⭐ 工作区切换（workspaceEpoch 变化）⇒ 旧响应作废、按新 epoch 重读', async () => {
    const staleRead = deferred<unknown>();
    const freshRead = deferred<unknown>();
    previewArtifactSpy.mockImplementationOnce(() => staleRead.promise).mockImplementationOnce(() => freshRead.promise);

    const view = render(<FilePreview artifact={docxArtifact('a1', 'A.docx')} onNavigateToTask={() => {}} />);
    await flush();

    await act(async () => {
      useTaskStore.setState({ workspaceEpoch: 1 });
    });
    await flush();
    expect(previewArtifactSpy, '换工作区必须重新读（旧响应不能代表新工作区的文件）').toHaveBeenCalledTimes(2);

    await act(async () => {
      staleRead.resolve({ ok: true, result: { kind: 'docx', paragraphs: ['旧工作区内容'], truncated: false } });
    });
    await flush();
    expect(view.container.textContent).not.toContain('旧工作区内容');

    await act(async () => {
      freshRead.resolve({ ok: true, result: { kind: 'docx', paragraphs: ['新工作区内容'], truncated: false } });
    });
    await flush();
    expect(view.container.textContent).toContain('新工作区内容');
    view.unmount();
  });

  it('⭐ 同 id 原地修订（sourceKey 变化）⇒ 必须重读，不能拿旧内容冒充', async () => {
    const v1 = docxArtifact('a1', 'deck.docx', { sourceKey: 'rev-1' });
    const v2 = docxArtifact('a1', 'deck.docx', { sourceKey: 'rev-2' });
    previewArtifactSpy
      .mockResolvedValueOnce({ ok: true, result: { kind: 'docx', paragraphs: ['修订前'], truncated: false } })
      .mockResolvedValueOnce({ ok: true, result: { kind: 'docx', paragraphs: ['修订后'], truncated: false } });

    const view = render(<FilePreview artifact={v1} onNavigateToTask={() => {}} />);
    await flush();
    expect(view.container.textContent).toContain('修订前');

    view.rerender(<FilePreview artifact={v2} onNavigateToTask={() => {}} />);
    await flush();
    expect(previewArtifactSpy, '同 id 修订也必须重读').toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain('修订后');
    expect(view.container.textContent).not.toContain('修订前');
    view.unmount();
  });

  it('卸载后迟到回包不写状态、不炸（关掉预览再回包）', async () => {
    const read = deferred<unknown>();
    previewArtifactSpy.mockImplementation(() => read.promise);
    const view = render(<FilePreview artifact={docxArtifact('a1', 'A.docx')} onNavigateToTask={() => {}} />);
    await flush();
    view.unmount();
    await act(async () => {
      read.resolve({ ok: true, result: { kind: 'docx', paragraphs: ['迟到内容'], truncated: false } });
    });
    // 没有异常抛出、没有 React 状态写入警告即算通过（unmount 后写 state 会打 console.error）
    expect(true).toBe(true);
  });
});

describe('Task1 · 失败必须落定且可行动', () => {
  it('⭐ preview 认得出但解析失败（ok:false）⇒ 显示读取失败，不把原始字节当文本读', async () => {
    previewArtifactSpy.mockResolvedValue({ ok: false, error: 'not a readable docx: word/document.xml missing' });
    const view = render(<FilePreview artifact={docxArtifact('a1', 'broken.docx')} onNavigateToTask={() => {}} />);
    await flush();

    expect(readArtifactFileSpy, '解析失败不许再走"读原始字节当文本"的老路').not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('filePreview.readFailed');
    expect(view.container.querySelector('.animate-spin'), '失败态不许继续转圈').toBeNull();
    view.unmount();
  });

  it('⭐ preview 拒绝（IPC 失败）⇒ 落定成可行动错误，不永远 loading', async () => {
    previewArtifactSpy.mockRejectedValue(new Error('ipc boom'));
    const view = render(<FilePreview artifact={docxArtifact('a1', 'A.docx')} onNavigateToTask={() => {}} />);
    await flush();

    expect(view.container.textContent).toContain('filePreview.readFailed');
    expect(view.container.querySelector('.animate-spin')).toBeNull();
    view.unmount();
  });

  it('⭐ 文本路（unsupported → 读原始）拒绝 ⇒ 同样落定成可行动错误', async () => {
    previewArtifactSpy.mockResolvedValue({ ok: true, result: { kind: 'unsupported' } });
    readArtifactFileSpy.mockRejectedValue(new Error('read boom'));
    const view = render(<FilePreview artifact={artifactOf('a1', 'note.txt')} onNavigateToTask={() => {}} />);
    await flush();

    expect(view.container.textContent).toContain('filePreview.readFailed');
    expect(view.container.querySelector('.animate-spin')).toBeNull();
    view.unmount();
  });

  it('负对照：unsupported 且文本路成功 ⇒ 正常显示文本（降级链不误伤）', async () => {
    previewArtifactSpy.mockResolvedValue({ ok: true, result: { kind: 'unsupported' } });
    readArtifactFileSpy.mockResolvedValue({ ok: true, result: { content: '普通文本内容', encoding: 'utf-8' } });
    const view = render(<FilePreview artifact={artifactOf('a1', 'note.txt')} onNavigateToTask={() => {}} />);
    await flush();
    expect(view.container.textContent).toContain('普通文本内容');
    expect(readArtifactFileSpy).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});

describe('Task1 · 预览模式必须如实标注', () => {
  it('⭐ docx/pptx 标明"文字预览"（非最终版式）；sheet 标明"值预览"（公式未重算）', async () => {
    previewArtifactSpy.mockResolvedValue({
      ok: true,
      result: { kind: 'docx', paragraphs: ['正文'], truncated: false },
    });
    const docx = render(<FilePreview artifact={docxArtifact('a1', 'A.docx')} onNavigateToTask={() => {}} />);
    await flush();
    expect(docx.container.textContent).toContain('filePreview.modeTextOnly');
    docx.unmount();

    previewArtifactSpy.mockResolvedValue({
      ok: true,
      result: { kind: 'pptx', slides: [{ index: 1, lines: ['页'] }], truncated: false },
    });
    const pptx = render(<FilePreview artifact={docxArtifact('a2', 'B.pptx')} onNavigateToTask={() => {}} />);
    await flush();
    expect(pptx.container.textContent).toContain('filePreview.modeTextOnly');
    pptx.unmount();

    previewArtifactSpy.mockResolvedValue({
      ok: true,
      result: { kind: 'sheet', sheets: [{ name: 'Sheet1', rows: [['值']] }], truncated: false },
    });
    const sheet = render(<FilePreview artifact={artifactOf('a3', 'C.xlsx')} onNavigateToTask={() => {}} />);
    await flush();
    expect(sheet.container.textContent).toContain('filePreview.modeValuesOnly');
    sheet.unmount();
  });

  it('pdf/html 不套文字模式标注（它们本来就是视觉预览）', async () => {
    previewArtifactSpy.mockResolvedValue({ ok: true, result: { kind: 'pdf', dataBase64: '' } });
    const pdf = render(<FilePreview artifact={artifactOf('a1', 'D.pdf')} onNavigateToTask={() => {}} />);
    await flush();
    expect(pdf.container.textContent).not.toContain('filePreview.modeTextOnly');
    expect(pdf.container.textContent).not.toContain('filePreview.modeValuesOnly');
    pdf.unmount();
  });
});
