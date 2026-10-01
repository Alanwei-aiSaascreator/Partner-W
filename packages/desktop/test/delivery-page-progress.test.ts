import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  handlers: new Map<string, () => unknown>(),
  render: vi.fn(),
  save: vi.fn(),
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: mocks.send } }] },
  ipcMain: { handle: (name: string, handler: () => unknown) => mocks.handlers.set(name, handler) },
}));
vi.mock('../src/main/slidegen/pipeline.js', () => ({ emitPageShapes: mocks.render }));
vi.mock('../src/main/slidegen/emit.js', () => ({
  writeSlidePptx: async (_pages: unknown, file: string) => fs.writeFileSync(file, 'pptx'),
}));
vi.mock('../src/main/artifact/save.js', () => ({ saveArtifactFromBuffer: mocks.save }));
import { getWorkspaceScope, setWorkspaceDatabaseOwner } from '../src/main/workspace/scope.js';
import { captureArtifactDeliveryOperation } from '../src/main/artifact/delivery-operation.js';
import {
  beginArtifactDeliveryActivity,
  registerDeliveryActivityHandlers,
} from '../src/main/artifact/delivery-activity.js';
import { generateSlidesFromMessage } from '../src/main/slidegen/generate.js';
const identity = { taskId: 'task', sessionKey: 'session', messageId: 'message', runId: 'run' };
let workspace = '';
const frames = () =>
  mocks.send.mock.calls.filter(([channel]) => channel === 'artifact:delivery-activity').map(([, event]) => event);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.handlers.clear();
  setWorkspaceDatabaseOwner({});
  mocks.send.mockClear();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-page-progress-'));
  mocks.render.mockResolvedValue({ page: {}, warnings: [] });
  mocks.save.mockImplementation(async (input) => ({ name: input.fileName }));
});
afterEach(() => {
  if (!path.resolve(workspace).startsWith(path.resolve(os.tmpdir()) + path.sep))
    throw new Error('escaped QA directory');
  fs.rmSync(workspace, { recursive: true, force: true });
});
it('broadcasts actual completed pages before saving through the real producer and operation', async () => {
  const operation = captureArtifactDeliveryOperation(identity);
  const result = await generateSlidesFromMessage({
    workspacePath: workspace,
    ...identity,
    content: [
      '\x60\x60\x60slidegen',
      '// title: deck',
      '<Slide><Text>First</Text></Slide><Slide><Text>Second</Text></Slide>',
      '\x60\x60\x60',
    ].join('\n'),
    onActivity: operation.phase,
  });
  expect(result.failed).toEqual([]);
  expect(result.saved).toHaveLength(1);
  expect(frames().map((event) => [event.phase, event.pageProgress ?? null])).toEqual([
    ['generating-presentation', { completed: 0, total: 2 }],
    ['generating-presentation', { completed: 1, total: 2 }],
    ['generating-presentation', { completed: 2, total: 2 }],
    ['saving-artifacts', null],
  ]);
  expect(frames().every((event) => event.status === 'active')).toBe(true);
  operation.finish('succeeded');
  expect(frames().at(-1).status).toBe('succeeded');
});
it('does not fabricate page completion after rendering fails', async () => {
  mocks.render
    .mockResolvedValueOnce({ page: {}, warnings: [] })
    .mockRejectedValueOnce(new Error('actual page failure'));
  const operation = captureArtifactDeliveryOperation(identity);
  const result = await generateSlidesFromMessage({
    workspacePath: workspace,
    ...identity,
    content: ['\x60\x60\x60slidegen', '// title: failed', '<Slide/><Slide/>', '\x60\x60\x60'].join('\n'),
    onActivity: operation.phase,
  });
  expect(result.failed).toHaveLength(1);
  expect(result.saved).toHaveLength(0);
  expect(frames().map((event) => event.pageProgress?.completed)).toEqual([0, 1]);
  expect(mocks.save).not.toHaveBeenCalled();
  operation.finish('failed');
  expect(frames().at(-1).pageProgress).toEqual({ completed: 1, total: 2 });
});
it('copies progress snapshots and clears page evidence on a different phase', () => {
  registerDeliveryActivityHandlers();
  const operation = beginArtifactDeliveryActivity(
    { ...identity, owner: getWorkspaceScope() },
    'generating-presentation',
  )!;
  const progress = { completed: 3, total: 12 };
  operation.phase('generating-presentation', progress);
  progress.completed = 99;
  const snapshot = mocks.handlers.get('artifact:get-delivery-activity-snapshot')!;
  const first = snapshot() as { activities: { pageProgress?: { completed: number; total: number } }[] };
  expect(first.activities[0].pageProgress).toEqual({ completed: 3, total: 12 });
  first.activities[0].pageProgress!.completed = 77;
  expect(snapshot()).toMatchObject({ activities: [{ pageProgress: { completed: 3, total: 12 } }] });
  operation.phase('saving-artifacts');
  expect(frames().at(-1).pageProgress).toBeUndefined();
});
it.each([
  { completed: -1, total: 12 },
  { completed: 13, total: 12 },
  { completed: 0, total: 0 },
  { completed: 0.5, total: 12 },
  { completed: 1, total: 201 },
  { completed: Number.NaN, total: 12 },
])('rejects invalid progress %j without corrupting phase activity', (progress) => {
  const operation = beginArtifactDeliveryActivity(
    { ...identity, owner: getWorkspaceScope() },
    'generating-presentation',
  )!;
  operation.phase('generating-presentation', progress);
  expect(frames().at(-1).pageProgress).toBeUndefined();
});
it('does not publish late page facts to a replaced workspace or a terminal operation', () => {
  const owner = getWorkspaceScope();
  const operation = beginArtifactDeliveryActivity({ ...identity, owner }, 'generating-presentation')!;
  operation.phase('generating-presentation', { completed: 1, total: 12 });
  operation.finish('canceled');
  const count = frames().length;
  operation.phase('generating-presentation', { completed: 2, total: 12 });
  expect(frames()).toHaveLength(count);
  const current = beginArtifactDeliveryActivity({ ...identity, owner }, 'generating-presentation')!;
  setWorkspaceDatabaseOwner({});
  const before = frames().length;
  current.phase('generating-presentation', { completed: 2, total: 12 });
  expect(frames()).toHaveLength(before);
});
