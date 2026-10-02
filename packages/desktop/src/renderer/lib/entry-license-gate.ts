export type EntryLicenseStatus = NonNullable<
  Awaited<ReturnType<Window['clawwork']['commercialLicenseStatus']>>['result']
>;
export type EntryLicenseApi = Pick<
  Window['clawwork'],
  'commercialLicenseStatus' | 'commercialLicenseActivate' | 'commercialLicenseRecoverActivation'
>;
export interface EntryLicenseRequest {
  userId: string;
  activationKey: string;
  api: EntryLicenseApi;
  isCurrent: () => boolean;
}
export class EntryLicenseError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
function licenseProblem(status: EntryLicenseStatus): string | null {
  if (!status.configured || !status.activated) return 'empty_key';
  if (
    !status.licenseId?.trim() ||
    !status.orgId?.trim() ||
    !status.licenseKey?.trim() ||
    !status.deviceFingerprint.trim()
  )
    return 'license_read_failed';
  if (status.status !== 'active') return 'license_inactive';
  if (status.expiresAt !== null) {
    const expiry = Date.parse(status.expiresAt);
    if (!Number.isFinite(expiry)) return 'license_read_failed';
    if (expiry <= Date.now()) return 'license_expired';
  }
  return null;
}

export function createEntryLicenseGate() {
  const pendingByAccount = new Map<string, string>();
  const inFlight = new Map<string, { key: string; work: Promise<EntryLicenseStatus> }>();
  const check = (request: EntryLicenseRequest) => {
    if (!request.isCurrent()) throw new EntryLicenseError('entry_superseded');
    if (!request.userId.trim() || request.userId === 'local') throw new EntryLicenseError('entry_identity_unavailable');
  };
  const confirm = (status: EntryLicenseStatus | undefined, key: string) =>
    Boolean(
      status?.configured &&
      status.activated &&
      status.licenseId?.trim() &&
      status.orgId?.trim() &&
      status.deviceFingerprint?.trim() &&
      status.licenseKey === key,
    );
  const execute = async (request: EntryLicenseRequest): Promise<EntryLicenseStatus> => {
    check(request);
    const pendingKey = pendingByAccount.get(request.userId);
    if (pendingKey) {
      let recovery: Awaited<ReturnType<EntryLicenseApi['commercialLicenseRecoverActivation']>>;
      try {
        recovery = await request.api.commercialLicenseRecoverActivation(pendingKey);
      } catch {
        check(request);
        throw new EntryLicenseError('activation_outcome_unknown');
      }
      check(request);
      if (!recovery.ok || !confirm(recovery.result, pendingKey) || !recovery.result)
        throw new EntryLicenseError('activation_outcome_unknown');
      const problem = licenseProblem(recovery.result);
      if (problem === 'license_read_failed') throw new EntryLicenseError(problem);
      pendingByAccount.delete(request.userId);
      if (problem) throw new EntryLicenseError(problem);
      return recovery.result;
    }
    let current: Awaited<ReturnType<EntryLicenseApi['commercialLicenseStatus']>>;
    try {
      current = await request.api.commercialLicenseStatus();
    } catch {
      check(request);
      throw new EntryLicenseError('license_read_failed');
    }
    check(request);
    if (!current.ok || !current.result) throw new EntryLicenseError('license_read_failed');
    const problem = licenseProblem(current.result);
    if (!problem) return current.result;
    if (problem === 'license_read_failed') throw new EntryLicenseError(problem);
    const key = request.activationKey.trim();
    if (!key) throw new EntryLicenseError(problem);
    let activation: Awaited<ReturnType<EntryLicenseApi['commercialLicenseActivate']>>;
    pendingByAccount.set(request.userId, key);
    try {
      activation = await request.api.commercialLicenseActivate(key);
    } catch {
      pendingByAccount.set(request.userId, key);
      check(request);
      throw new EntryLicenseError('activation_outcome_unknown');
    }
    const uncertain =
      activation.errorCode === 'activation_outcome_unknown' ||
      activation.errorCode === 'license_read_failed' ||
      (activation.ok && !confirm(activation.result, key));
    if (uncertain) pendingByAccount.set(request.userId, key);
    check(request);
    if (uncertain) throw new EntryLicenseError('activation_outcome_unknown');
    if (!activation.ok || !activation.result) {
      pendingByAccount.delete(request.userId);
      throw new EntryLicenseError(activation.errorCode ?? 'activation_failed');
    }
    const activatedProblem = licenseProblem(activation.result);
    if (activatedProblem === 'license_read_failed') throw new EntryLicenseError(activatedProblem);
    pendingByAccount.delete(request.userId);
    if (activatedProblem) throw new EntryLicenseError(activatedProblem);
    return activation.result;
  };
  return {
    ensure(request: EntryLicenseRequest): Promise<EntryLicenseStatus> {
      try {
        check(request);
      } catch (error) {
        return Promise.reject(error);
      }
      const existing = inFlight.get(request.userId);
      if (existing) {
        if (existing.key !== request.activationKey.trim()) return Promise.reject(new EntryLicenseError('entry_busy'));
        return existing.work.then((result) => {
          check(request);
          return result;
        });
      }
      const work = execute(request);
      inFlight.set(request.userId, { key: request.activationKey.trim(), work });
      const finish = () => {
        if (inFlight.get(request.userId)?.work === work) inFlight.delete(request.userId);
      };
      void work.then(finish, finish);
      return work;
    },
  };
}
