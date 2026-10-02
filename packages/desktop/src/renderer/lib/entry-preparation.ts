import type { RuntimeBootstrapStatus } from '@clawwork/shared';
import type { EntryLicenseStatus } from './entry-license-gate';
import type { StartupReadiness } from './startup-readiness';
export type EntryEntitlement = Pick<EntryLicenseStatus, 'licenseId' | 'orgId' | 'status' | 'expiresAt'> & {
  userId: string;
};
export type EntryPreparationStage = 'account' | 'runtime' | 'relay' | 'models' | 'workspace' | 'assistants' | 'ready';
export interface EntryPreparationFacts {
  scopeKey: string;
  currentScopeKey: string;
  accountUserId: string | null;
  entitlement: EntryEntitlement | null;
  runtime: RuntimeBootstrapStatus | null | undefined;
  startup: StartupReadiness;
  now?: number;
}
export interface EntryPreparationState {
  canContinue: boolean;
  stage: EntryPreparationStage;
  hasError: boolean;
}

function blocked(stage: EntryPreparationStage, hasError = false): EntryPreparationState {
  return { canContinue: false, stage, hasError };
}
export function deriveEntryPreparation(facts: EntryPreparationFacts): EntryPreparationState {
  const { scopeKey, currentScopeKey, accountUserId, entitlement, runtime, startup } = facts;
  if (!scopeKey || scopeKey !== currentScopeKey || !accountUserId || accountUserId === 'local')
    return blocked('account');
  if (
    !entitlement ||
    entitlement.userId !== accountUserId ||
    !entitlement.licenseId ||
    !entitlement.orgId ||
    entitlement.status !== 'active'
  )
    return blocked('account', entitlement !== null);
  if (entitlement.expiresAt !== null) {
    const expiresAt = Date.parse(entitlement.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= (facts.now ?? Date.now())) return blocked('account', true);
  }
  if (runtime?.ok !== true || startup.gatewayId !== 'local-runtime') return blocked('runtime', runtime?.ok === false);
  if (startup.relayPhase !== 'ready' || startup.relayFailure) return blocked('relay', Boolean(startup.relayFailure));
  if (startup.ai.phase !== 'ready' || !startup.conversationReady)
    return blocked('models', startup.ai.phase === 'error' || startup.ai.phase === 'catalog-failed');
  if (!startup.workspaceAvailable) return blocked('workspace', Boolean(startup.assistantBlocker));
  if (startup.assistants.phase !== 'ready') return blocked('assistants', startup.assistants.phase === 'error');
  return { canContinue: true, stage: 'ready', hasError: false };
}
