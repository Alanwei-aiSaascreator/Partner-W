import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceDatabaseOwner } from '../src/main/workspace/scope.js';

const mocks = vi.hoisted(() => ({
  evaluateSlide: vi.fn(),
  emitPageShapes: vi.fn(),
  writeSlidePptx: vi.fn(),
  saveArtifactFromBuffer: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../src/main/slidegen/evaluate.js', () => ({ evaluateSlide: mocks.evaluateSlide }));
vi.mock('../src/main/slidegen/pipeline.js', () => ({ emitPageShapes: mocks.emitPageShapes }));
vi.mock('../src/main/slidegen/emit.js', () => ({ writeSlidePptx: mocks.writeSlidePptx }));
vi.mock('../src/main/artifact/save.js', () => ({ saveArtifactFromBuffer: mocks.saveArtifactFromBuffer }));
vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({ info: mocks.info, warn: mocks.warn }),
}));

const { generateSlidesFromMessage } = await import('../src/main/slidegen/generate.js');

function deck(title: string): string {
  return ['```slidegen', `// title: ${title}`, '<Slide></Slide>', '```'].join('\n');
}

function pages(count: number): unknown[] {
  return Array.from({ length: count }, () => ({ kind: 'element', tag: 'Slide', props: {}, children: [] }));
}

describe('slidegen 单消息累计页数预算', () => {
  beforeEach(() => {
    setWorkspaceDatabaseOwner({});
    vi.clearAllMocks();
    mocks.evaluateSlide.mockReturnValueOnce(pages(120)).mockReturnValueOnce(pages(81));
    mocks.emitPageShapes.mockResolvedValue({ page: { shapes: [], background: 'FFFFFF' }, warnings: [] });
  });

  it('⭐ 120 + 81 页立即拒绝，后续 deck 不再求值且没有任何渲染或写盘', async () => {
    const result = await generateSlidesFromMessage({
      workspacePath: 'D:\\workspace-that-does-not-exist',
      taskId: 'task-1',
      messageId: 'message-1',
      content: `${deck('第一份')}\n\n${deck('第二份')}\n\n${deck('不应求值的第三份')}`,
    });

    expect(result.failed).toContainEqual({ code: 'slidegen-too-many-pages', max: 200, got: 201 });
    expect(mocks.evaluateSlide).toHaveBeenCalledTimes(2);
    expect(mocks.emitPageShapes).not.toHaveBeenCalled();
    expect(mocks.writeSlidePptx).not.toHaveBeenCalled();
    expect(mocks.saveArtifactFromBuffer).not.toHaveBeenCalled();
  });

  it('counts a reused deck before deciding whether the remaining deck can render', async () => {
    const reuseExisting = vi.fn(() => []);
    const input = {
      workspacePath: 'D:\\workspace-that-does-not-exist',
      taskId: 'task-1',
      messageId: 'message-1',
      content: `${deck('Existing')}\n${deck('New')}`,
      reuseExisting,
    };
    const result = await generateSlidesFromMessage(input);
    expect(result.failed).toContainEqual({ code: 'slidegen-too-many-pages', max: 200, got: 201 });
    expect(reuseExisting).not.toHaveBeenCalled();
    expect(mocks.emitPageShapes).not.toHaveBeenCalled();
    expect(mocks.saveArtifactFromBuffer).not.toHaveBeenCalled();
  });
});
