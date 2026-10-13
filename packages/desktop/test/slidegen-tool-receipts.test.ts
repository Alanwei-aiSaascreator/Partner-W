import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '@clawwork/shared';
import { writeSlideGenerationReceipt } from '../src/main/slidegen/receipt.js';
import * as collector from '../src/main/slidegen/tool-receipts.js';

let root = '';
let receiptFile = '';
const source = '```slidegen\n// title: Report\n<Slide><Text>One</Text></Slide>\n```';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const input = {
  sourceFile: 'report.slidegen',
  sourceSha256: hash(source),
  fileName: 'report.pptx',
  outputSha256: hash('output'),
  bytes: 6,
  pages: 1,
  resources: [],
  warnings: [],
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slidegen-tools-'));
  fs.writeFileSync(path.join(root, input.sourceFile), source);
  fs.writeFileSync(path.join(root, input.fileName), 'output');
  receiptFile = path.basename(writeSlideGenerationReceipt(root, input));
});
afterEach(() => {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('outside temp');
  fs.rmSync(root, { recursive: true, force: true });
});
function report(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    ...input,
    schemaVersion: 1,
    status: 'file-generated',
    fileCreated: true,
    artifactIndexed: false,
    visualReview: 'not-performed',
    receiptStatus: 'ready',
    receiptFile,
    ...overrides,
  });
}
function tool(overrides: Partial<ToolCall> = {}): ToolCall {
  return { id: 'tool-1', name: 'exec', status: 'done', startedAt: '', result: report(), ...overrides };
}
function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    taskId: 'task-1',
    sessionKey: 'session-1',
    runId: 'run-1',
    role: 'assistant',
    content: '',
    artifacts: [],
    toolCalls: [tool()],
    timestamp: '',
    ...overrides,
  };
}
function collect(messages = [message()], runId: string | undefined = 'run-1') {
  expect(collector.collectToolSlideReceipts).toBeTypeOf('function');
  return collector.collectToolSlideReceipts({
    workspacePath: root,
    taskId: 'task-1',
    sessionKey: 'session-1',
    runId,
    messages,
  });
}

it('revalidates the receipt named by the completed current-run tool result', () => {
  expect(collect()).toMatchObject({ receipts: [{ receiptFile, receipt: input }], rejected: 0 });
  expect(collect().receipts[0]?.source).toBe('// title: Report\n<Slide><Text>One</Text></Slide>');
});

it('reuses only the exact parsed source and preserves warnings with the actual output name', () => {
  expect(collector.reuseToolSlideDeck).toBeTypeOf('function');
  const entries = collect().receipts;
  expect(collector.reuseToolSlideDeck(root, entries, { title: 'Report', source: entries[0]!.source })).toEqual([]);
  expect(collector.reuseToolSlideDeck(root, entries, { title: 'Report', source: 'different body' })).toBeNull();
});

it('revalidates the final output again at the point of skipping a render', () => {
  expect(collector.reuseToolSlideDeck).toBeTypeOf('function');
  const entries = collect().receipts;
  fs.writeFileSync(path.join(root, input.fileName), 'change');
  expect(() => collector.reuseToolSlideDeck(root, entries, { title: 'Report', source: entries[0]!.source })).toThrow(
    'receipt-version-mismatch',
  );
});

it('does not reuse an old output after images and receipt resource metadata change together', () => {
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets/pixel.png'), 'first');
  const imageSource = source.replace('<Slide>', '<Slide><Image src="assets/pixel.png"/>');
  fs.writeFileSync(path.join(root, input.sourceFile), imageSource);
  const value = {
    ...input,
    sourceSha256: hash(imageSource),
    resources: [{ file: 'assets/pixel.png', bytes: 5, sha256: hash('first') }],
  };
  const file = writeSlideGenerationReceipt(root, value);
  const entries = collect([
    message({ toolCalls: [tool({ result: report({ ...value, receiptFile: path.basename(file) }) })] }),
  ]).receipts;
  expect(entries).toHaveLength(1);
  fs.writeFileSync(path.join(root, 'assets/pixel.png'), 'second');
  const changed = JSON.parse(fs.readFileSync(file, 'utf8'));
  changed.resources = [{ file: 'assets/pixel.png', bytes: 6, sha256: hash('second') }];
  fs.writeFileSync(file, JSON.stringify(changed));
  expect(() => collector.reuseToolSlideDeck(root, entries, { title: 'Report', source: entries[0]!.source })).toThrow(
    'tool-receipt-mismatch',
  );
});
it.each([
  { taskId: 'other' },
  { sessionKey: 'other' },
  { runId: 'other' },
  { runId: undefined },
  { role: 'user' as const },
])('ignores tool results outside the exact assistant task/session/run scope: %j', (override) => {
  expect(collect([message(override)])).toEqual({ receipts: [], rejected: 0 });
});
it('requires an explicit current run instead of using legacy messages', () => {
  expect(collect([message({ runId: undefined })], '')).toEqual({ receipts: [], rejected: 0 });
});
it.each(['running', 'error', 'awaitingApproval', 'declared'] as const)('ignores %s tools', (status) => {
  expect(collect([message({ toolCalls: [tool({ status })] })]).receipts).toEqual([]);
});
it('ignores read tools and assistant text quoting a generation report', () => {
  expect(collect([message({ content: report(), toolCalls: [tool({ name: 'read' })] })]).receipts).toEqual([]);
});
it('does not scan valid but unreferenced receipts in the shared workspace', () => {
  expect(collect([message({ toolCalls: [] })])).toEqual({ receipts: [], rejected: 0 });
});
it('deduplicates a replay of the same tool proof', () => {
  expect(collect([message(), message({ id: 'message-2' })]).receipts).toHaveLength(1);
});
it.each(['source', 'output'])('rejects a changed %s after the tool finished', (kind) => {
  fs.writeFileSync(path.join(root, kind === 'source' ? input.sourceFile : input.fileName), 'changed');
  expect(collect()).toEqual({ receipts: [], rejected: 1 });
});
it.each([
  { fileName: 'other.pptx' },
  { sourceSha256: 'a'.repeat(64) },
  { outputSha256: 'b'.repeat(64) },
  { pages: 2 },
  { bytes: 7 },
  { receiptFile: '../outside.json' },
  { receiptFile: 'unrelated.json' },
  { fileCreated: false },
  { artifactIndexed: true },
  { visualReview: 'passed' },
])('rejects a report that disagrees with the verified receipt: %j', (override) => {
  expect(collect([message({ toolCalls: [tool({ result: report(override) })] })]).receipts).toEqual([]);
});
it.each([
  '',
  '{"receiptFile":',
  report() + '\n(Command exited with code 1)',
  'prefix\n' + report(),
  report() + '\n' + report(),
])('ignores incomplete, failed or non-isolated stdout', (result) => {
  expect(collect([message({ toolCalls: [tool({ result })] })]).receipts).toEqual([]);
});
it('accepts a complete successful process poll without taking running or log output as completion', () => {
  const poll = tool({
    name: 'process',
    args: { action: 'poll', sessionId: 'child-1' },
    result: report() + '\n\nProcess exited with code 0.',
  });
  expect(collect([message({ toolCalls: [poll] })]).receipts).toHaveLength(1);
  expect(collect([message({ toolCalls: [{ ...poll, args: { action: 'log' } }] })]).receipts).toEqual([]);
  expect(
    collect([message({ toolCalls: [{ ...poll, result: report() + '\n\nProcess still running.' }] })]).receipts,
  ).toEqual([]);
});
it('claims a report printed before the process exited only when that session exits cleanly', () => {
  const poll = tool({
    id: 'poll-1',
    name: 'process',
    args: { action: 'poll', sessionId: 'child-1' },
    result: report() + '\n\nProcess still running.',
  });
  const cleanExit = {
    ...poll,
    id: 'poll-2',
    result: '(no new output)\n\nProcess exited with code 0.',
  };
  expect(collect([message({ toolCalls: [poll, cleanExit] })]).receipts).toHaveLength(1);
  expect(
    collect([
      message({ toolCalls: [poll, { ...cleanExit, result: '(no new output)\n\nProcess exited with code 1.' }] }),
    ]).receipts,
  ).toEqual([]);
  expect(
    collect([message({ toolCalls: [poll, { ...cleanExit, args: { action: 'poll', sessionId: 'other-child' } }] })])
      .receipts,
  ).toEqual([]);
});
it('resolves a background generation whose report arrived before its silent clean exit', () => {
  const launch = tool({
    args: { command: 'node deck-layout/scripts/generate.cjs' },
    result: 'Command still running (session quiet-river, pid 42). Use process for follow-up.',
  });
  const reportPoll = tool({
    id: 'poll-1',
    name: 'process',
    args: { action: 'poll', sessionId: 'quiet-river' },
    result: report() + '\n\nProcess still running.',
  });
  const silentExit = tool({
    id: 'poll-2',
    name: 'process',
    args: { action: 'poll', sessionId: 'quiet-river' },
    result: '(no new output)\n\nProcess exited with code 0.',
  });
  const entries = collect([message({ toolCalls: [reportPoll, silentExit] })]).receipts;
  expect(entries).toHaveLength(1);
  expect(collector.hasUnconfirmedSlideToolOutput([launch, reportPoll, silentExit], entries)).toBe(false);
  // Unrecognized output on the exit poll still poisons the launch (fail-closed).
  expect(
    collector.hasUnconfirmedSlideToolOutput(
      [launch, reportPoll, { ...silentExit, result: 'boom\n\nProcess exited with code 0.' }],
      entries,
    ),
  ).toBe(true);
});
it('rejects contradictory completed proofs sharing the same tool id', () => {
  const tools = [tool(), tool({ result: report({ outputSha256: 'b'.repeat(64) }) })];
  expect(collect([message({ toolCalls: tools })]).receipts).toEqual([]);
});
it.each([
  { status: 'error' as const, result: report() },
  { result: report({ status: 'render-failed', receiptStatus: 'unavailable' }) },
  { result: '{"schemaVersion":1' },
  { result: undefined },
])('rejects an earlier success contradicted by a completed tool snapshot: %j', (override) => {
  expect(collect([message(), message({ toolCalls: [tool(override)] })]).receipts).toEqual([]);
  expect(collect([message({ toolCalls: [tool(override)] }), message()]).receipts).toEqual([]);
});
it('allows a running snapshot to become a completed success', () => {
  expect(collect([message({ toolCalls: [tool({ status: 'running' })] }), message()]).receipts).toHaveLength(1);
});
it('enforces the proof limit on the final tool rather than on the next iteration', () => {
  const tools = Array.from({ length: 257 }, (_, index) => tool({ id: `tool-${index}` }));
  expect(collect([message({ toolCalls: tools.slice(0, 256) })]).receipts).toHaveLength(1);
  expect(collect([message({ toolCalls: tools })]).receipts).toEqual([]);
});
it('bounds stdout rather than extracting a report out of truncated or oversized text', () => {
  expect(
    collect([message({ toolCalls: [tool({ result: report() + ' '.repeat(2 * 1024 * 1024) })] })]).receipts,
  ).toEqual([]);
});

it('pauses automatic fallback for an existing file without a usable receipt or unknown output', () => {
  expect(collector.hasUnconfirmedSlideToolOutput).toBeTypeOf('function');
  for (const result of [
    report({ receiptStatus: 'unavailable', receiptFile: undefined }),
    report({ status: 'output-unconfirmed', fileCreated: null, receiptStatus: undefined, receiptFile: undefined }),
    report().slice(0, 70),
  ]) {
    expect(
      collector.hasUnconfirmedSlideToolOutput(
        [
          tool({
            args: { command: 'node "C:\\skills\\deck-layout\\scripts\\generate.cjs" --source report.slidegen' },
            result,
          }),
        ],
        [],
      ),
    ).toBe(true);
  }
});
it('accepts a verified completed report but never an errored or unverified success report', () => {
  const entries = collect().receipts;
  expect(collector.hasUnconfirmedSlideToolOutput([tool()], entries)).toBe(false);
  expect(collector.hasUnconfirmedSlideToolOutput([tool()], [])).toBe(true);
  expect(collector.hasUnconfirmedSlideToolOutput([tool({ status: 'error' })], entries)).toBe(true);
});
it('distinguishes confirmed no-output failure from an unknown outcome and ignores unrelated tools', () => {
  const failure = JSON.stringify({
    schemaVersion: 1,
    status: 'source-invalid',
    fileCreated: false,
    artifactIndexed: false,
    visualReview: 'not-performed',
  });
  expect(
    collector.hasUnconfirmedSlideToolOutput(
      [
        tool({
          result: failure + '\n\n(Command exited with code 1)',
          args: { command: 'node deck-layout/scripts/generate.cjs' },
        }),
      ],
      [],
    ),
  ).toBe(false);
  expect(
    collector.hasUnconfirmedSlideToolOutput(
      [
        tool({ name: 'web_search', result: 'Some results' }),
        tool({ args: { command: 'node unrelated.cjs' }, result: 'Done' }),
        tool({ args: { command: 'node unrelated/scripts/generate.cjs' }, result: 'Done' }),
      ],
      [],
    ),
  ).toBe(false);
});
it('resolves a background generation only with its own verified terminal poll', () => {
  const launch = tool({
    args: { command: 'node deck-layout/scripts/generate.cjs' },
    result: 'Command still running (session quiet-river, pid 42). Use process for follow-up.',
  });
  const poll = tool({
    id: 'poll-1',
    name: 'process',
    args: { action: 'poll', sessionId: 'quiet-river' },
    result: report() + '\n\nProcess exited with code 0.',
  });
  const entries = collect([message({ toolCalls: [poll] })]).receipts;
  expect(collector.hasUnconfirmedSlideToolOutput([launch], [])).toBe(true);
  expect(collector.hasUnconfirmedSlideToolOutput([launch, poll], entries)).toBe(false);
  expect(
    collector.hasUnconfirmedSlideToolOutput(
      [launch, { ...poll, args: { action: 'poll', sessionId: 'another' } }],
      entries,
    ),
  ).toBe(true);
  expect(collector.hasUnconfirmedSlideToolOutput([launch, { ...poll, result: report() }], entries)).toBe(true);
  expect(
    collector.hasUnconfirmedSlideToolOutput(
      [launch, poll, { ...poll, id: 'poll-2', result: 'truncated\n\nProcess exited with code 0.' }],
      entries,
    ),
  ).toBe(true);
});
it('holds a background generation with an intermediate poll but accepts its confirmed no-output exit', () => {
  const launch = tool({
    args: { command: 'node deck-layout/scripts/generate.cjs' },
    result: 'Command still running (session quiet-river, pid 42). Use process for follow-up.',
  });
  const poll = tool({
    id: 'poll-1',
    name: 'process',
    args: { action: 'poll', sessionId: 'quiet-river' },
    result: '\n\nProcess still running.',
  });
  const failure = JSON.stringify({
    schemaVersion: 1,
    status: 'source-invalid',
    fileCreated: false,
    artifactIndexed: false,
    visualReview: 'not-performed',
  });
  expect(collector.hasUnconfirmedSlideToolOutput([launch, poll], [])).toBe(true);
  expect(
    collector.hasUnconfirmedSlideToolOutput(
      [launch, poll, { ...poll, id: 'poll-2', result: failure + '\n\nProcess exited with code 1.' }],
      [],
    ),
  ).toBe(false);
});

it('does not mistake successful preflight and other schema-one tools for generation attempts', () => {
  const preflight = tool({
    id: 'preflight',
    args: { command: 'node skills/deck-layout/scripts/preflight.cjs report.slidegen' },
    result: JSON.stringify({
      schemaVersion: 1,
      status: 'source-valid',
      pages: 1,
      sourceSha256: input.sourceSha256,
      diagnostics: [],
    }),
  });
  const other = tool({
    id: 'other',
    result: JSON.stringify({ schemaVersion: 1, status: 'complete', value: 'other tool' }),
  });
  expect(collector.hasUnconfirmedSlideToolOutput([preflight, other, tool()], collect().receipts)).toBe(false);
});

it('binds final candidate registration to the whole confirmed receipt snapshot', () => {
  const entries = collect().receipts;
  expect(collector.isToolSlideOutputCurrent).toBeTypeOf('function');
  expect(collector.isToolSlideOutputCurrent(root, entries, input.fileName)).toBe(true);
  expect(collector.isToolSlideOutputCurrent(root, entries, 'unrelated.txt')).toBe(true);
  fs.writeFileSync(path.join(root, input.fileName), 'change');
  expect(collector.isToolSlideOutputCurrent(root, entries, input.fileName)).toBe(false);
});
it('rejects final registration after the source changes even if output bytes do not change', () => {
  const entries = collect().receipts;
  fs.writeFileSync(path.join(root, input.sourceFile), source.replace('One', 'Two'));
  expect(collector.isToolSlideOutputCurrent(root, entries, input.fileName)).toBe(false);
});
it('rejects final registration after receipt metadata is rewritten to describe a new valid source', () => {
  const entries = collect().receipts;
  const next = source.replace('One', 'Two');
  fs.writeFileSync(path.join(root, input.sourceFile), next);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, receiptFile), 'utf8'));
  receipt.sourceSha256 = hash(next);
  fs.writeFileSync(path.join(root, receiptFile), JSON.stringify(receipt));
  expect(collector.isToolSlideOutputCurrent(root, entries, input.fileName)).toBe(false);
});

function pageRecord(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    status: 'slidegen-progress',
    sourceSha256: input.sourceSha256,
    completed: 1,
    total: 1,
    ...overrides,
  });
}

it('accepts only validated page telemetry before the exact current-run receipt', () => {
  const call = tool({ result: pageRecord() + '\n' + report() });
  const result = collect([message({ toolCalls: [call] })]);
  expect(result).toMatchObject({ receipts: [{ receiptFile }], rejected: 0 });
  expect(collector.hasUnconfirmedSlideToolOutput([call], result.receipts)).toBe(false);
});

it('accepts a terminal process poll tail with page telemetry and the exact receipt', () => {
  const call = tool({
    name: 'process',
    args: { action: 'poll', sessionId: 'native-session' },
    result: pageRecord() + '\n' + report() + '\n\nProcess exited with code 0.',
  });
  expect(collect([message({ toolCalls: [call] })])).toMatchObject({ receipts: [{ receiptFile }], rejected: 0 });
});

it.each([
  ['source changes', pageRecord({ sourceSha256: hash('changed') })],
  ['page total differs', pageRecord({ total: 2 })],
  ['foreign prefix', 'untrusted text'],
  ['duplicate progress', pageRecord() + '\n' + pageRecord()],
  ['two terminal reports', report()],
])('rejects a contaminated terminal stream: %s', (_label, prefix) => {
  expect(collect([message({ toolCalls: [tool({ result: prefix + '\n' + report() })] })]).receipts).toEqual([]);
});

it('recognizes a verified failure after real page telemetry without claiming a file', () => {
  const result =
    pageRecord() +
    '\n' +
    JSON.stringify({
      schemaVersion: 1,
      status: 'render-failed',
      sourceSha256: input.sourceSha256,
      fileCreated: false,
      artifactIndexed: false,
      visualReview: 'not-performed',
    }) +
    '\n\n(Command exited with code 1)';
  const call = tool({ args: { command: 'node "managed/deck-layout/scripts/generate.cjs" "report.slidegen"' }, result });
  expect(collect([message({ toolCalls: [call] })]).receipts).toEqual([]);
  expect(collector.hasUnconfirmedSlideToolOutput([call], [])).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// native 直通流（2026-10-06 attempt02 真机）：receipt.sourceFile 是**暂存副本**
// `.royin-native-*/source.json`，生成命令里的源参数是工作区文件
// `门店客户反馈处理培训.native-ppt.json` —— 两者永不相等。
// `superseded` 必须在该不等时回退比对「更晚且已被 receipt 认领」那次渲染**命令里的源参数**，
// 否则模型每一次引号/JSON 试错都会把整单毒化成 `slidegen-output-unconfirmed`。
const nativeEntry: collector.ToolSlideReceipt = {
  receiptFile: '.royin-ppt-receipt-07341805-6cdf-4ceb-968b-d837b1c25f12.json',
  source: '{"kind":"pptx"}',
  receipt: {
    schemaVersion: 1,
    sourceFormat: 'native-template-v5',
    templateContract: 'templateDeck-v2',
    revision: 0,
    sourceFile: '.royin-native-4eRF4u/source.json',
    sourceSha256: 'c'.repeat(64),
    fileName: '门店客户反馈处理培训-8f01e198.pptx',
    outputSha256: 'd'.repeat(64),
    bytes: 51173,
    pages: 11,
    resources: [],
    warnings: [],
    workspaceIdentity: { dev: '1', ino: '2' },
    visualReview: 'not-performed',
    artifactIndexed: false,
  },
};
function nativeReport(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    status: 'file-generated',
    fileCreated: true,
    artifactIndexed: false,
    visualReview: 'not-performed',
    receiptStatus: 'ready',
    receiptFile: nativeEntry.receiptFile,
    sourceSha256: nativeEntry.receipt.sourceSha256,
    fileName: nativeEntry.receipt.fileName,
    outputSha256: nativeEntry.receipt.outputSha256,
    bytes: nativeEntry.receipt.bytes,
    pages: nativeEntry.receipt.pages,
    contentReview: 'field-coverage-passed',
    officeReview: 'not-performed',
    qualityStatus: 'needs-review',
    ...overrides,
  });
}
const nativeSourceArgument = '"门店客户反馈处理培训.native-ppt.json"';
function failedNativeAttempt(id = 'exec-quote-error'): ToolCall {
  return tool({
    id,
    args: {
      command: `set "ROYIN_NATIVE_PPT_VALIDATION=1" && node "Q:\\skills\\deck-layout\\scripts\\generate.cjs" ${nativeSourceArgument}`,
    },
    result: '标记“&&”不是此版本中的有效语句分隔符。\n\n(Command exited with code 1)',
  });
}

it('supersedes an earlier failed native exec when a later claimed render used the same workspace source', () => {
  const succeeded = tool({
    id: 'exec-succeeded',
    args: {
      command: `$env:ROYIN_NATIVE_PPT_VALIDATION="1"; node "Q:\\skills\\deck-layout\\scripts\\generate.cjs" ${nativeSourceArgument}`,
    },
    result: nativeReport(),
  });
  expect(collector.hasUnconfirmedSlideToolOutput([failedNativeAttempt(), succeeded], [nativeEntry])).toBe(false);
});

it('supersedes an earlier failed native exec from its own claimed background session', () => {
  const launch = tool({
    id: 'exec-launch',
    args: {
      command: `$env:ROYIN_NATIVE_PPT_VALIDATION="1"; node "Q:\\skills\\deck-layout\\scripts\\generate.cjs" ${nativeSourceArgument}`,
    },
    result: 'Command still running (session native-render-1, pid 4242). Use process for follow-up.',
  });
  const poll = tool({
    id: 'poll-1',
    name: 'process',
    args: { action: 'poll', sessionId: 'native-render-1' },
    result: nativeReport() + '\n\nProcess exited with code 0.',
  });
  expect(collector.hasUnconfirmedSlideToolOutput([failedNativeAttempt(), launch, poll], [nativeEntry])).toBe(false);
});

/**
 * ⭐ V1（2026-10-13）：`ToolCallStatus` 新增 `declared`（只有模型声明、未确认执行）。
 * `superseded` 守卫的本意是"**还在进行中**的尝试不能被更晚的收据取代"（先等它）——
 * `declared` 与 running/awaitingApproval 同类（未结束），必须一并挡住。
 * 不挡的话：模型刚声明、还没确认执行的那次尝试会被后来（甚至别处）的收据"取代"掉，
 * 它自己的未认领输出就被静默豁免了。
 */
it('⭐ declared（只有声明、未确认执行）也算"未结束"，不被更晚的收据取代', () => {
  const declared = { ...failedNativeAttempt('exec-declared'), status: 'declared' as const };
  const succeeded = tool({
    id: 'exec-succeeded',
    args: {
      command: `$env:ROYIN_NATIVE_PPT_VALIDATION="1"; node "Q:\\skills\\deck-layout\\scripts\\generate.cjs" ${nativeSourceArgument}`,
    },
    result: nativeReport(),
  });
  expect(collector.hasUnconfirmedSlideToolOutput([declared, succeeded], [nativeEntry])).toBe(true);
});

it('does not supersede a failed native attempt when the later claim used a different source file', () => {
  const succeeded = tool({
    id: 'exec-succeeded',
    args: {
      command:
        '$env:ROYIN_NATIVE_PPT_VALIDATION="1"; node "Q:\\skills\\deck-layout\\scripts\\generate.cjs" "门店客户反馈处理培训-v2.native-ppt.json"',
    },
    result: nativeReport(),
  });
  expect(collector.hasUnconfirmedSlideToolOutput([failedNativeAttempt(), succeeded], [nativeEntry])).toBe(true);
});

it('keeps a failed native attempt unconfirmed when the later claim cannot name its source', () => {
  const launch = tool({
    id: 'exec-launch',
    args: { command: 'node "Q:\\skills\\deck-layout\\scripts\\generate.cjs"' },
    result: 'Command still running (session native-render-2, pid 7). Use process for follow-up.',
  });
  const poll = tool({
    id: 'poll-1',
    name: 'process',
    args: { action: 'poll', sessionId: 'native-render-2' },
    result: nativeReport() + '\n\nProcess exited with code 0.',
  });
  expect(collector.hasUnconfirmedSlideToolOutput([failedNativeAttempt(), launch, poll], [nativeEntry])).toBe(true);
});

it('keeps the non-native supersede path unchanged when receipt and command agree on the source', () => {
  const failed = tool({
    id: 'exec-failed',
    args: { command: 'node "Q:\\skills\\deck-layout\\scripts\\generate.cjs" "report.slidegen"' },
    result: 'Error: unexpected token\n\n(Command exited with code 1)',
  });
  expect(collector.hasUnconfirmedSlideToolOutput([failed, tool()], collect().receipts)).toBe(false);
});

/**
 * ⭐ **B 包（2026-10-07）：收据读哪去 —— 报告里那句"东西写在哪"。**
 *
 * 现场（真机）：模型把 CLI 的 cwd 设成了**应用工作区根层**（不是助手工作区），
 * 于是收据与成品都落在那里。主进程只按助手工作区找收据 ⇒ 读不到 ⇒
 * "已确认的输出"变成 `slidegen-output-unconfirmed`（一条假失败），而那份真文件
 * 只能靠扫描兜（2026-10-07 起第三个根会收它，但那是**兜底**，不是"这条链通了"）。
 *
 * 判据：报告里的 `outputDir` 若落在**我们认的根**里（助手工作区，或调用方额外
 * 交进来的应用工作区），就从**那个目录**读收据；收据自己带着目录身份
 * （`workspaceIdentity` 的 dev/ino），读错目录会在 `verify` 那一步被拒。
 * ⚠️ 报告会经过模型（工具结果原文）⇒ 它**可以编**：所以只有"落在我们认的根里"
 * 才认，其余一律回落原行为（fail-closed，不是放宽）。
 */
describe('报告里的输出位置（B 包）', () => {
  let appWorkspace = '';
  beforeEach(() => {
    appWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'slidegen-app-workspace-'));
    fs.writeFileSync(path.join(appWorkspace, input.sourceFile), source);
    fs.writeFileSync(path.join(appWorkspace, input.fileName), 'output');
  });
  afterEach(() => {
    if (!path.resolve(appWorkspace).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('outside temp');
    fs.rmSync(appWorkspace, { recursive: true, force: true });
  });
  function appReceipt(): string {
    return path.basename(writeSlideGenerationReceipt(appWorkspace, input));
  }
  function collectAt(reportOverrides: Record<string, unknown>, allowed?: string[]) {
    return collector.collectToolSlideReceipts({
      workspacePath: root,
      taskId: 'task-1',
      sessionKey: 'session-1',
      runId: 'run-1',
      messages: [message({ toolCalls: [tool({ result: report(reportOverrides) })] })],
      ...(allowed ? { allowedReceiptRoots: allowed } : {}),
    });
  }

  it('⭐ 认下报告指认的那个根，并从**那里**把收据读回来（成品不在助手工作区也算数）', () => {
    const result = collectAt({ receiptFile: appReceipt(), outputDir: appWorkspace }, [appWorkspace]);
    expect(result.rejected).toBe(0);
    expect(result.receipts).toHaveLength(1);
    // 条目记住自己在哪 —— 后面"复制进任务目录"要按它算源文件的绝对路径
    expect(result.receipts[0]?.outputDir).toBe(fs.realpathSync(appWorkspace));
  });

  it('⭐ 没把那个目录交进来 ⇒ 一个字都不认（回落原行为，不是放宽）', () => {
    const result = collectAt({ receiptFile: appReceipt(), outputDir: appWorkspace });
    expect(result.receipts).toEqual([]);
    expect(result.rejected).toBe(1);
  });

  it('⭐ 报告指认的目录不在我们认的根里 ⇒ 不认（模型编的路径不作数）', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'slidegen-elsewhere-'));
    try {
      const result = collectAt({ receiptFile: appReceipt(), outputDir: elsewhere }, [appWorkspace]);
      expect(result.receipts).toEqual([]);
      expect(result.rejected).toBe(1);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('⭐ 收据被搬到别的目录 ⇒ 目录身份对不上，照样不认（dev/ino 绑定）', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'slidegen-moved-receipt-'));
    try {
      fs.writeFileSync(path.join(elsewhere, input.sourceFile), source);
      fs.writeFileSync(path.join(elsewhere, input.fileName), 'output');
      const receiptFile = appReceipt();
      fs.copyFileSync(path.join(appWorkspace, receiptFile), path.join(elsewhere, receiptFile));
      const result = collectAt({ receiptFile, outputDir: elsewhere }, [elsewhere]);
      expect(result.receipts).toEqual([]);
      expect(result.rejected).toBe(1);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('负对照：报告不写输出位置 ⇒ 老行为一字不变（助手工作区里那份照旧认）', () => {
    expect(collect()).toMatchObject({ receipts: [{ receiptFile, receipt: input }], rejected: 0 });
  });
});
