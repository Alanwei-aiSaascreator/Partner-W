import { describe, expect, it } from 'vitest';
import type { ModelCatalogEntry } from '@clawwork/shared';
import { resolveVisionRecipients } from '../src/renderer/lib/vision-routing';

const catalog: ModelCatalogEntry[] = [
  { id: 'vision-a', name: 'A', provider: 'clawrouter', input: ['text', 'image'] },
  { id: 'vision-b', name: 'B', provider: 'clawrouter', input: ['text', 'image'] },
];
const targets = ['conductor', 'worker'];
const rows = [
  { key: 'conductor', model: 'vision-a', modelProvider: 'clawrouter' },
  { key: 'worker', model: 'clawrouter/vision-b', modelProvider: 'clawrouter' },
];
const snapshot = (models: unknown = catalog) => ({ config: { models: { providers: { clawrouter: { models } } } } });

describe('final image recipient capability', () => {
  it('preserves each verified recipient model with its provider', () => {
    expect(resolveVisionRecipients(targets, { sessions: rows }, snapshot(), catalog)).toEqual([
      { sessionKey: 'conductor', model: 'clawrouter/vision-a' },
      { sessionKey: 'worker', model: 'clawrouter/vision-b' },
    ]);
  });
  it.each([
    [{ sessions: rows.slice(0, 1) }, snapshot()],
    [{ sessions: [...rows, rows[1]] }, snapshot()],
    [{ sessions: rows }, null],
    [{ sessions: rows }, snapshot([])],
    [
      { sessions: rows },
      snapshot([
        { id: 'vision-a', input: ['text', 'image'] },
        { id: 'vision-b', input: ['text'] },
      ]),
    ],
    [{ sessions: rows }, snapshot([{ id: 'vision-a', input: ['text', 'image'] }, { id: 'vision-b' }])],
    [{ sessions: [rows[0], { ...rows[1], modelProvider: 'other' }] }, snapshot()],
    [{ sessions: [rows[0], { ...rows[1], model: 'other/vision-b' }] }, snapshot()],
    [{ sessions: [rows[0], { ...rows[1], modelProvider: undefined }] }, snapshot()],
    [{ sessions: [rows[0], { ...rows[1], model: undefined }] }, snapshot()],
  ])('blocks the whole batch for missing, conflicting or nonvisual evidence %#', (sessions, config) => {
    expect(resolveVisionRecipients(targets, sessions, config, catalog)).toBeNull();
  });
});
