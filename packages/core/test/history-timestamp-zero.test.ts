import { afterEach, describe, expect, it, vi } from 'vitest';
import { toISOTimestamp } from '../src/protocol/normalize-history.js';

describe('canonical history timestamps', () => {
  afterEach(() => vi.useRealTimers());

  it('preserves epoch zero instead of replacing it with hydration time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T10:00:00.000Z'));
    expect(toISOTimestamp(0)).toBe('1970-01-01T00:00:00.000Z');
    vi.setSystemTime(new Date('2026-10-01T10:00:00.000Z'));
    expect(toISOTimestamp(0)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('retains known nonzero timestamps and the missing-timestamp fallback', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T10:00:00.000Z'));
    expect(toISOTimestamp(1000)).toBe('1970-01-01T00:00:01.000Z');
    expect(toISOTimestamp(undefined)).toBe('2026-09-30T10:00:00.000Z');
  });
});
