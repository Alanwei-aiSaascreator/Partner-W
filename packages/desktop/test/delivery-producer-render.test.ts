import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setWorkspaceDatabaseOwner } from '../src/main/workspace/scope.js';

const mocks = vi.hoisted(() => ({ save: vi.fn(), render: vi.fn(), html: vi.fn(), events: [] as string[] }));
vi.mock('../src/main/artifact/save.js', () => ({ saveArtifactFromBuffer: mocks.save }));
vi.mock('../src/main/docgen/render.js', () => ({ renderDocument: mocks.render }));
vi.mock('../src/main/htmlgen/templates.js', () => ({
  renderHtmlgenDocument: mocks.html,
  HtmlgenOutputTooLargeError: class extends Error {},
}));
vi.mock('../src/main/htmlgen/blocks.js', () => ({
  extractHtmlgenBlocks: (content: string) => ({
    requests: content ? [{ title: 'page', template: 'report' }] : [],
    failures: [],
  }),
}));
vi.mock('../src/main/slidegen/pipeline.js', () => ({
  emitPageShapes: async () => {
    mocks.events.push('render');
    return { page: {}, warnings: [] };
  },
}));
vi.mock('../src/main/slidegen/emit.js', () => ({
  writeSlidePptx: async (_pages: unknown, file: string) => {
    writeFileSync(file, 'pptx');
  },
}));
const { generateDocumentsFromMessage } = await import('../src/main/docgen/generate.js');
const { generateSlidesFromMessage } = await import('../src/main/slidegen/generate.js');
const { generateHtmlPagesFromMessage } = await import('../src/main/htmlgen/generate.js');
let workspacePath = '';
const onActivity = (phase: string) => {
  mocks.events.push(phase);
};
const input = () => ({ workspacePath, taskId: 'task', messageId: 'message', onActivity });
const block = (kind: string) =>
  [
    '```docgen',
    JSON.stringify(
      kind === 'pptx'
        ? { kind, title: 'deck', slides: [{ title: 'slide', bullets: ['hello'] }] }
        : { kind, title: 'document', sections: [{ heading: 'section', paragraphs: ['hello'] }] },
    ),
    '```',
  ].join('\n');
const deck = ['```slidegen', '// title: deck', '<Slide><Text>Hello</Text></Slide>', '```'].join('\n');
beforeEach(() => {
  setWorkspaceDatabaseOwner({});
  vi.resetAllMocks();
  mocks.events.length = 0;
  workspacePath = mkdtempSync(join(tmpdir(), 'delivery-producer-'));
  mocks.render.mockImplementation(async () => {
    mocks.events.push('render');
    return Buffer.from('document');
  });
  mocks.html.mockImplementation(async () => {
    mocks.events.push('render');
    return Buffer.from('html');
  });
  mocks.save.mockImplementation(async (params) => {
    mocks.events.push('save');
    return { name: params.fileName };
  });
});
afterEach(() => rmSync(workspacePath, { recursive: true, force: true }));

it.each([
  ['pptx', 'generating-presentation'],
  ['docx', 'generating-document'],
])('reports %s rendering and then actual saving', async (kind, phase) => {
  const result = await generateDocumentsFromMessage({ ...input(), content: block(kind) });
  expect(result.failed).toEqual([]);
  expect(mocks.events).toEqual([phase, 'render', 'saving-artifacts', 'save']);
});

it('slidegen starts only after page validation and before rendering', async () => {
  const result = await generateSlidesFromMessage({ ...input(), content: deck });
  expect(result.failed).toEqual([]);
  expect(mocks.events).toEqual(['generating-presentation', 'render', 'saving-artifacts', 'save']);
});

it('an over-budget deck does not announce rendering or saving', async () => {
  const result = await generateSlidesFromMessage({
    ...input(),
    content: ['```slidegen', '// title: oversized', ...Array(201).fill('<Slide/>'), '```'].join('\n'),
  });
  expect(result.failed.length).toBeGreaterThan(0);
  expect(mocks.events).toEqual([]);
});

it('html reports its actual rendering type', async () => {
  await generateHtmlPagesFromMessage({ ...input(), content: 'html' });
  expect(mocks.events).toEqual(['generating-html', 'render', 'saving-artifacts', 'save']);
});

it('render failure reports no saving; normal replies report no activity', async () => {
  mocks.render.mockRejectedValue(new Error('renderer failed'));
  const result = await generateDocumentsFromMessage({ ...input(), content: block('pptx') });
  expect(result.failed).toHaveLength(1);
  expect(mocks.events).toEqual(['generating-presentation']);
  mocks.events.length = 0;
  await generateDocumentsFromMessage({ ...input(), content: 'ordinary response' });
  expect(mocks.events).toEqual([]);
});

it('notification failures leave successfully rendered files successful', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const result = await generateDocumentsFromMessage({
    ...input(),
    content: block('pptx'),
    onActivity: () => {
      throw new Error('window closed');
    },
  });
  expect(result.failed).toEqual([]);
  expect(result.saved).toHaveLength(1);
  warn.mockRestore();
});
