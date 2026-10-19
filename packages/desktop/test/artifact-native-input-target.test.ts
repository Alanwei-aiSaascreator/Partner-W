import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCall } from '@clawwork/shared';
import {
  nativeExecOrderFromTools,
  nativeInputFromCompletedWrites,
  nativeSourceFromCommand,
} from '../src/main/docgen/native-tool-input';

/**
 * ⭐ T23（2026-10-16 本地全量执行 · Owner D，产物侧半边）：**可信 nativeInputTarget
 * 从源端接通到生产调用点**。
 *
 * ## 缺口（修之前）
 *
 * `nativeInputFromCompletedWrites` 早就支持 `options.target` 消歧（BUG-058④ 单元判据），
 * 生产调用点（`ipc/data-handlers.ts` 收尾那段）却**从不传它** ⇒ 模块注释里那句
 * "原生执行顺序的透传那是 V/E 的显式依赖，到位前保持明确歧义" 一直是真的：
 * 两个 `.native-ppt.json` mtime 平局时，真机只能报 `native-input-ambiguous`。
 *
 * ## 可信来源（本批接通的那一个）
 *
 * 模型是用 **exec 工具**跑 `node "<skill>/deck-layout/scripts/generate.cjs" "<file>.native-ppt.json"`
 * 发起原生渲染的 —— 命令里那个 `.native-ppt.json` 参数就是**模型自己指名**要渲染的源文件。
 * 它不是"数组序/收包时间/mtime"这类猜测（那些正是 BUG-046③ / BUG-054 实证不可信的），
 * 而是源端（模型自己的命令）里写死的目标 ⇒ 允许用于 mtime 平局消歧。
 *
 * 边界（一条都不放松）：
 *  · 目标仍然**必须落在 mtime 并列的候选里**（sha / freshness / containment 一个不绕）；
 *  · 多个 exec 命令指名**不同**目标 ⇒ 仍然明确歧义（不是一个"取第一个"的后门）；
 *  · 命令里读不出目标（缺 `generate.cjs` / 缺 `.native-ppt.json` 参数）⇒ 保持歧义。
 */

let folder: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'native-target-wiring-'));
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

const done = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({
  id,
  name,
  status: 'done',
  startedAt: '',
  args,
});

/** 两个源文件写同样的内容 + 完全相同的 mtime ⇒ 真二义（mtime 裁不出来）。 */
function tieTwoSources(): void {
  writeFileSync(join(folder, 'a.native-ppt.json'), 'A');
  writeFileSync(join(folder, 'b.native-ppt.json'), 'B');
  const stamp = new Date(1_600_000_000_000);
  utimesSync(join(folder, 'a.native-ppt.json'), stamp, stamp);
  utimesSync(join(folder, 'b.native-ppt.json'), stamp, stamp);
}
const writeA = () => done('w1', 'write', { path: 'a.native-ppt.json', content: 'A' });
const writeB = () => done('w2', 'write', { path: 'b.native-ppt.json', content: 'B' });
const renderHelper = (file: string, previous?: string): ToolCall =>
  done('x1', 'exec', {
    command:
      `node "C:/skills/deck-layout/scripts/generate.cjs" "${file}"` + (previous ? ` --previous "${previous}"` : ''),
  });

/** 一条带**运行时执行记录**（toolCallId + 真实起止）的 exec —— 源端 item 帧的形状。 */
const renderExec = (id: string, file: string, at: string): ToolCall => ({
  id,
  name: 'exec',
  status: 'done',
  startedAt: at,
  completedAt: at,
  args: { command: `node "C:/skills/deck-layout/scripts/generate.cjs" "${file}"` },
});

describe('⭐ T23 · 从 exec 命令取回可信目标（`nativeSourceFromCommand`）', () => {
  it('带引号的相对目标 ⇒ 取回文件名', () => {
    expect(nativeSourceFromCommand('node "/s/deck-layout/scripts/generate.cjs" "a.native-ppt.json"')).toBe(
      'a.native-ppt.json',
    );
  });

  it('绝对目标（Windows 反斜杠路径）⇒ 取回绝对路径', () => {
    expect(
      nativeSourceFromCommand('node "C:\\skills\\deck-layout\\scripts\\generate.cjs" "C:\\ws\\b.native-ppt.json"'),
    ).toBe('C:\\ws\\b.native-ppt.json');
  });

  it('带 --previous 的改稿命令 ⇒ 只取源文件，不把 receipt 当目标', () => {
    expect(
      nativeSourceFromCommand(
        'node "x/deck-layout/scripts/generate.cjs" "d.native-ppt.json" --previous "p.receipt.json"',
      ),
    ).toBe('d.native-ppt.json');
  });

  it('负对照：命令里没有 generate.cjs / 没有 .native-ppt.json 参数 ⇒ undefined', () => {
    expect(nativeSourceFromCommand('node "x/other.cjs" "d.native-ppt.json"')).toBeUndefined();
    expect(nativeSourceFromCommand('node "x/deck-layout/scripts/generate.cjs"')).toBeUndefined();
    expect(nativeSourceFromCommand('echo "d.native-ppt.json"')).toBeUndefined();
  });

  it('负对照：命令里出现的是 receipt（`--previous`）而非源 ⇒ undefined', () => {
    expect(
      nativeSourceFromCommand('node "x/deck-layout/scripts/generate.cjs" --previous "p.receipt.json"'),
    ).toBeUndefined();
  });

  // ⭐ 2026-10-17 统一审核 §T23②：模型先 `cd "<...>/deck-layout"` 再 `node scripts/generate.cjs`
  //    时命令里**没有**连续的 `deck-layout/scripts/generate.cjs` ⇒ 旧判据读不出、仍 fail-closed。
  //    SKILL 文档只要求"用已安装的 deck-layout/scripts/generate.cjs"，没要求写全路径 ⇒ 会命中。
  it('⭐ cd + 相对调用 ⇒ 取回源文件（旧判据读不出的形态）', () => {
    expect(
      nativeSourceFromCommand('cd "C:/skills/deck-layout" && node scripts/generate.cjs "a.native-ppt.json"'),
    ).toBe('a.native-ppt.json');
  });

  it('⭐ cd + 相对调用（Windows 反斜杠 / 无引号 cd / 分号分隔）⇒ 同样取回', () => {
    expect(
      nativeSourceFromCommand('cd "C:\\skills\\deck-layout" && node scripts\\generate.cjs "b.native-ppt.json"'),
    ).toBe('b.native-ppt.json');
    expect(nativeSourceFromCommand('cd /opt/deck-layout; node scripts/generate.cjs "c.native-ppt.json"')).toBe(
      'c.native-ppt.json',
    );
  });

  it('⭐ cd + 相对调用 + --previous ⇒ 只取源，不把 receipt 当目标', () => {
    expect(
      nativeSourceFromCommand(
        'cd "/s/deck-layout" && node scripts/generate.cjs "d.native-ppt.json" --previous "p.receipt.json"',
      ),
    ).toBe('d.native-ppt.json');
  });

  it('负对照（不放松）：cd 的目录**不是** deck-layout ⇒ 不认出 helper ⇒ undefined', () => {
    expect(
      nativeSourceFromCommand('cd "/s/other-dir" && node scripts/generate.cjs "a.native-ppt.json"'),
    ).toBeUndefined();
  });

  it('负对照（不放松）：cd 到 deck-layout 但跑的是**别的** cjs ⇒ undefined', () => {
    expect(
      nativeSourceFromCommand('cd "/s/deck-layout" && node scripts/other.cjs "a.native-ppt.json"'),
    ).toBeUndefined();
  });

  // ⭐ 2026-10-17 统一审核 §T23② 反例（有界误认）：token 左边界。
  //    没有左边界时 `other/scripts/generate.cjs`（**更深路径**，不是 deck-layout 的 helper）
  //    也被当成 helper ⇒ 读出目标、实际渲的是另一个脚本。加边界后不认（fail-closed）。
  it('⭐ 反例：cd 到 deck-layout 但 helper 在**更深**路径 other/scripts/… ⇒ 不认出（token 左边界）', () => {
    expect(
      nativeSourceFromCommand('cd "/s/deck-layout" && node other/scripts/generate.cjs "a.native-ppt.json"'),
    ).toBeUndefined();
    // 保住真正形态：同目录相对调用（含可选 `./` 前缀）仍认出。
    expect(
      nativeSourceFromCommand('cd "/s/deck-layout" && node ./scripts/generate.cjs "e.native-ppt.json"'),
    ).toBe('e.native-ppt.json');
    expect(
      nativeSourceFromCommand('cd "/s/deck-layout" && node scripts/generate.cjs "f.native-ppt.json"'),
    ).toBe('f.native-ppt.json');
  });

  it('负对照（不放松）：cd + 相对调用但**没有**源参数 ⇒ undefined', () => {
    expect(nativeSourceFromCommand('cd "/s/deck-layout" && node scripts/generate.cjs')).toBeUndefined();
  });
});

describe('⭐ T23 · mtime 平局时用可信目标消歧（生产路径）', () => {
  it('RED→GREEN：两个写工具同 mtime + 一条 exec 指着 a ⇒ 选 a（不是 ambiguous）', () => {
    tieTwoSources();
    const tools = [writeA(), writeB(), renderHelper('a.native-ppt.json')];
    expect(nativeInputFromCompletedWrites(folder, tools, { sinceMs: 0 })).toBe('a.native-ppt.json');
  });

  it('exec 指着 b（数组里 a 在前）⇒ 仍选 b，不受数组序影响', () => {
    tieTwoSources();
    const tools = [writeA(), writeB(), renderHelper('b.native-ppt.json')];
    expect(nativeInputFromCompletedWrites(folder, tools, { sinceMs: 0 })).toBe('b.native-ppt.json');
  });

  it('boundary：两条 exec 指名不同目标 ⇒ 保持明确歧义（不取"第一个"）', () => {
    tieTwoSources();
    const tools = [writeA(), writeB(), renderHelper('a.native-ppt.json'), renderHelper('b.native-ppt.json')];
    expect(() => nativeInputFromCompletedWrites(folder, tools, { sinceMs: 0 })).toThrow('native-input-ambiguous');
  });

  it('boundary：exec 指的目标不在并列候选里 ⇒ 保持明确歧义', () => {
    tieTwoSources();
    const tools = [writeA(), writeB(), renderHelper('c.native-ppt.json')];
    expect(() => nativeInputFromCompletedWrites(folder, tools, { sinceMs: 0 })).toThrow('native-input-ambiguous');
  });

  it('boundary：没有 exec（只有两个写工具）⇒ 仍然明确歧义', () => {
    tieTwoSources();
    expect(() => nativeInputFromCompletedWrites(folder, [writeA(), writeB()], { sinceMs: 0 })).toThrow(
      'native-input-ambiguous',
    );
  });

  it('boundary：exec 未完成（running）⇒ 不作数，仍歧义', () => {
    tieTwoSources();
    const running = { ...renderHelper('a.native-ppt.json'), status: 'running' as const };
    expect(() => nativeInputFromCompletedWrites(folder, [writeA(), writeB(), running], { sinceMs: 0 })).toThrow(
      'native-input-ambiguous',
    );
  });

  it('boundary：非平局（mtime 不同）⇒ 目标不改变裁决（仍按 mtime 选最新）', () => {
    writeFileSync(join(folder, 'older.native-ppt.json'), 'one');
    writeFileSync(join(folder, 'newer.native-ppt.json'), 'two');
    utimesSync(join(folder, 'older.native-ppt.json'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    const tools = [
      done('w1', 'write', { path: 'older.native-ppt.json', content: 'one' }),
      done('w2', 'write', { path: 'newer.native-ppt.json', content: 'two' }),
      renderHelper('older.native-ppt.json'),
    ];
    expect(nativeInputFromCompletedWrites(folder, tools, { sinceMs: 0 })).toBe('newer.native-ppt.json');
  });

  it('显式 options.target 仍然优先于 exec 命令', () => {
    tieTwoSources();
    const tools = [writeA(), writeB(), renderHelper('a.native-ppt.json')];
    expect(nativeInputFromCompletedWrites(folder, tools, { sinceMs: 0, target: 'b.native-ppt.json' })).toBe(
      'b.native-ppt.json',
    );
  });
});

/**
 * ⭐ T23 源端半边（2026-10-16 本地全量执行 · 执行身份来源）：
 * **运行时 agent `item` 帧的 `toolCallId`/`startedAt`/`endedAt`** 由 run 收尾压成
 * `execOrder` 透传进来，用来裁决"两条 exec 指名不同目标"那次 mtime 平局。
 *
 * 与上一个 describe 的分工：那边钉"一条 exec 指名 ⇒ 用它"（产物侧半边，Owner D）；
 * 这里钉**多条 exec 指名不同目标**时"哪一条算数"——没有运行时执行顺序时保持二义，
 * 有顺序时取**最后真的跑过**那条的目标。
 */
describe('⭐ T23 源端半边 · 运行时执行顺序（`execOrder`）裁决多项指名', () => {
  /** 两条 exec 指名不同源（数组序 A→B），**只有运行时记录能分先后**。 */
  const twoNamedExecs = (): ToolCall[] => [
    writeA(),
    writeB(),
    renderExec('x1', 'a.native-ppt.json', '2026-10-16T00:00:01.000Z'),
    renderExec('x2', 'b.native-ppt.json', '2026-10-16T00:00:02.000Z'),
  ];

  it('RED→GREEN：两条 exec 指名不同目标 + 运行时顺序说 b 最后跑 ⇒ 选 b（不是 ambiguous）', () => {
    tieTwoSources();
    const tools = twoNamedExecs();
    expect(nativeInputFromCompletedWrites(folder, tools, { sinceMs: 0, execOrder: ['x1', 'x2'] })).toBe(
      'b.native-ppt.json',
    );
  });

  it('RED→GREEN：运行时顺序反过来（a 最后跑）⇒ 选 a，不受数组序影响', () => {
    tieTwoSources();
    const tools = twoNamedExecs();
    expect(nativeInputFromCompletedWrites(folder, tools, { sinceMs: 0, execOrder: ['x2', 'x1'] })).toBe(
      'a.native-ppt.json',
    );
  });

  it('反例（无身份必须不选）：同工具集但**不给** execOrder ⇒ 仍落在具名歧义、不猜', () => {
    tieTwoSources();
    expect(() => nativeInputFromCompletedWrites(folder, twoNamedExecs(), { sinceMs: 0 })).toThrow(
      'native-input-ambiguous',
    );
  });

  it('反例：execOrder 里没有一条被指名的 exec（只有写工具 id）⇒ 仍歧义', () => {
    tieTwoSources();
    expect(() =>
      nativeInputFromCompletedWrites(folder, twoNamedExecs(), { sinceMs: 0, execOrder: ['w1', 'w2'] }),
    ).toThrow('native-input-ambiguous');
  });

  it('反例：execOrder 空数组 ⇒ 仍歧义（空顺序不是"证据"）', () => {
    tieTwoSources();
    expect(() => nativeInputFromCompletedWrites(folder, twoNamedExecs(), { sinceMs: 0, execOrder: [] })).toThrow(
      'native-input-ambiguous',
    );
  });

  it('边界：运行顺序选中那条 exec 的目标**不在并列候选里** ⇒ 仍歧义（不是后门）', () => {
    tieTwoSources();
    // x2 指名 c（盘上没有/不在并列候选里）且运行时最后跑；x1 指名并列候选 a。
    const tools = [
      writeA(),
      writeB(),
      renderExec('x1', 'a.native-ppt.json', '2026-10-16T00:00:01.000Z'),
      renderExec('x2', 'c.native-ppt.json', '2026-10-16T00:00:02.000Z'),
    ];
    expect(() => nativeInputFromCompletedWrites(folder, tools, { sinceMs: 0, execOrder: ['x1', 'x2'] })).toThrow(
      'native-input-ambiguous',
    );
  });
});

describe('⭐ T23 源端半边 · `nativeExecOrderFromTools`（把 item 帧记录压成执行顺序）', () => {
  it('按运行时**完成时刻**升序（早 → 晚），与数组序无关', () => {
    const tools = [
      renderExec('x2', 'b.native-ppt.json', '2026-10-16T00:00:02.000Z'),
      renderExec('x1', 'a.native-ppt.json', '2026-10-16T00:00:01.000Z'),
    ];
    expect(nativeExecOrderFromTools(tools)).toEqual(['x1', 'x2']);
  });

  it('只收已完成的 exec：未完成/失败的 exec 与写工具都不入列', () => {
    const running = {
      ...renderExec('x3', 'c.native-ppt.json', '2026-10-16T00:00:09.000Z'),
      status: 'running' as const,
    };
    const failed = { ...renderExec('x4', 'd.native-ppt.json', '2026-10-16T00:00:08.000Z'), status: 'error' as const };
    const tools = [writeA(), running, failed, renderExec('x1', 'a.native-ppt.json', '2026-10-16T00:00:01.000Z')];
    expect(nativeExecOrderFromTools(tools)).toEqual(['x1']);
  });

  it('读不出任何时间戳的 exec ⇒ 不入列（宁缺勿猜，不让收包时刻冒充执行序）', () => {
    const noStamp: ToolCall = {
      id: 'x9',
      name: 'exec',
      status: 'done',
      startedAt: '',
      args: { command: 'node "x/deck-layout/scripts/generate.cjs" "z.native-ppt.json"' },
    };
    expect(nativeExecOrderFromTools([noStamp])).toEqual([]);
  });

  it('completedAt 缺失时回落到 startedAt（仍算真实记录）', () => {
    const partial: ToolCall = {
      id: 'x7',
      name: 'exec',
      status: 'done',
      startedAt: '2026-10-16T00:00:05.000Z',
      args: { command: 'node "x/deck-layout/scripts/generate.cjs" "y.native-ppt.json"' },
    };
    expect(nativeExecOrderFromTools([partial])).toEqual(['x7']);
  });
});
