import type { ToolCall, ToolCallStatus } from '@clawwork/shared';
import { describe, expect, it } from 'vitest';
import { summarizeToolActivity } from '../src/renderer/lib/tool-activity';

function call(
  id: string,
  name: string,
  status: ToolCallStatus,
  startedAt = '2026-09-15T00:00:00.000Z',
  completedAt = '2026-09-15T00:00:01.000Z',
): ToolCall {
  return { id, name, status, startedAt, ...(status === 'running' ? {} : { completedAt }) };
}

describe('summarizeToolActivity', () => {
  it('groups repeated tools into semantic activities', () => {
    const summary = summarizeToolActivity([
      call('1', 'ls', 'done'),
      call('2', 'list_directory', 'done'),
      call('3', 'exec', 'done'),
    ]);

    expect(summary.groups.map((group) => [group.kind, group.calls.length])).toEqual([
      ['listDirectory', 2],
      ['execute', 1],
    ]);
    expect(summary.completedCount).toBe(3);
    expect(summary.durationMs).toBe(1000);
  });

  it('keeps failed calls separate from successful calls', () => {
    const summary = summarizeToolActivity([call('1', 'ls', 'done'), call('2', 'ls', 'error')]);

    expect(summary.errorCount).toBe(1);
    expect(summary.groups.map((group) => group.status)).toEqual(['done', 'error']);
  });

  it('reports running work and safely classifies unknown tools', () => {
    const summary = summarizeToolActivity([call('1', 'mystery_tool', 'running')]);

    expect(summary.runningCount).toBe(1);
    expect(summary.durationMs).toBeNull();
    expect(summary.groups[0].kind).toBe('other');
  });

  it.each([
    ['read_file', 'readFile'],
    ['rg', 'search'],
    ['shell', 'execute'],
    ['apply_patch', 'writeFile'],
    ['browser.open', 'browseWeb'],
  ] as const)('classifies %s as %s', (name, kind) => {
    expect(summarizeToolActivity([call('1', name, 'done')]).groups[0].kind).toBe(kind);
  });
});
