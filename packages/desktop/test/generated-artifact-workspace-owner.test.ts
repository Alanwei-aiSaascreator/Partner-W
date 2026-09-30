import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setWorkspaceDatabaseOwner } from '../src/main/workspace/scope.js';

const mocks = vi.hoisted(() => ({ save: vi.fn(), render: vi.fn(), html: vi.fn(), page: vi.fn() }));
vi.mock('../src/main/artifact/save.js', () => ({ saveArtifactFromBuffer: mocks.save }));
vi.mock('../src/main/docgen/render.js', () => ({ renderDocument: mocks.render }));
vi.mock('../src/main/htmlgen/templates.js', () => ({
  renderHtmlgenDocument: mocks.html,
  HtmlgenOutputTooLargeError: class extends Error {},
}));
vi.mock('../src/main/htmlgen/blocks.js', () => ({
  extractHtmlgenBlocks: () => ({ requests: [{ title: 'page', template: 'report' }], failures: [] }),
}));
vi.mock('../src/main/slidegen/pipeline.js', () => ({ emitPageShapes: mocks.page }));
vi.mock('../src/main/slidegen/emit.js', () => ({
  writeSlidePptx: async (_pages: unknown, file: string) => {
    writeFileSync(file, 'pptx');
  },
}));
const { generateDocumentsFromMessage } = await import('../src/main/docgen/generate.js');
const { generateHtmlPagesFromMessage } = await import('../src/main/htmlgen/generate.js');
const { generateSlidesFromMessage } = await import('../src/main/slidegen/generate.js');
let workspacePath = '';
const owner = {};
beforeEach(() => {
  vi.resetAllMocks();
  setWorkspaceDatabaseOwner(owner);
  workspacePath = mkdtempSync(join(tmpdir(), 'generated-artifact-owner-'));
  mocks.save.mockResolvedValue({ name: 'generated.file' });
});
afterEach(() => {
  setWorkspaceDatabaseOwner(null);
  rmSync(workspacePath, { recursive: true, force: true });
});

it.each(['pptx', 'docx', 'html', 'slidegen'] as const)(
  'does not save %s into the replacement database after rendering awaits',
  async (kind) => {
    let complete!: () => void;
    const gate = new Promise<void>((resolve) => {
      complete = resolve;
    });
    mocks.render.mockImplementation(async () => {
      await gate;
      return Buffer.from('document');
    });
    mocks.html.mockImplementation(async () => {
      await gate;
      return Buffer.from('html');
    });
    mocks.page.mockImplementation(async () => {
      await gate;
      return { page: {}, warnings: [] };
    });
    const input = { workspacePath, taskId: 'task', messageId: 'message', content: '' };
    const pending =
      kind === 'html'
        ? generateHtmlPagesFromMessage(input)
        : kind === 'slidegen'
          ? generateSlidesFromMessage({ ...input, content: '```slidegen\n// title: deck\n<Slide/>\n```' })
          : generateDocumentsFromMessage({
              ...input,
              content: [
                '```docgen',
                JSON.stringify(
                  kind === 'pptx'
                    ? { kind, title: 'deck', slides: [{ title: 'slide', bullets: ['hello'] }] }
                    : { kind, title: 'document', sections: [{ heading: 'heading', paragraphs: ['hello'] }] },
                ),
                '```',
              ].join('\n'),
            });
    // A newly opened DB may use the same path and identical task/message IDs.
    setWorkspaceDatabaseOwner({});
    complete();
    const result = await pending;
    expect(mocks.save).not.toHaveBeenCalled();
    expect(result.saved).toEqual([]);
    expect(result.failed).toHaveLength(1);
  },
);

it('an unchanged owner permits normal artifact saving', async () => {
  mocks.html.mockResolvedValue(Buffer.from('html'));
  const result = await generateHtmlPagesFromMessage({
    workspacePath,
    taskId: 'task',
    messageId: 'message',
    content: '',
  });
  expect(result.saved).toHaveLength(1);
  expect(mocks.save).toHaveBeenCalledOnce();
});

it.each(['pptx', 'docx', 'html', 'slidegen'] as const)(
  'a closed database cannot start %s rendering or saving',
  async (kind) => {
    setWorkspaceDatabaseOwner(null);
    mocks.render.mockResolvedValue(Buffer.from('document'));
    mocks.html.mockResolvedValue(Buffer.from('html'));
    mocks.page.mockResolvedValue({ page: {}, warnings: [] });
    const input = { workspacePath, taskId: 'task', messageId: 'message', content: '' };
    const result =
      kind === 'html'
        ? await generateHtmlPagesFromMessage(input)
        : kind === 'slidegen'
          ? await generateSlidesFromMessage({ ...input, content: '```slidegen\n// title: deck\n<Slide/>\n```' })
          : await generateDocumentsFromMessage({
              ...input,
              content: [
                '```docgen',
                JSON.stringify(
                  kind === 'pptx'
                    ? { kind, title: 'deck', slides: [{ title: 'slide', bullets: ['hello'] }] }
                    : { kind, title: 'document', sections: [{ heading: 'heading', paragraphs: ['hello'] }] },
                ),
                '```',
              ].join('\n'),
            });
    expect(mocks.render).not.toHaveBeenCalled();
    expect(mocks.html).not.toHaveBeenCalled();
    expect(mocks.page).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(result.saved).toEqual([]);
  },
);
