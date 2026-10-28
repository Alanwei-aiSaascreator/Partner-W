import { describe, expect, it } from 'vitest';
import { deriveEntryPreparation, type EntryPreparationFacts } from '../src/renderer/lib/entry-preparation';
import { deriveStartupReadiness } from '../src/renderer/lib/startup-readiness';
const ready: EntryPreparationFacts = {
  scopeKey: 'scope-A',
  currentScopeKey: 'scope-A',
  accountUserId: 'A',
  entitlement: { userId: 'A', licenseId: 'license-A', orgId: 'org-A', status: 'active', expiresAt: null },
  runtime: { ok: true },
  now: 1000,
  startup: {
    gatewayId: 'local-runtime',
    relayPhase: 'ready',
    ai: { phase: 'ready' },
    assistants: { phase: 'ready', completed: 6, total: 6, missingIds: [] },
    workspaceAvailable: true,
    conversationReady: true,
    composerBlocked: false,
    isReady: true,
    hasError: false,
  },
};
describe('entry preparation facts', () => {
  it('allows continuation only with all current account, runtime, relay, catalog, workspace and assistant facts', () => {
    expect(deriveEntryPreparation(ready)).toEqual({ canContinue: true, stage: 'ready', hasError: false });
  });
  it.each([
    ['empty scope', { scopeKey: '' }, 'account'],
    ['old scope', { currentScopeKey: 'scope-B' }, 'account'],
    ['no account', { accountUserId: null }, 'account'],
    ['local account', { accountUserId: 'local' }, 'account'],
    ['wrong account', { entitlement: { ...ready.entitlement!, userId: 'B' } }, 'account'],
    ['missing license', { entitlement: { ...ready.entitlement!, licenseId: null } }, 'account'],
    ['missing organization', { entitlement: { ...ready.entitlement!, orgId: null } }, 'account'],
    ['expired license', { entitlement: { ...ready.entitlement!, expiresAt: '1970-01-01T00:00:00.999Z' } }, 'account'],
    ['malformed expiry', { entitlement: { ...ready.entitlement!, expiresAt: 'invalid' } }, 'account'],
    ['inactive license', { entitlement: { ...ready.entitlement!, status: 'revoked' } }, 'account'],
    ['no runtime', { runtime: null }, 'runtime'],
    ['failed runtime', { runtime: { ok: false, reason: 'process-exited' } }, 'runtime'],
    ['other gateway', { startup: { ...ready.startup, gatewayId: 'remote' } }, 'runtime'],
    ['relay not confirmed', { startup: { ...ready.startup, relayPhase: undefined } }, 'relay'],
    ['relay still running', { startup: { ...ready.startup, relayPhase: 'running' } }, 'relay'],
    [
      'catalog not confirmed',
      { startup: { ...ready.startup, conversationReady: false, ai: { phase: 'loading-models' } } },
      'models',
    ],
    ['workspace not confirmed', { startup: { ...ready.startup, workspaceAvailable: false } }, 'workspace'],
    [
      'assistant still verifying',
      { startup: { ...ready.startup, assistants: { ...ready.startup.assistants, phase: 'verifying' } } },
      'assistants',
    ],
  ] as const)('blocks %s even if the legacy isReady remains true', (_label, change, stage) => {
    const actual = deriveEntryPreparation({ ...ready, ...change });
    expect(actual.canContinue).toBe(false);
    expect(actual.stage).toBe(stage);
  });
  it('downgrades immediately after a known relay failure', () => {
    expect(
      deriveEntryPreparation({
        ...ready,
        startup: {
          ...ready.startup,
          relayPhase: 'blocked',
          relayFailure: { kind: 'activation-required', errorCode: 'license_required' },
        },
      }),
    ).toMatchObject({ canContinue: false, hasError: true, stage: 'relay' });
  });
  it('carries the real relay phase separately from the catalog and old ready flag', () => {
    const actual = deriveStartupReadiness({
      gatewayId: 'local-runtime',
      gatewayStatus: 'connected',
      rawModelCatalog: [{ id: 'deepseek', provider: 'clawrouter' }],
      catalogFailed: false,
      assistantSnapshot: { phase: 'ready', completed: 6, total: 6, missingIds: [] },
      relayState: { phase: 'running', updatedAt: 1 },
    });
    expect(actual.relayPhase).toBe('running');
    expect(actual.isReady).toBe(true);
  });
});
