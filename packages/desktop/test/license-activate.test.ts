import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();
const getCommercialClientMock = vi.fn(() => ({ rpc: rpcMock }));

vi.mock('../src/main/commercial/client.js', () => ({
  getCommercialClient: getCommercialClientMock,
}));

vi.mock('../src/main/workspace/config.js', () => ({
  ensureDeviceId: () => 'stable-device-id',
  readConfig: () => ({ commercial: { licenseKey: null } }),
  updateConfig: vi.fn(),
}));

describe('activateLicense', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getCommercialClientMock.mockReturnValue({ rpc: rpcMock } as never);
    rpcMock.mockResolvedValue({
      data: {
        licenseKey: 'RY-AAAA-BBBB',
        sku: 'USB-标准版',
        status: 'active',
        expiresAt: null,
        maxActivations: 1,
        tokenQuotaCents: 5000,
        tokenUsedCents: 0,
      },
      error: null,
    });
  });

  it('calls the activate_license rpc with the device fingerprint', async () => {
    const { activateLicense } = await import('../src/main/commercial/license.js');
    const res = await activateLicense('RY-AAAA-BBBB');

    expect(rpcMock).toHaveBeenCalledWith('activate_license', {
      p_license_key: 'RY-AAAA-BBBB',
      p_device_fingerprint: expect.any(String),
    });
    expect(res.ok).toBe(true);
  });

  it('rejects an empty key before hitting the network', async () => {
    const { activateLicense } = await import('../src/main/commercial/license.js');
    const res = await activateLicense('   ');

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('empty_key');
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('maps the activation limit error to its own code', async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { message: '激活数已达上限' },
    });
    const { activateLicense } = await import('../src/main/commercial/license.js');
    const res = await activateLicense('RY-AAAA-BBBB');

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('activation_limit_reached');
  });
});
