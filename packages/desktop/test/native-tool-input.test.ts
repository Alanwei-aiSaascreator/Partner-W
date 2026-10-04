import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it, expect } from 'vitest';
import { nativeInputFromCompletedWrites } from '../src/main/docgen/native-tool-input';
const folder = mkdtempSync(join(tmpdir(), 'native-write-proof-'));
afterEach(() => rmSync(folder, { recursive: true, force: true }));
it('requires a completed current write whose content matches the file and rejects ambiguity', () => {
  writeFileSync(join(folder, 'deck.native-ppt.json'), 'current');
  const tool = {
    id: 'write-1',
    name: 'write',
    status: 'done' as const,
    startedAt: '',
    args: { path: 'deck.native-ppt.json', content: 'current' },
  };
  expect(nativeInputFromCompletedWrites(folder, [tool])).toBe('deck.native-ppt.json');
  expect(nativeInputFromCompletedWrites(folder, [{ ...tool, status: 'running' }])).toBeUndefined();
  expect(nativeInputFromCompletedWrites(folder, [{ ...tool, args: { ...tool.args, content: 'old' } }])).toBeUndefined();
  expect(
    nativeInputFromCompletedWrites(folder, [
      { ...tool, args: { path: '../outside.native-ppt.json', content: 'current' } },
    ]),
  ).toBeUndefined();
  writeFileSync(join(folder, 'second.native-ppt.json'), 'second');
  expect(() =>
    nativeInputFromCompletedWrites(folder, [
      tool,
      { ...tool, id: 'write-2', args: { path: 'second.native-ppt.json', content: 'second' } },
    ]),
  ).toThrow('native-input-ambiguous');
});
