export type EntryLicenseStatus = NonNullable<
  Awaited<ReturnType<Window['clawwork']['commercialLicenseStatus']>>['result']
>;
export type EntryLicenseApi = Pick<
  Window['clawwork'],
  'commercialLicenseStatus' | 'commercialLicenseActivate' | 'commercialLicenseRecoverActivation'
>;
/**
 * 激活意图（U2/R2，2026-10-10 集中终审 §4）：
 * - `ensure`（默认）：登录/入口流 —— 先读现状，**已有有效许可就早退**（原行为不变）；
 * - `replace`：显式换卡（设置页/准备页的 ActivationSection）—— 跳过预读，旧卡有效
 *   也必须把新卡真正换上（否则"换卡"在旧卡有效时是个假按钮）。
 */
export type EntryLicenseIntent = 'ensure' | 'replace';
export interface EntryLicenseRequest {
  userId: string;
  activationKey: string;
  api: EntryLicenseApi;
  isCurrent: () => boolean;
  /** 缺省 `ensure`（保持原行为）。 */
  intent?: EntryLicenseIntent;
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
  const inFlight = new Map<
    string,
    { intent: EntryLicenseIntent; key: string; work: Promise<EntryLicenseStatus | undefined> }
  >();
  const check = (request: EntryLicenseRequest) => {
    if (!request.isCurrent()) throw new EntryLicenseError('entry_superseded');
    // R2（§4）：`replace` 的身份由宿主上下文保证（登录后的设置/准备页；scope 只作
    // 作废判据、不作激活前置）。入口流 `ensure` 仍强制"登录身份可用"。
    if ((request.intent ?? 'ensure') === 'ensure' && (!request.userId.trim() || request.userId === 'local')) {
      throw new EntryLicenseError('entry_identity_unavailable');
    }
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
  /**
   * ⚠️ R2（§4）：返回值类型按 intent 收窄 ——
   * - `ensure`（默认）：入口流，成功必带回完整状态（App 要拿 licenseId/orgId 建 entitlement）；
   * - `intent:'replace'`：换卡的成功判据 = **服务端受理（ok）**，不要求带回完整状态
   *   （权威状态由随后的 overview 刷新给出）；IPC 形状里 `result` 本身可选 ⇒
   *   如实返回 `EntryLicenseStatus | undefined`，换卡入口不使用该返回值。
   */
  const execute = async (request: EntryLicenseRequest): Promise<EntryLicenseStatus | undefined> => {
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
    /**
     * R2（§4 合同 3/4）：显式换卡 —— **不做**"现有许可是否有效"的预读：
     * ensure 那条早退会让"旧卡有效时换卡"变成假动作，新卡根本不会激活。
     * 成功判据 = 服务端受理（`ok`）；权威状态由随后的 overview 刷新给出
     * （入口流 ensure 的严格 confirm 是另一个语义，别混用）。
     * 结果不确定（unknown / 读不到）与 ensure 同等纪律：记 pending ⇒ 先 recover，
     * 未确认前不再 redeem（下一次调用走上面的 pending 分支）。
     */
    if ((request.intent ?? 'ensure') === 'replace') {
      const replaceKey = request.activationKey.trim();
      if (!replaceKey) throw new EntryLicenseError('empty_key');
      pendingByAccount.set(request.userId, replaceKey);
      let activation: Awaited<ReturnType<EntryLicenseApi['commercialLicenseActivate']>>;
      try {
        activation = await request.api.commercialLicenseActivate(replaceKey);
      } catch {
        pendingByAccount.set(request.userId, replaceKey);
        check(request);
        throw new EntryLicenseError('activation_outcome_unknown');
      }
      const replaceUncertain =
        activation.errorCode === 'activation_outcome_unknown' || activation.errorCode === 'license_read_failed';
      if (replaceUncertain) pendingByAccount.set(request.userId, replaceKey);
      check(request);
      if (replaceUncertain) throw new EntryLicenseError('activation_outcome_unknown');
      if (!activation.ok) {
        pendingByAccount.delete(request.userId);
        throw new EntryLicenseError(activation.errorCode ?? 'activation_failed');
      }
      pendingByAccount.delete(request.userId);
      return activation.result;
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
  /** 换卡（显式 replace）：服务端受理即成功，可能不带回完整状态。 */
  function ensure(request: EntryLicenseRequest & { intent: 'replace' }): Promise<EntryLicenseStatus | undefined>;
  /** 入口流（默认 ensure）：成功必带回完整状态。 */
  function ensure(request: EntryLicenseRequest): Promise<EntryLicenseStatus>;
  function ensure(request: EntryLicenseRequest): Promise<EntryLicenseStatus | undefined> {
    try {
      check(request);
    } catch (error) {
      return Promise.reject(error);
    }
    const existing = inFlight.get(request.userId);
    if (existing) {
      // R2（§4 合同 4）：单飞判据必须**同时**区分 intent 与 key ——
      // 在飞的 ensure 结果不许冒充 replace（反之亦然），不同意图一律 entry_busy。
      const intent = request.intent ?? 'ensure';
      if (existing.intent !== intent || existing.key !== request.activationKey.trim()) {
        return Promise.reject(new EntryLicenseError('entry_busy'));
      }
      return existing.work.then((result) => {
        check(request);
        return result;
      });
    }
    const work = execute(request);
    inFlight.set(request.userId, { intent: request.intent ?? 'ensure', key: request.activationKey.trim(), work });
    const finish = () => {
      if (inFlight.get(request.userId)?.work === work) inFlight.delete(request.userId);
    };
    void work.then(finish, finish);
    return work;
  }
  return { ensure };
}
