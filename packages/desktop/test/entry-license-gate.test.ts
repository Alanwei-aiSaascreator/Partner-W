import { describe, expect, it, vi } from 'vitest';
import type { IpcResult } from '@clawwork/shared';
import {
  createEntryLicenseGate,
  type EntryLicenseApi,
  type EntryLicenseStatus,
} from '../src/renderer/lib/entry-license-gate';
const license = (overrides: Partial<EntryLicenseStatus> = {}): EntryLicenseStatus => ({
  configured: true,
  activated: true,
  licenseId: 'license-1',
  orgId: 'org-1',
  licenseKey: 'RY-EXACT',
  sku: 'USB',
  status: 'active',
  expiresAt: null,
  maxActivations: 1,
  tokenQuotaMicros: 1000,
  tokenUsedMicros: 0,
  deviceFingerprint: 'device-1',
  ...overrides,
});
const missing = license({
  configured: false,
  activated: false,
  licenseId: null,
  orgId: null,
  licenseKey: null,
  status: null,
});
function api() {
  return {
    commercialLicenseStatus: vi.fn(async (): Promise<IpcResult<EntryLicenseStatus>> => ({ ok: true, result: missing })),
    commercialLicenseActivate: vi.fn(
      async (key: string): Promise<IpcResult<EntryLicenseStatus>> => ({
        ok: true,
        result: license({ licenseKey: key }),
      }),
    ),
    commercialLicenseRecoverActivation: vi.fn(
      async (key: string): Promise<IpcResult<EntryLicenseStatus>> => ({
        ok: true,
        result: license({ licenseKey: key }),
      }),
    ),
  } satisfies EntryLicenseApi;
}
const request = (bridge: EntryLicenseApi, activationKey = 'RY-EXACT') => ({
  api: bridge,
  activationKey,
  userId: 'user-1',
  isCurrent: () => true,
});
describe('entry license gate', () => {
  it('uses current usable entitlement without redeeming the supplied card', async () => {
    const bridge = api();
    bridge.commercialLicenseStatus.mockResolvedValue({ ok: true, result: license() });
    await expect(createEntryLicenseGate().ensure(request(bridge, 'ANOTHER-CARD'))).resolves.toEqual(license());
    expect(bridge.commercialLicenseActivate).not.toHaveBeenCalled();
    expect(bridge.commercialLicenseRecoverActivation).not.toHaveBeenCalled();
  });
  it('reads entitlement before explicitly activating a trimmed key', async () => {
    const bridge = api(),
      order: string[] = [];
    bridge.commercialLicenseStatus.mockImplementation(async () => {
      order.push('read');
      return { ok: true, result: missing };
    });
    bridge.commercialLicenseActivate.mockImplementation(async (key) => {
      order.push('activate');
      return { ok: true, result: license({ licenseKey: key }) };
    });
    await expect(createEntryLicenseGate().ensure(request(bridge, '  RY-EXACT  '))).resolves.toEqual(license());
    expect(order).toEqual(['read', 'activate']);
    expect(bridge.commercialLicenseActivate).toHaveBeenCalledWith('RY-EXACT');
  });
  it.each([
    ['empty_key', missing],
    ['license_inactive', license({ status: 'revoked' })],
    ['license_expired', license({ expiresAt: '2000-01-01T00:00:00Z' })],
    ['license_read_failed', license({ expiresAt: 'not-a-date' })],
    ['license_read_failed', license({ licenseId: null })],
  ] as const)('rejects %s entitlement without a replacement key', async (code, status) => {
    const bridge = api();
    bridge.commercialLicenseStatus.mockResolvedValue({ ok: true, result: status });
    await expect(createEntryLicenseGate().ensure(request(bridge, ''))).rejects.toMatchObject({ code });
    expect(bridge.commercialLicenseActivate).not.toHaveBeenCalled();
  });
  it.each(['activation_outcome_unknown', 'license_read_failed', 'ipc-thrown', 'wrong-card'] as const)(
    'recovers %s through readonly reconciliation instead of another redemption',
    async (mode) => {
      const bridge = api(),
        gate = createEntryLicenseGate();
      if (mode === 'ipc-thrown') bridge.commercialLicenseActivate.mockRejectedValueOnce(new Error('lost IPC'));
      else
        bridge.commercialLicenseActivate.mockResolvedValueOnce(
          mode === 'wrong-card'
            ? { ok: true, result: license({ licenseKey: 'ANOTHER-CARD' }) }
            : { ok: false, errorCode: mode },
        );
      await expect(gate.ensure(request(bridge))).rejects.toMatchObject({ code: 'activation_outcome_unknown' });
      await expect(gate.ensure(request(bridge, 'NEW-CARD'))).resolves.toEqual(license());
      expect(bridge.commercialLicenseActivate).toHaveBeenCalledTimes(1);
      expect(bridge.commercialLicenseRecoverActivation).toHaveBeenCalledWith('RY-EXACT');
      expect(bridge.commercialLicenseStatus).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps unresolved recovery pending across repeated user checks', async () => {
    const bridge = api(),
      gate = createEntryLicenseGate();
    bridge.commercialLicenseActivate.mockResolvedValueOnce({ ok: false, errorCode: 'activation_outcome_unknown' });
    bridge.commercialLicenseRecoverActivation.mockResolvedValue({ ok: false, errorCode: 'activation_outcome_unknown' });
    for (let i = 0; i < 3; i++)
      await expect(gate.ensure(request(bridge))).rejects.toMatchObject({ code: 'activation_outcome_unknown' });
    expect(bridge.commercialLicenseActivate).toHaveBeenCalledTimes(1);
    expect(bridge.commercialLicenseRecoverActivation).toHaveBeenCalledTimes(2);
  });
  it('allows correction after a definite rejected card', async () => {
    const bridge = api(),
      gate = createEntryLicenseGate();
    bridge.commercialLicenseActivate.mockResolvedValueOnce({ ok: false, errorCode: 'license_not_found' });
    await expect(gate.ensure(request(bridge))).rejects.toMatchObject({ code: 'license_not_found' });
    await expect(gate.ensure(request(bridge, 'RY-CORRECT'))).resolves.toMatchObject({ licenseKey: 'RY-CORRECT' });
    expect(bridge.commercialLicenseRecoverActivation).not.toHaveBeenCalled();
  });
  it('does not query or activate from an already superseded attempt', async () => {
    const bridge = api();
    await expect(createEntryLicenseGate().ensure({ ...request(bridge), isCurrent: () => false })).rejects.toMatchObject(
      { code: 'entry_superseded' },
    );
    expect(bridge.commercialLicenseStatus).not.toHaveBeenCalled();
    expect(bridge.commercialLicenseActivate).not.toHaveBeenCalled();
  });
  it('does not activate after account replacement while the read was pending', async () => {
    const bridge = api();
    let current = true,
      finish: ((result: IpcResult<EntryLicenseStatus>) => void) | undefined;
    bridge.commercialLicenseStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const work = createEntryLicenseGate().ensure({ ...request(bridge), isCurrent: () => current });
    const assertion = expect(work).rejects.toMatchObject({ code: 'entry_superseded' });
    current = false;
    finish?.({ ok: true, result: missing });
    await assertion;
    expect(bridge.commercialLicenseActivate).not.toHaveBeenCalled();
  });
  it('shares one same-account same-key activation across concurrent callers', async () => {
    const bridge = api(),
      gate = createEntryLicenseGate();
    const a = gate.ensure(request(bridge)),
      b = gate.ensure(request(bridge));
    await expect(Promise.all([a, b])).resolves.toEqual([license(), license()]);
    expect(bridge.commercialLicenseStatus).toHaveBeenCalledTimes(1);
    expect(bridge.commercialLicenseActivate).toHaveBeenCalledTimes(1);
  });
  it('does not reuse an unresolved card for another account', async () => {
    const bridge = api(),
      gate = createEntryLicenseGate();
    bridge.commercialLicenseActivate.mockResolvedValueOnce({ ok: false, errorCode: 'activation_outcome_unknown' });
    await expect(gate.ensure(request(bridge))).rejects.toMatchObject({ code: 'activation_outcome_unknown' });
    await expect(gate.ensure({ ...request(bridge, 'RY-USER-2'), userId: 'user-2' })).resolves.toMatchObject({
      licenseKey: 'RY-USER-2',
    });
    expect(bridge.commercialLicenseRecoverActivation).not.toHaveBeenCalled();
  });
  it.each([license({ licenseId: null }), license({ expiresAt: 'invalid' })])(
    'does not redeem when the current entitlement read is malformed',
    async (status) => {
      const bridge = api();
      bridge.commercialLicenseStatus.mockResolvedValueOnce({ ok: true, result: status });
      await expect(createEntryLicenseGate().ensure(request(bridge))).rejects.toMatchObject({
        code: 'license_read_failed',
      });
      expect(bridge.commercialLicenseActivate).not.toHaveBeenCalled();
    },
  );
  it('rejects a parallel different card without replacing the existing activation', async () => {
    const bridge = api(),
      gate = createEntryLicenseGate();
    const first = gate.ensure(request(bridge));
    await expect(gate.ensure(request(bridge, 'ANOTHER-CARD'))).rejects.toMatchObject({ code: 'entry_busy' });
    await expect(first).resolves.toEqual(license());
    expect(bridge.commercialLicenseActivate).toHaveBeenCalledTimes(1);
  });
  it.each(['', 'local'])('does not activate without a commercial account identity: %s', async (userId) => {
    const bridge = api();
    await expect(createEntryLicenseGate().ensure({ ...request(bridge), userId })).rejects.toMatchObject({
      code: 'entry_identity_unavailable',
    });
    expect(bridge.commercialLicenseStatus).not.toHaveBeenCalled();
    expect(bridge.commercialLicenseActivate).not.toHaveBeenCalled();
  });
  it.each(['superseded-error', 'late-success'] as const)(
    'retains a submitted key after scope loss: %s',
    async (mode) => {
      const bridge = api(),
        gate = createEntryLicenseGate();
      let current = true;
      bridge.commercialLicenseActivate.mockImplementationOnce(async () => {
        current = false;
        return mode === 'late-success'
          ? { ok: true, result: license() }
          : { ok: false, errorCode: 'activation_failed', error: 'superseded' };
      });
      await expect(gate.ensure({ ...request(bridge), isCurrent: () => current })).rejects.toMatchObject({
        code: 'entry_superseded',
      });
      await expect(gate.ensure(request(bridge))).resolves.toEqual(license());
      expect(bridge.commercialLicenseActivate).toHaveBeenCalledTimes(1);
      expect(bridge.commercialLicenseRecoverActivation).toHaveBeenCalledWith('RY-EXACT');
    },
  );
  it('retains a submitted key until complete status is confirmed', async () => {
    const bridge = api(),
      gate = createEntryLicenseGate();
    bridge.commercialLicenseActivate.mockResolvedValueOnce({ ok: true, result: license({ expiresAt: 'invalid' }) });
    await expect(gate.ensure(request(bridge))).rejects.toMatchObject({ code: 'license_read_failed' });
    await expect(gate.ensure(request(bridge))).resolves.toEqual(license());
    expect(bridge.commercialLicenseActivate).toHaveBeenCalledTimes(1);
    expect(bridge.commercialLicenseRecoverActivation).toHaveBeenCalledWith('RY-EXACT');
  });
  it('keeps a malformed readonly recovery pending', async () => {
    const bridge = api(),
      gate = createEntryLicenseGate();
    bridge.commercialLicenseActivate.mockResolvedValueOnce({ ok: false, errorCode: 'activation_outcome_unknown' });
    await expect(gate.ensure(request(bridge))).rejects.toMatchObject({ code: 'activation_outcome_unknown' });
    bridge.commercialLicenseRecoverActivation.mockResolvedValueOnce({
      ok: true,
      result: license({ expiresAt: 'invalid' }),
    });
    await expect(gate.ensure(request(bridge))).rejects.toMatchObject({ code: 'license_read_failed' });
    await expect(gate.ensure(request(bridge))).resolves.toEqual(license());
    expect(bridge.commercialLicenseActivate).toHaveBeenCalledTimes(1);
    expect(bridge.commercialLicenseRecoverActivation).toHaveBeenCalledTimes(2);
  });
});

/**
 * R2（2026-10-10 集中终审 §4）：显式换卡 intent='replace' —— 设置页/准备页的
 * ActivationSection 走这条。与原 ensure 的全部差别都在这里钉住。
 */
describe('entry license gate — replace intent（显式换卡）', () => {
  const replaceRequest = (bridge: EntryLicenseApi, activationKey = 'RY-NEW', userId = 'user-1') => ({
    api: bridge,
    activationKey,
    userId,
    isCurrent: () => true,
    intent: 'replace' as const,
  });
  /** ok:true 但没带 result 的畸形回包（judge 探针形状）：replace 也按成功。 */
  const bareOk = { ok: true } as unknown as IpcResult<EntryLicenseStatus>;

  it('⭐ 旧卡有效也必须换新卡：replace 跳过"已有许可"预读（不调 status），直接激活', async () => {
    const bridge = api();
    bridge.commercialLicenseStatus.mockResolvedValue({ ok: true, result: license() }); // 旧卡完全有效
    await expect(createEntryLicenseGate().ensure(replaceRequest(bridge))).resolves.toMatchObject({
      licenseKey: 'RY-NEW',
    });
    expect(bridge.commercialLicenseStatus).not.toHaveBeenCalled();
    expect(bridge.commercialLicenseActivate).toHaveBeenCalledWith('RY-NEW');
    expect(bridge.commercialLicenseRecoverActivation).not.toHaveBeenCalled();
  });

  it('⭐ 未知结果记 pending：下一次（同卡或换输入）先 recover、不再第二次 activate', async () => {
    const bridge = api(),
      gate = createEntryLicenseGate();
    bridge.commercialLicenseActivate.mockResolvedValueOnce({ ok: false, errorCode: 'activation_outcome_unknown' });
    bridge.commercialLicenseRecoverActivation.mockResolvedValue(bareOk); // 读不回 ⇒ 未确认
    await expect(gate.ensure(replaceRequest(bridge))).rejects.toMatchObject({ code: 'activation_outcome_unknown' });
    // 换输入也不能绕过 pending：仍按原 pending 卡恢复
    await expect(gate.ensure(replaceRequest(bridge, 'RY-OTHER'))).rejects.toMatchObject({
      code: 'activation_outcome_unknown',
    });
    expect(bridge.commercialLicenseActivate).toHaveBeenCalledTimes(1);
    expect(bridge.commercialLicenseRecoverActivation).toHaveBeenCalledTimes(1);
    expect(bridge.commercialLicenseRecoverActivation).toHaveBeenCalledWith('RY-NEW');
  });

  it('recovery 确认（licenseKey === 提交的卡）⇒ 清 pending 并以该状态成功', async () => {
    const bridge = api(),
      gate = createEntryLicenseGate();
    bridge.commercialLicenseActivate.mockResolvedValueOnce({ ok: false, errorCode: 'activation_outcome_unknown' });
    await expect(gate.ensure(replaceRequest(bridge))).rejects.toMatchObject({ code: 'activation_outcome_unknown' });
    await expect(gate.ensure(replaceRequest(bridge))).resolves.toMatchObject({ licenseKey: 'RY-NEW' });
    expect(bridge.commercialLicenseActivate).toHaveBeenCalledTimes(1);
    expect(bridge.commercialLicenseRecoverActivation).toHaveBeenCalledTimes(1);
  });

  it('replace 成功判据 = 服务端受理（ok:true 无 result 也按成功；权威状态由 overview 刷新给出）', async () => {
    const bridge = api();
    bridge.commercialLicenseActivate.mockResolvedValueOnce(bareOk);
    await expect(createEntryLicenseGate().ensure(replaceRequest(bridge))).resolves.toBeUndefined();
  });

  it('明确拒绝（license_not_found）⇒ 清 pending、原样抛该码，然后可以再换一张', async () => {
    const bridge = api(),
      gate = createEntryLicenseGate();
    bridge.commercialLicenseActivate.mockResolvedValueOnce({ ok: false, errorCode: 'license_not_found' });
    await expect(gate.ensure(replaceRequest(bridge))).rejects.toMatchObject({ code: 'license_not_found' });
    await expect(gate.ensure(replaceRequest(bridge, 'RY-CORRECT'))).resolves.toMatchObject({
      licenseKey: 'RY-CORRECT',
    });
    expect(bridge.commercialLicenseRecoverActivation).not.toHaveBeenCalled();
  });

  it('空卡号 ⇒ empty_key，一个 IPC 都不发', async () => {
    const bridge = api();
    await expect(createEntryLicenseGate().ensure(replaceRequest(bridge, '   '))).rejects.toMatchObject({
      code: 'empty_key',
    });
    expect(bridge.commercialLicenseActivate).not.toHaveBeenCalled();
    expect(bridge.commercialLicenseStatus).not.toHaveBeenCalled();
  });

  it('⭐ 单飞区分 intent/key：在飞的 ensure 不得冒充 replace（entry_busy）', async () => {
    const bridge = api(),
      gate = createEntryLicenseGate();
    let finish: ((value: IpcResult<EntryLicenseStatus>) => void) | undefined;
    bridge.commercialLicenseStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = gate.ensure(request(bridge)); // ensure 在飞（读 status 挂起）
    await expect(gate.ensure(replaceRequest(bridge))).rejects.toMatchObject({ code: 'entry_busy' });
    finish?.({ ok: true, result: license() });
    await expect(first).resolves.toEqual(license());
    expect(bridge.commercialLicenseActivate).not.toHaveBeenCalled();
  });

  it('replace 在飞时，同账号 ensure 同样 entry_busy（互不搭车）', async () => {
    const bridge = api(),
      gate = createEntryLicenseGate();
    let finish: ((value: IpcResult<EntryLicenseStatus>) => void) | undefined;
    bridge.commercialLicenseActivate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = gate.ensure(replaceRequest(bridge));
    await expect(gate.ensure(request(bridge))).rejects.toMatchObject({ code: 'entry_busy' });
    finish?.({ ok: true, result: license({ licenseKey: 'RY-NEW' }) });
    await expect(first).resolves.toMatchObject({ licenseKey: 'RY-NEW' });
  });

  it('replace 也核 isCurrent：换卡途中的 supersede 不许落结果', async () => {
    const bridge = api();
    let current = true;
    bridge.commercialLicenseActivate.mockImplementationOnce(async () => {
      current = false;
      return { ok: true, result: license({ licenseKey: 'RY-NEW' }) };
    });
    await expect(
      createEntryLicenseGate().ensure({ ...replaceRequest(bridge), isCurrent: () => current }),
    ).rejects.toMatchObject({ code: 'entry_superseded' });
  });
});
