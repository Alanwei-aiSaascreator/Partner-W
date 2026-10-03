import { describe, expect, it } from 'vitest';
import { deriveRelayConnectionNotice } from '../src/renderer/lib/relay-connection-notice.js';
import type { RelayLivenessPublicState } from '@clawwork/shared';

describe('deriveRelayConnectionNotice', () => {
  it.each([
    [{ phase: 'down', updatedAt: 2 } as RelayLivenessPublicState, 'connection.relayUnreachable'],
    [{ phase: 'up', updatedAt: 3 } as RelayLivenessPublicState, null],
    [{ phase: 'unknown', updatedAt: 4 } as RelayLivenessPublicState, null],
    [null, null],
    [undefined, null],
  ])('%o ⇒ %s', (liveness, expected) => {
    const notice = deriveRelayConnectionNotice({ liveness });
    expect(notice?.textKey ?? null).toBe(expected);
  });
});
