import { describe, expect, it } from 'vitest';
import { normalizeAssistantTurns } from '../src/protocol/normalize-history.js';
import type { RawHistoryMessage } from '../src/protocol/types.js';

function call(runId: string, timestamp: number): RawHistoryMessage {
  return {
    role: 'assistant',
    timestamp,
    __openclaw: { runId },
    content: [{ type: 'toolCall', id: 'reused-tool', name: 'exec' }],
  };
}

describe('canonical history run identity', () => {
  it('does not merge different runs even when their timestamps and tool IDs coincide', () => {
    const turns = normalizeAssistantTurns([call('first', 1000), call('second', 1000)]);
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.runId)).toEqual(['first', 'second']);
  });

  it('assigns a result only to the matching run that owns its reused tool ID', () => {
    const turns = normalizeAssistantTurns([
      call('first', 1000),
      call('second', 2000),
      {
        role: 'toolResult',
        timestamp: 3000,
        __openclaw: { runId: 'first' },
        toolCallId: 'reused-tool',
        isError: true,
        content: [{ type: 'text', text: 'first failed' }],
      },
      {
        role: 'toolResult',
        timestamp: 4000,
        __openclaw: { runId: 'second' },
        toolCallId: 'reused-tool',
        content: [{ type: 'text', text: 'second succeeded' }],
      },
    ]);
    expect(turns[0].toolCalls[0]).toMatchObject({ status: 'error', result: 'first failed' });
    expect(turns[1].toolCalls[0]).toMatchObject({ status: 'done', result: 'second succeeded' });
  });

  it('does not guess the owner of an ambiguous runless reused tool result', () => {
    const turns = normalizeAssistantTurns([
      call('first', 1000),
      call('second', 2000),
      {
        role: 'toolResult',
        timestamp: 3000,
        toolCallId: 'reused-tool',
        content: [{ type: 'text', text: 'ambiguous' }],
      },
    ]);
    expect(turns.every((turn) => turn.toolCalls[0].result === undefined)).toBe(true);
  });
});
