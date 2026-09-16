import { describe, expect, it } from 'vitest';
import {
  loadRecentAssistantTasks,
  recordRecentAssistantTask,
  type AssistantTaskHistoryStorage,
} from '../src/renderer/lib/assistant-task-history';

class MemoryStorage implements AssistantTaskHistoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const keyFor = (userId: string) => `rongying-cube:assistant-task-history:v1:${userId}`;

describe('assistant task history', () => {
  it('isolates accounts, deduplicates newest first, and keeps at most five presets', () => {
    const storage = new MemoryStorage();

    for (let index = 0; index < 7; index += 1) {
      recordRecentAssistantTask('user-a', `compass:task-${index}`, storage, new Date(index).toISOString());
    }
    recordRecentAssistantTask('user-a', 'compass:task-6', storage, new Date(10).toISOString());
    recordRecentAssistantTask('user-b', 'compass:other', storage, new Date(11).toISOString());

    expect(loadRecentAssistantTasks('user-a', storage)).toEqual([
      { presetId: 'compass:task-6', usedAt: new Date(10).toISOString() },
      { presetId: 'compass:task-5', usedAt: new Date(5).toISOString() },
      { presetId: 'compass:task-4', usedAt: new Date(4).toISOString() },
      { presetId: 'compass:task-3', usedAt: new Date(3).toISOString() },
      { presetId: 'compass:task-2', usedAt: new Date(2).toISOString() },
    ]);
    expect(loadRecentAssistantTasks('user-b', storage)).toEqual([
      { presetId: 'compass:other', usedAt: new Date(11).toISOString() },
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
    expect(recordRecentAssistantTask('no-window', 'compass:new', undefined, new Date(1).toISOString())).toEqual([
      { presetId: 'compass:new', usedAt: new Date(1).toISOString() },
    ]);

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
      expect(recordRecentAssistantTask('throwing-window', 'compass:new', undefined, new Date(2).toISOString())).toEqual(
        [{ presetId: 'compass:new', usedAt: new Date(2).toISOString() }],
      );
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
    expect(recordRecentAssistantTask('user-a', 'compass:new', throwingWrite, new Date(3).toISOString())).toEqual([
      { presetId: 'compass:new', usedAt: new Date(3).toISOString() },
    ]);
  });

  it('sanitizes malformed records, bounds strings, and stores no sensitive fields', () => {
    const storage = new MemoryStorage();
    const oversizedPresetId = `compass:${'x'.repeat(150)}`;
    storage.values.set(
      keyFor('user-a'),
      JSON.stringify([
        null,
        'not-an-object',
        { presetId: '', usedAt: new Date(1).toISOString() },
        { presetId: 'compass:invalid-date', usedAt: 'not-a-date' },
        {
          presetId: oversizedPresetId,
          usedAt: new Date(2).toISOString(),
          prompt: 'private prompt',
          content: 'private content',
          phone: '13800000000',
          token: 'secret-token',
        },
      ]),
    );

    expect(loadRecentAssistantTasks('user-a', storage)).toEqual([
      { presetId: oversizedPresetId.slice(0, 100), usedAt: new Date(2).toISOString() },
    ]);

    recordRecentAssistantTask('user-a', 'compass:new', storage, new Date(3).toISOString());
    const serialized = JSON.parse(storage.values.get(keyFor('user-a')) ?? '[]') as Array<Record<string, unknown>>;

    expect(serialized).toHaveLength(2);
    expect(serialized.every((record) => Object.keys(record).sort().join(',') === 'presetId,usedAt')).toBe(true);
    expect(JSON.stringify(serialized)).not.toMatch(/private|phone|token|prompt|content/);
  });

  it('rejects wrong field types and non-canonical timestamps instead of coercing them', () => {
    const storage = new MemoryStorage();
    storage.values.set(
      keyFor('user-a'),
      JSON.stringify([
        { presetId: 123, usedAt: new Date(1).toISOString() },
        { presetId: 'compass:number-date', usedAt: 123 },
        { presetId: 'compass:date-only', usedAt: '2026-09-16' },
        { presetId: 'compass:no-millis', usedAt: '2026-09-16T00:00:00Z' },
        { presetId: 'compass:valid', usedAt: '2026-09-16T00:00:00.000Z' },
      ]),
    );

    expect(loadRecentAssistantTasks('user-a', storage)).toEqual([
      { presetId: 'compass:valid', usedAt: '2026-09-16T00:00:00.000Z' },
    ]);
  });
});
