import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
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
it.each(['running', 'error', 'awaitingApproval'] as const)('ignores %s tools', (status) => {
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
