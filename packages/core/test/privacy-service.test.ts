import { describe, expect, it } from 'vitest';
import { normalizePrivacyState } from '../src/services/privacy-service.js';

/**
 * `privacy_my_state()` 回的是**数据库的行**（snake_case、数字可能是字符串、
 * 形状不受我们控制）。这一层的职责只有一条：把行归一成 DTO，
 * **一条脏字段不许让设置页白屏**。
 *
 * 字段名与服务端的对齐关系（迁移 51 `privacy_my_state()`）：
 *   export.{id,status,requested_at,snapshot_bytes}
 *   deletion.{id,status,requested_at,scheduled_for,cancellable}
 */

describe('normalizePrivacyState —— 把 RPC 的行转成 DTO', () => {
  it('空 / 非法输入给全空状态，不抛', () => {
    expect(normalizePrivacyState(null)).toEqual({ export: null, deletion: null });
    expect(normalizePrivacyState('nope')).toEqual({ export: null, deletion: null });
  });

  it('PostgREST 把数字序列化成字符串也要归一回 number', () => {
    const state = normalizePrivacyState({
      export: { id: 'a', status: 'ready', requested_at: '2026-09-17T00:00:00Z', snapshot_bytes: '1234' },
      deletion: null,
    });
    expect(state.export?.snapshotBytes).toBe(1234);
  });

  it('未知状态降级成 unknown，不把脏值透给界面', () => {
    const state = normalizePrivacyState({ export: null, deletion: { id: 'd', status: 'weird' } });
    expect(state.deletion?.status).toBe('unknown');
  });

  it('cancellable 必须是真布尔', () => {
    const state = normalizePrivacyState({
      deletion: { id: 'd', status: 'pending', scheduled_for: '2026-09-24T00:00:00Z', cancellable: 'true' },
    });
    expect(state.deletion?.cancellable).toBe(false);
  });

  it('四个字段名逐字映射 + 已知状态原样透出', () => {
    const state = normalizePrivacyState({
      export: { id: 'e1', status: 'ready', requested_at: '2026-09-17T01:02:03Z', snapshot_bytes: 512 },
      deletion: {
        id: 'd1',
        status: 'pending',
        requested_at: '2026-09-17T04:05:06Z',
        scheduled_for: '2026-09-24T04:05:06Z',
        cancellable: true,
      },
    });

    expect(state.export).toEqual({
      id: 'e1',
      status: 'ready',
      requestedAt: '2026-09-17T01:02:03Z',
      snapshotBytes: 512,
    });
    expect(state.deletion).toEqual({
      id: 'd1',
      status: 'pending',
      requestedAt: '2026-09-17T04:05:06Z',
      scheduledFor: '2026-09-24T04:05:06Z',
      cancellable: true,
    });
  });

  it('迁移 50 允许的七种状态都能过，别的都降级', () => {
    const known = ['pending', 'processing', 'ready', 'completed', 'cancelled', 'rejected', 'failed'];
    for (const status of known) {
      const state = normalizePrivacyState({ export: { id: 'e', status } });
      expect(state.export?.status).toBe(status);
    }
    for (const status of ['', 'READY', 'deleted', 7, null, undefined, {}]) {
      const state = normalizePrivacyState({ export: { id: 'e', status } });
      expect(state.export?.status).toBe('unknown');
    }
  });

  it('没有 id 的行直接丢弃（服务端只保证最新一条，可能根本没有）', () => {
    expect(normalizePrivacyState({ export: {}, deletion: { status: 'pending' } })).toEqual({
      export: null,
      deletion: null,
    });
    expect(normalizePrivacyState({ export: { id: '' } }).export).toBeNull();
  });

  it('行本身不是对象（数组 / 字符串 / 数字）也当没有', () => {
    expect(normalizePrivacyState({ export: [], deletion: 'x' })).toEqual({ export: null, deletion: null });
    expect(normalizePrivacyState([])).toEqual({ export: null, deletion: null });
    expect(normalizePrivacyState(42)).toEqual({ export: null, deletion: null });
  });

  it('数字字段：非法给 null，小数截断，不抛', () => {
    expect(normalizePrivacyState({ export: { id: 'e', snapshot_bytes: 'nope' } }).export?.snapshotBytes).toBeNull();
    expect(normalizePrivacyState({ export: { id: 'e', snapshot_bytes: 12.7 } }).export?.snapshotBytes).toBe(12);
    expect(normalizePrivacyState({ export: { id: 'e', snapshot_bytes: null } }).export?.snapshotBytes).toBeNull();
    expect(normalizePrivacyState({ export: { id: 'e' } }).export?.snapshotBytes).toBeNull();
  });

  it('字符串字段：缺 / 类型不对给空串（deletion 的 scheduled_for 是可以真缺的）', () => {
    const state = normalizePrivacyState({
      export: { id: 'e', requested_at: 123 },
      deletion: { id: 'd', scheduled_for: 0 },
    });
    expect(state.export?.requestedAt).toBe('');
    expect(state.deletion?.scheduledFor).toBeNull();
    expect(state.deletion?.requestedAt).toBe('');
  });

  it('一整坨垃圾也不抛', () => {
    expect(() => normalizePrivacyState({ export: { id: { o: 1 } }, deletion: [{ id: 'd' }] })).not.toThrow();
    expect(normalizePrivacyState({ export: { id: { o: 1 } }, deletion: [{ id: 'd' }] })).toEqual({
      export: null,
      deletion: null,
    });
  });
});
