import { describe, expect, it } from 'vitest';
import { entryAccountFromSession, entryModeFromConfig } from '../src/renderer/lib/app-entry-flow';

describe('commercial entry identity', () => {
  it('only accepts a verified session with its actual account identity', () => {
    expect(
      entryAccountFromSession({ ok: true, result: { signedIn: true, profile: { userId: 'user-1', nickname: null } } }),
    ).toEqual({ userId: 'user-1', nickname: '' });
    for (const session of [
      { ok: false },
      { ok: true },
      { ok: true, result: { signedIn: false, profile: { userId: 'user-1' } } },
      { ok: true, result: { signedIn: true, profile: null } },
      { ok: true, result: { signedIn: true, profile: { userId: '' } } },
      { ok: true, result: { signedIn: true, profile: { userId: 'local' } } },
    ])
      expect(entryAccountFromSession(session)).toBeNull();
  });
  it('distinguishes successful unconfigured local mode from a failed config read', () => {
    expect(entryModeFromConfig({ ok: true, result: { supabaseUrl: '', hasAnonKey: false } })).toBe('local');
    expect(entryModeFromConfig({ ok: true, result: { supabaseUrl: 'https://example.test', hasAnonKey: true } })).toBe(
      'commercial',
    );
    expect(entryModeFromConfig({ ok: false })).toBe('error');
    expect(entryModeFromConfig({ ok: true })).toBe('error');
    expect(entryModeFromConfig({ ok: true, result: { supabaseUrl: 'https://example.test', hasAnonKey: false } })).toBe(
      'error',
    );
  });
});
