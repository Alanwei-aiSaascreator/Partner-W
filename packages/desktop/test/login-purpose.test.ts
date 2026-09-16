import { describe, expect, it } from 'vitest';
import {
  LOGIN_PURPOSE_STORAGE_KEY,
  readLoginPurpose,
  resolveLoginPurposeUseCase,
} from '../src/renderer/lib/login-purpose';

function storage(value: string | null) {
  return {
    getItem: (key: string) => (key === LOGIN_PURPOSE_STORAGE_KEY ? value : null),
  };
}

describe('login purpose handoff', () => {
  it.each([
    ['content', 'content'],
    ['office', 'office'],
    ['ecommerce', 'ecommerce'],
    ['research', 'research'],
  ] as const)('maps %s to the matching onboarding use case', (purpose, useCase) => {
    expect(resolveLoginPurposeUseCase(purpose)).toBe(useCase);
    expect(readLoginPurpose(storage(purpose))).toBe(purpose);
  });

  it('ignores unknown or missing stored values', () => {
    expect(readLoginPurpose(storage('video'))).toBeNull();
    expect(readLoginPurpose(storage(null))).toBeNull();
  });
});
