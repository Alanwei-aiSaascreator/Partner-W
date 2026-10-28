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

  /**
   * ⭐ BUG-054（2026-10-09 只读复审）：同一文件多次 write 的**数组序依赖**。
   *
   * 旧实现 Map 对同文件只留"数组里最后一条"write 的内容 —— 数组序 ≠ 执行序（同
   * BUG-046 ③ 的实证），倒序时留下的是**旧内容**，与盘上新字节 sha 不匹配 ⇒
   * 真新文件落选、后续 mtime 排序也救不回（内容证据已被覆盖）。
   * 修法：保留**每一次**写入的内容，sha 与任一次一致即通过。
   */
  it('⭐ BUG-054：同一文件多次 write —— 数组倒序（旧写入在数组末尾）仍能选中', () => {
    writeFileSync(join(folder, 'deck.native-ppt.json'), 'current');
    const tools = [
      done('w2', 'write', { path: 'deck.native-ppt.json', content: 'current' }),
      done('w1', 'write', { path: 'deck.native-ppt.json', content: 'old' }),
    ];
    expect(nativeInputFromCompletedWrites(folder, tools)).toBe('deck.native-ppt.json');
  });

  it('BUG-054 负对照：盘上内容不是本轮任何一次写入 ⇒ 仍不选（守卫不松）', () => {
    writeFileSync(join(folder, 'deck.native-ppt.json'), 'someone-elses');
    const tools = [
      done('w1', 'write', { path: 'deck.native-ppt.json', content: 'old' }),
      done('w2', 'write', { path: 'deck.native-ppt.json', content: 'current' }),
    ];
    expect(nativeInputFromCompletedWrites(folder, tools)).toBeUndefined();
  });
});

/**
 * BUG-058④（联审 P3 残余，2026-10-13 计划口径）：mtime 平局时**只许**用
 * 可信原生顺序或**显式目标**消歧；没有证据就保持明确歧义（并给出具体下一步）。
 *
 * 不许的两条捷径（都是"看起来合理"的猜测）：
 *  · **工具数组序** —— 模型写回的顺序 ≠ 执行序（BUG-046 ③ / BUG-054 两度实证）；
 *  · **收包 completedAt** —— 收包时间同样不是执行序（乱序到达/重放都会反）。
 * 原生执行顺序的透传需要 V/E 提供可信来源（本批不造）；显式目标由调用方**显式**给出，
 * 且必须**就在并列候选里** —— 它不绕过 sha / freshness / containment 任何一道守卫。
 */
describe('BUG-058④ · mtime 平局：只认显式目标，不许数组序/收包时间猜选', () => {
  const done = (id: string, name: string, args: Record<string, unknown>, completedAt?: string) => ({
    id,
    name,
    status: 'done' as const,
    startedAt: '',
    ...(completedAt ? { completedAt } : {}),
    args,
  });
  const tie = (): void => {
    writeFileSync(join(folder, 'a.native-ppt.json'), 'A');
    writeFileSync(join(folder, 'b.native-ppt.json'), 'B');
    const stamp = new Date(1_600_000_000_000);
    utimesSync(join(folder, 'a.native-ppt.json'), stamp, stamp);
    utimesSync(join(folder, 'b.native-ppt.json'), stamp, stamp);
  };
  const writeA = () => done('w1', 'write', { path: 'a.native-ppt.json', content: 'A' });
  const writeB = () => done('w2', 'write', { path: 'b.native-ppt.json', content: 'B' });

  it('⭐ 双文件同 mtime（数组两个方向都试）⇒ 仍明确歧义，不给"最近写"的假答案', () => {
    tie();
    expect(() => nativeInputFromCompletedWrites(folder, [writeA(), writeB()])).toThrow('native-input-ambiguous');
    expect(() => nativeInputFromCompletedWrites(folder, [writeB(), writeA()])).toThrow('native-input-ambiguous');
  });

  it('⭐ 收包 completedAt 反序也不能消歧（收包时间不是执行序）', () => {
    tie();
    const a = done('w1', 'write', { path: 'a.native-ppt.json', content: 'A' }, '2026-10-13T00:00:02.000Z');
    const b = done('w2', 'write', { path: 'b.native-ppt.json', content: 'B' }, '2026-10-13T00:00:01.000Z');
    expect(() => nativeInputFromCompletedWrites(folder, [a, b])).toThrow('native-input-ambiguous');
    expect(() => nativeInputFromCompletedWrites(folder, [b, a])).toThrow('native-input-ambiguous');
  });

  it('⭐ 显式目标（可信调用方指着并列里的哪一个）⇒ 只认它（相对/绝对拼写都行）', () => {
    tie();
    const tools = [writeA(), writeB()];
    expect(nativeInputFromCompletedWrites(folder, tools, { target: 'b.native-ppt.json' })).toBe('b.native-ppt.json');
    expect(nativeInputFromCompletedWrites(folder, tools, { target: 'a.native-ppt.json' })).toBe('a.native-ppt.json');
    expect(nativeInputFromCompletedWrites(folder, tools, { target: join(folder, 'b.native-ppt.json') })).toBe(
      'b.native-ppt.json',
    );
  });

  it('⭐ 显式目标不在并列候选里（或文件本身没过守卫）⇒ 保持歧义，不猜', () => {
    tie();
    const tools = [writeA(), writeB()];
    expect(() => nativeInputFromCompletedWrites(folder, tools, { target: 'c.native-ppt.json' })).toThrow(
      'native-input-ambiguous',
    );
    expect(() => nativeInputFromCompletedWrites(folder, tools, { target: 'outside.native-ppt.json' })).toThrow(
      'native-input-ambiguous',
    );
  });

  it('⭐ 歧义错误给出具体下一步（并列候选名 + 可执行动作，不是裸码）', () => {
    tie();
    let message = '';
    try {
      nativeInputFromCompletedWrites(folder, [writeA(), writeB()]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('native-input-ambiguous');
    expect(message).toContain('a.native-ppt.json');
    expect(message).toContain('b.native-ppt.json');
    expect(message).toContain('指定目标文件'); // 具体下一步
  });

  it('负对照：mtime 不同 ⇒ 仍按 mtime 选最新；显式目标不改变非平局的裁决', () => {
    writeFileSync(join(folder, 'older.native-ppt.json'), 'one');
    writeFileSync(join(folder, 'newer.native-ppt.json'), 'two');
    utimesSync(join(folder, 'older.native-ppt.json'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const tools = [
      done('w1', 'write', { path: 'older.native-ppt.json', content: 'one' }),
      done('w2', 'write', { path: 'newer.native-ppt.json', content: 'two' }),
    ];
    expect(nativeInputFromCompletedWrites(folder, tools)).toBe('newer.native-ppt.json');
    expect(nativeInputFromCompletedWrites(folder, tools, { target: 'older.native-ppt.json' })).toBe(
      'newer.native-ppt.json',
    );
  });
});
