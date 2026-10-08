import { mkdtempSync, writeFileSync, rmSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { nativeInputFromCompletedWrites } from '../src/main/docgen/native-tool-input';
let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'native-write-proof-'));
});
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
  // mtime 相同时才真正二义（BUG-046 ③：数组序≠执行序，mtime 是裁决者）。
  utimesSync(join(folder, 'deck.native-ppt.json'), new Date(1_600_000_000_000), new Date(1_600_000_000_000));
  utimesSync(join(folder, 'second.native-ppt.json'), new Date(1_600_000_000_000), new Date(1_600_000_000_000));
  expect(() =>
    nativeInputFromCompletedWrites(folder, [
      tool,
      { ...tool, id: 'write-2', args: { path: 'second.native-ppt.json', content: 'second' } },
    ]),
  ).toThrow('native-input-ambiguous');
});

describe('BUG-046 ③ 当前源判据重定义（mtime 优先 + 编辑工具 + freshness）', () => {
  const done = (id: string, name: string, args: Record<string, unknown>) => ({
    id,
    name,
    status: 'done' as const,
    startedAt: '',
    args,
  });

  it('多个 sha 匹配候选 ⇒ 选盘上 mtime 最新的，不再凭数组序/抛 ambiguous', () => {
    writeFileSync(join(folder, 'older.native-ppt.json'), 'one');
    writeFileSync(join(folder, 'newer.native-ppt.json'), 'two');
    utimesSync(join(folder, 'older.native-ppt.json'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    // 数组里旧文件排在前（数组序 ≠ 执行序；mtime 才是执行序的实证）。
    const tools = [
      done('w1', 'write', { path: 'older.native-ppt.json', content: 'one' }),
      done('w2', 'write', { path: 'newer.native-ppt.json', content: 'two' }),
    ];
    expect(nativeInputFromCompletedWrites(folder, tools)).toBe('newer.native-ppt.json');
  });

  it('本轮用 edit 改过的源文件也算当前源（真机 69 次 native-current-write-required 误诊的回归）', () => {
    const now = Date.now();
    writeFileSync(join(folder, 'edited.native-ppt.json'), 'full content edited');
    utimesSync(join(folder, 'edited.native-ppt.json'), new Date(now - 5_000), new Date(now - 5_000));
    const tools = [
      done('e1', 'edit', {
        path: 'edited.native-ppt.json',
        old_string: 'full content',
        new_string: 'full content edited',
      }),
    ];
    // sinceMs 在 run 开始时刻：文件在 run 内被改过 ⇒ 是当前源。
    expect(nativeInputFromCompletedWrites(folder, tools, { sinceMs: now - 10_000 })).toBe('edited.native-ppt.json');
  });

  it('run 开始之前就存在、本轮没碰过的旧文件 ⇒ 不选（守卫不松）', () => {
    writeFileSync(join(folder, 'stale.native-ppt.json'), 'stale');
    utimesSync(join(folder, 'stale.native-ppt.json'), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    const tools = [done('e1', 'edit', { path: 'stale.native-ppt.json', old_string: 'stale', new_string: 'stale' })];
    expect(nativeInputFromCompletedWrites(folder, tools, { sinceMs: Date.now() - 60_000 })).toBeUndefined();
  });

  it('⭐ F-A2：同 run 先 write 后 edit 同一文件 ⇒ 仍入选（写后改盲区，case A 误诊回归）', () => {
    const now = Date.now();
    // 盘上是 edit 后的内容；write 记录的 args 是 edit 前的旧内容 ⇒ 第一层 sha 必不匹配，
    // 第二层不能因为"该文件同时有 write 记录"就跳过——否则候选两落空，误诊
    // native-current-write-required（正是修复③要除的形态）。
    writeFileSync(join(folder, 'rewritten.native-ppt.json'), 'edited content');
    utimesSync(join(folder, 'rewritten.native-ppt.json'), new Date(now - 5_000), new Date(now - 5_000));
    const tools = [
      done('w1', 'write', { path: 'rewritten.native-ppt.json', content: 'original content' }),
      done('e1', 'edit', { path: 'rewritten.native-ppt.json', old_string: 'original', new_string: 'edited' }),
    ];
    expect(nativeInputFromCompletedWrites(folder, tools, { sinceMs: now - 10_000 })).toBe('rewritten.native-ppt.json');
  });

  it('不传 sinceMs ⇒ 老判据一字不变（sha 匹配 write 才认，edit 不认）', () => {
    writeFileSync(join(folder, 'legacy.native-ppt.json'), 'legacy');
    const tools = [done('e1', 'edit', { path: 'legacy.native-ppt.json', old_string: 'x', new_string: 'legacy' })];
    expect(nativeInputFromCompletedWrites(folder, tools)).toBeUndefined();
    const w = done('w1', 'write', { path: 'legacy.native-ppt.json', content: 'legacy' });
    expect(readFileSync(join(folder, 'legacy.native-ppt.json'), 'utf8')).toBe('legacy');
    expect(nativeInputFromCompletedWrites(folder, [w])).toBe('legacy.native-ppt.json');
  });
});
