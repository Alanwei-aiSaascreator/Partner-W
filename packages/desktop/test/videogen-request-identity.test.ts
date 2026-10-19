import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ ready: false, persist: true, rows: new Map<string, string>() }));
vi.mock('../src/main/db/index.js', () => ({
  getSqlite: () =>
    state.ready
      ? {
          prepare: () => ({
            get: (key: string) => (state.rows.has(key) ? { request_id: state.rows.get(key) } : undefined),
            run: (key: string, id: string) => {
              if (state.persist && !state.rows.has(key)) state.rows.set(key, id);
            },
          }),
        }
      : null,
}));
import { resolveVideogenRequestId } from '../src/main/videogen/request-identity.js';
const input = {
  taskId: 'task-1',
  request: {
    title: 'flower',
    model: 'seedance-2.5' as const,
    prompt: 'flower',
    duration: 5,
    resolution: '720P' as const,
    aspectRatio: '16:9' as const,
  },
};
beforeEach(() => {
  state.ready = false;
  state.persist = true;
  state.rows.clear();
});
it('does not produce a paid operation identity before the durable workspace database is ready', () => {
  expect(() => resolveVideogenRequestId(input)).toThrow('videogen-identity-unavailable');
  state.ready = true;
  const id = resolveVideogenRequestId(input);
  expect(resolveVideogenRequestId(input)).toBe(id);
  expect(state.rows.size).toBe(1);
});
it('never substitutes a different identity after a missing write acknowledgement', () => {
  state.ready = true;
  state.persist = false;
  expect(() => resolveVideogenRequestId(input)).toThrow('videogen-identity-unavailable');
});
