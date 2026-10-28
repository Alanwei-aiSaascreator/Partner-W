import { describe, expect, it } from 'vitest';
import {
  loadRecentAssistantTasks,
  recordRecentAssistantTask,
  type AssistantTaskHistoryStorage,
} from '../src/renderer/lib/assistant-task-history';

class MemoryStorage implements AssistantTaskHistoryStorage {
  readonly values = new Map<string, string>();
  readonly setCalls: Array<{ key: string; value: string }> = [];

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.setCalls.push({ key, value });
    this.values.set(key, value);
  }
}

const keyFor = (userId: string) => `partner-w:assistant-task-history:v1:${userId}`;

describe('assistant task history', () => {
  it('isolates accounts, deduplicates newest first, and keeps at most five presets', () => {
    const storage = new MemoryStorage();
    const userAPresets = [
      'compass:goal-breakdown',
      'compass:execution-plan',
      'compass:option-comparison',
      'compass:comprehensive-analysis',
      'content:topic-planning',
      'content:long-form-writing',
      'content:short-video-script',
    ];

    for (const [index, presetId] of userAPresets.entries()) {
      recordRecentAssistantTask('user-a', presetId, storage, new Date(index).toISOString());
    }
    recordRecentAssistantTask('user-a', 'content:short-video-script', storage, new Date(10).toISOString());
    recordRecentAssistantTask('user-b', 'family:schedule-plan', storage, new Date(11).toISOString());

    expect(loadRecentAssistantTasks('user-a', storage)).toEqual([
      { presetId: 'content:short-video-script', usedAt: new Date(10).toISOString() },
      { presetId: 'content:long-form-writing', usedAt: new Date(5).toISOString() },
      { presetId: 'content:topic-planning', usedAt: new Date(4).toISOString() },
      { presetId: 'compass:comprehensive-analysis', usedAt: new Date(3).toISOString() },
      { presetId: 'compass:option-comparison', usedAt: new Date(2).toISOString() },
    ]);
    expect(loadRecentAssistantTasks('user-b', storage)).toEqual([
      { presetId: 'family:schedule-plan', usedAt: new Date(11).toISOString() },
    ]);
  });

  it('returns an empty history for corrupted storage', () => {
    const storage = new MemoryStorage();

    storage.values.set(keyFor('bad-json'), '{bad json');
    storage.values.set(keyFor('bad-shape'), JSON.stringify({ presetId: 'compass:not-an-array' }));

    expect(loadRecentAssistantTasks('bad-json', storage)).toEqual([]);
    expect(loadRecentAssistantTasks('bad-shape', storage)).toEqual([]);
  });

  it('fails closed when browser storage is unavailable or its getter throws', () => {
    expect(loadRecentAssistantTasks('no-window')).toEqual([]);
    expect(
      recordRecentAssistantTask('no-window', 'compass:goal-breakdown', undefined, new Date(1).toISOString()),
    ).toEqual([{ presetId: 'compass:goal-breakdown', usedAt: new Date(1).toISOString() }]);

    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.defineProperty({}, 'localStorage', {
        get() {
          throw new Error('localStorage unavailable');
        },
      }),
    });

    try {
      expect(loadRecentAssistantTasks('throwing-window')).toEqual([]);
      expect(
        recordRecentAssistantTask('throwing-window', 'compass:goal-breakdown', undefined, new Date(2).toISOString()),
      ).toEqual([{ presetId: 'compass:goal-breakdown', usedAt: new Date(2).toISOString() }]);
    } finally {
      if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('fails closed for throwing storage adapters while preserving an in-memory update', () => {
    const throwingRead: AssistantTaskHistoryStorage = {
      getItem() {
        throw new Error('read failed');
      },
      setItem() {},
    };
    const throwingWrite: AssistantTaskHistoryStorage = {
      getItem: () => null,
      setItem() {
        throw new Error('write failed');
      },
    };

    expect(loadRecentAssistantTasks('user-a', throwingRead)).toEqual([]);
    expect(
      recordRecentAssistantTask('user-a', 'compass:goal-breakdown', throwingWrite, new Date(3).toISOString()),
    ).toEqual([{ presetId: 'compass:goal-breakdown', usedAt: new Date(3).toISOString() }]);
  });

  it('ignores unknown, truncated, and malicious IDs before deduplication and the five-item limit', () => {
    const storage = new MemoryStorage();
    const validRecords = [
      'compass:goal-breakdown',
      'compass:execution-plan',
      'compass:option-comparison',
      'compass:comprehensive-analysis',
      'content:topic-planning',
    ].map((presetId, index) => ({ presetId, usedAt: new Date(index + 1).toISOString() }));
    storage.values.set(
      keyFor('user-a'),
      JSON.stringify([
        { presetId: 'compass:unknown', usedAt: new Date(20).toISOString() },
        { presetId: `${'compass:goal-breakdown'}${'x'.repeat(150)}`, usedAt: new Date(19).toISOString() },
        { presetId: 'compass:goal-breakdown\u0000evil', usedAt: new Date(18).toISOString() },
        { presetId: '../content:topic-planning', usedAt: new Date(17).toISOString() },
        { presetId: '<script>alert(1)</script>', usedAt: new Date(16).toISOString() },
        ...validRecords,
      ]),
    );

    expect(loadRecentAssistantTasks('user-a', storage)).toEqual(validRecords);
  });

  it('fails closed without persisting when asked to record an unknown preset ID', () => {
    const storage = new MemoryStorage();
    const original = JSON.stringify([{ presetId: 'compass:goal-breakdown', usedAt: new Date(1).toISOString() }]);
    storage.values.set(keyFor('user-a'), original);

    expect(recordRecentAssistantTask('user-a', 'compass:unknown', storage, new Date(2).toISOString())).toEqual([
      { presetId: 'compass:goal-breakdown', usedAt: new Date(1).toISOString() },
    ]);
    expect(storage.values.get(keyFor('user-a'))).toBe(original);
    expect(storage.setCalls).toEqual([]);

    expect(recordRecentAssistantTask('user-b', 'compass:goal-breakdown-evil', storage)).toEqual([]);
    expect(storage.values.has(keyFor('user-b'))).toBe(false);
    expect(storage.setCalls).toEqual([]);
  });

  it('sanitizes malformed records and stores no sensitive fields', () => {
    const storage = new MemoryStorage();
    storage.values.set(
      keyFor('user-a'),
      JSON.stringify([
        null,
        'not-an-object',
        { presetId: '', usedAt: new Date(1).toISOString() },
        { presetId: 'compass:goal-breakdown', usedAt: 'not-a-date' },
        {
          presetId: 'content:short-video-script',
          usedAt: new Date(2).toISOString(),
          prompt: 'private prompt',
          content: 'private content',
          phone: '13800000000',
          token: 'secret-token',
        },
      ]),
    );

    expect(loadRecentAssistantTasks('user-a', storage)).toEqual([
      { presetId: 'content:short-video-script', usedAt: new Date(2).toISOString() },
    ]);

    recordRecentAssistantTask('user-a', 'compass:goal-breakdown', storage, new Date(3).toISOString());
    const serialized = JSON.parse(storage.values.get(keyFor('user-a')) ?? '[]') as Array<Record<string, unknown>>;

    expect(serialized).toHaveLength(2);
    expect(serialized.every((record) => Object.keys(record).sort().join(',') === 'presetId,usedAt')).toBe(true);
    expect(JSON.stringify(serialized)).not.toMatch(/private prompt|private content|13800000000|secret-token/);
  });

  it('rejects wrong field types and non-canonical timestamps instead of coercing them', () => {
    const storage = new MemoryStorage();
    storage.values.set(
      keyFor('user-a'),
      JSON.stringify([
        { presetId: 123, usedAt: new Date(1).toISOString() },
        { presetId: 'compass:execution-plan', usedAt: 123 },
        { presetId: 'compass:option-comparison', usedAt: '2026-09-16' },
        { presetId: 'compass:comprehensive-analysis', usedAt: '2026-09-16T00:00:00Z' },
        { presetId: 'content:topic-planning', usedAt: '2026-09-16T00:00:00.000Z' },
      ]),
    );

    expect(loadRecentAssistantTasks('user-a', storage)).toEqual([
      { presetId: 'content:topic-planning', usedAt: '2026-09-16T00:00:00.000Z' },
    ]);
  });
});
