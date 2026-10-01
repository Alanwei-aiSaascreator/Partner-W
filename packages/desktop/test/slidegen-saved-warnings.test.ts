import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import type { Artifact } from '@clawwork/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceDatabaseOwner } from '../src/main/workspace/scope.js';
import type { MeasuredElement } from '../src/main/slidegen/measure.js';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../src/main/slidegen/measure.js', () => ({ measureSlide: vi.fn() }));
vi.mock('../src/main/artifact/save.js', () => ({ saveArtifactFromBuffer: vi.fn() }));

import { saveArtifactFromBuffer } from '../src/main/artifact/save.js';
import { getDebugLogger, initDebugLogger } from '../src/main/debug/index.js';
import { generateSlidesFromMessage } from '../src/main/slidegen/generate.js';
import { measureSlide } from '../src/main/slidegen/measure.js';

const measure = vi.mocked(measureSlide);
const save = vi.mocked(saveArtifactFromBuffer);
let outputRoot: string;

const root: MeasuredElement = {
  id: 0,
  kind: 'slide',
  x: 0,
  y: 0,
  w: 1280,
  h: 720,
  text: '',
  fontSize: 32,
  fontWeight: '400',
  color: 'rgb(0, 0, 0)',
  textAlign: 'left',
  letterSpacing: 0,
  background: 'rgb(255, 255, 255)',
  backgroundImage: 'none',
  borderRadius: 0,
  borderWidth: 0,
  borderColor: 'rgba(0, 0, 0, 0)',
  lines: 0,
  occludedBy: null,
};

function measuredPage(issue: 'occluded' | 'bounds' | 'clean' = 'occluded'): MeasuredElement[] {
  return [
    root,
    {
      ...root,
      id: 1,
      kind: 'text',
      x: issue === 'bounds' ? 1200 : 40,
      y: 40,
      w: 300,
      h: 60,
      text: 'Editable heading',
      lines: 1,
      occludedBy: issue === 'occluded' ? '#2' : null,
    },
  ];
}

function deck(title: string, pages = 1): string {
  return [
    '```slidegen',
    `// title: ${title}`,
    ...Array.from({ length: pages }, () => '<Slide><Text>Editable heading</Text></Slide>'),
    '```',
  ].join('\n');
}

function generate(content: string, workspacePath = outputRoot) {
  return generateSlidesFromMessage({ workspacePath, taskId: 'task-1', messageId: 'message-1', content });
}

async function persistBuffer(
  input: Parameters<typeof saveArtifactFromBuffer>[0],
  name = input.fileName.replace(/\.pptx$/, '-stored.pptx'),
): Promise<Artifact> {
  const filePath = path.join(input.workspacePath, name);
  fs.writeFileSync(filePath, input.buffer);
  return {
    id: name,
    taskId: input.taskId,
    messageId: input.messageId,
    type: input.artifactType,
    name,
    filePath,
    localPath: name,
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    size: input.buffer.length,
    sourceKey: input.sourceKey,
    createdAt: new Date().toISOString(),
    availability: 'available',
  };
}

function warning(artifactName: string, page: number, code = 'layout-text-occluded') {
  return { code, page, element: 1, detail: expect.any(String), artifactName };
}

function savedEvents() {
  return getDebugLogger()
    .getRecentEvents()
    .filter((event) => event.event === 'slidegen.saved')
    .map((event) => event.data);
}

describe('warnings for saved slide artifacts', () => {
  beforeEach(() => {
    setWorkspaceDatabaseOwner({});
    vi.resetAllMocks();
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slidegen-saved-warnings-'));
    initDebugLogger(path.join(outputRoot, 'logs'));
    measure.mockResolvedValue(measuredPage());
    save.mockImplementation((input) => persistBuffer(input));
  });

  afterEach(async () => {
    await getDebugLogger().close();
    fs.rmSync(outputRoot, { recursive: true, force: true });
  });

  it('reuses a verified source with its real warnings while generating only the remaining deck', async () => {
    const existingWarning = {
      code: 'layout-out-of-bounds' as const,
      page: 1,
      element: 2,
      detail: 'Outside',
      artifactName: 'Existing.pptx',
    };
    const input = {
      workspacePath: outputRoot,
      taskId: 'task-1',
      messageId: 'message-1',
      content: `${deck('Existing')}\n${deck('New')}`,
      reuseExisting: (current: { title: string }) => (current.title === 'Existing' ? [existingWarning] : null),
    };
    const result = await generateSlidesFromMessage(input);
    expect(result.failed).toEqual([]);
    expect(result.saved.map((entry) => entry.name)).toEqual(['New-stored.pptx']);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(result.warnings).toEqual([existingWarning, warning('New-stored.pptx', 1)]);
  });

  it('does not blindly rerender a source when its known output becomes unconfirmed', async () => {
    const input = {
      workspacePath: outputRoot,
      taskId: 'task-1',
      messageId: 'message-1',
      content: deck('Existing'),
      reuseExisting: () => {
        throw new Error('receipt-version-mismatch');
      },
    };
    const result = await generateSlidesFromMessage(input);
    expect(result.failed).toEqual([{ code: 'slidegen-render-failed' }]);
    expect(measure).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('attaches the returned artifact name while preserving an editable PPTX', async () => {
    save.mockImplementationOnce((input) => persistBuffer(input, 'Collision-renamed.pptx'));

    const result = await generate(deck('Requested'));

    expect(result.failed).toEqual([]);
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0].name).toBe('Collision-renamed.pptx');
    expect(save.mock.calls[0][0].fileName).toBe('Requested.pptx');
    const zip = await JSZip.loadAsync(fs.readFileSync(result.saved[0].filePath));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(xml).toContain('<a:t>Editable heading</a:t>');
    expect(result.warnings).toEqual([warning('Collision-renamed.pptx', 1)]);
  });

  it.each(['layout-footer-overlap', 'layout-text-low-contrast'])(
    'delivers editable output and associates %s with its actual saved name',
    async (code) => {
      const text: MeasuredElement = {
        ...root,
        id: 1,
        kind: 'text',
        parentId: 0,
        position: 'absolute',
        x: 80,
        y: 674,
        w: 1120,
        h: 16,
        text: 'Editable footer',
        fontSize: 13,
        background: 'rgba(0, 0, 0, 0)',
        color: code === 'layout-text-low-contrast' ? 'rgb(200, 200, 200)' : 'rgb(0, 0, 0)',
      };
      measure.mockResolvedValue([
        root,
        ...(code === 'layout-footer-overlap'
          ? [{ ...root, id: 2, kind: 'box' as const, x: 760, y: 480, w: 440, h: 214 }]
          : []),
        text,
      ]);
      save.mockImplementationOnce((input) => persistBuffer(input, 'Actual-name.pptx'));
      const result = await generate(deck('Requested'));
      expect(result.failed).toEqual([]);
      expect(result.warnings).toEqual([warning('Actual-name.pptx', 1, code)]);
      const zip = await JSZip.loadAsync(fs.readFileSync(result.saved[0].filePath));
      expect(await zip.file('ppt/slides/slide1.xml')!.async('string')).toContain('<a:t>Editable footer</a:t>');
    },
  );

  it('keeps warning names separate and restarts page numbering for each deck', async () => {
    measure.mockResolvedValueOnce(measuredPage()).mockResolvedValueOnce(measuredPage('bounds'));

    const result = await generate(`${deck('First', 2)}\n${deck('Second')}`);

    expect(result.failed).toEqual([]);
    expect(result.saved.map((artifact) => artifact.name)).toEqual(['First-stored.pptx', 'Second-stored.pptx']);
    expect(result.warnings).toEqual([
      warning('First-stored.pptx', 1),
      warning('First-stored.pptx', 2, 'layout-out-of-bounds'),
      warning('Second-stored.pptx', 1),
    ]);
  });

  it('logs the warning count of each saved deck, including a clean sibling', async () => {
    measure
      .mockResolvedValueOnce(measuredPage())
      .mockResolvedValueOnce(measuredPage('bounds'))
      .mockResolvedValueOnce(measuredPage())
      .mockResolvedValueOnce(measuredPage('clean'));

    const result = await generate(`${deck('First', 2)}\n${deck('Second')}\n${deck('Clean')}`);

    expect(result.failed).toEqual([]);
    expect(result.saved).toHaveLength(3);
    expect(savedEvents()).toEqual([
      expect.objectContaining({ name: 'First-stored.pptx', pages: 2, warnings: 2 }),
      expect.objectContaining({ name: 'Second-stored.pptx', pages: 1, warnings: 1 }),
      expect.objectContaining({ name: 'Clean-stored.pptx', pages: 1, warnings: 0 }),
    ]);
  });

  it('discards quality warnings when artifact saving fails', async () => {
    save.mockRejectedValueOnce(new Error('Artifact save failed'));

    const result = await generate(deck('Unsaved'));

    expect(result.failed).toEqual([{ code: 'slidegen-render-failed' }]);
    expect(result.saved).toEqual([]);
    expect(save).toHaveBeenCalledOnce();
    expect(savedEvents()).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('discards earlier page warnings when rendering a later page fails', async () => {
    measure.mockResolvedValueOnce(measuredPage()).mockRejectedValueOnce(new Error('Browser measurement failed'));

    const result = await generate(deck('Incomplete', 2));

    expect(result.failed).toEqual([{ code: 'slidegen-render-failed' }]);
    expect(result.saved).toEqual([]);
    expect(measure).toHaveBeenCalledTimes(2);
    expect(save).not.toHaveBeenCalled();
    expect(savedEvents()).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('discards quality warnings when writing the PPTX fails', async () => {
    const result = await generate(deck('Unwritten'), path.join(outputRoot, 'missing-workspace'));

    expect(result.failed).toEqual([{ code: 'slidegen-render-failed' }]);
    expect(result.saved).toEqual([]);
    expect(save).not.toHaveBeenCalled();
    expect(getDebugLogger().getRecentEvents()).toContainEqual(
      expect.objectContaining({
        event: 'slidegen.save-failed',
        data: expect.objectContaining({ error: expect.stringContaining('ENOENT') }),
      }),
    );
    expect(savedEvents()).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it.each(['before', 'after'])('keeps saved sibling warnings when saving fails %s it', async (order) => {
    save.mockImplementation((input) => {
      if (input.fileName === 'Failed.pptx') return Promise.reject(new Error('Artifact save failed'));
      return persistBuffer(input);
    });
    const titles = order === 'before' ? ['Failed', 'Saved'] : ['Saved', 'Failed'];

    const result = await generate(titles.map((title) => deck(title)).join('\n'));

    expect(result.failed).toEqual([{ code: 'slidegen-render-failed' }]);
    expect(result.saved.map((artifact) => artifact.name)).toEqual(['Saved-stored.pptx']);
    expect(result.warnings).toEqual([warning('Saved-stored.pptx', 1)]);
    expect(savedEvents()).toEqual([expect.objectContaining({ name: 'Saved-stored.pptx', warnings: 1 })]);
  });

  it('saves a clean deck without quality warnings', async () => {
    measure.mockResolvedValueOnce(measuredPage('clean'));

    const result = await generate(deck('Clean'));

    expect(result.failed).toEqual([]);
    expect(result.saved.map((artifact) => artifact.name)).toEqual(['Clean-stored.pptx']);
    expect(result.warnings).toEqual([]);
    expect(savedEvents()).toEqual([expect.objectContaining({ name: 'Clean-stored.pptx', warnings: 0 })]);
  });
});
