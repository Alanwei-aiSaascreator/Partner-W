import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeCacheScopeDir } from '../src/main/runtime/cache-scope.js';

const LOCAL_USER_DATA = 'C:\\Users\\u\\AppData\\Roaming\\@clawwork\\desktop';

describe('runtimeCacheScopeDir', () => {
  it('preserves the installed application cache root', () => {
    expect(
      runtimeCacheScopeDir({
        localUserDataDir: LOCAL_USER_DATA,
        effectiveUserDataDir: LOCAL_USER_DATA,
        portable: false,
      }),
    ).toBe(LOCAL_USER_DATA);
  });

  it('keeps portable runtime files on the effective portable data volume', () => {
    const eDrive = runtimeCacheScopeDir({
      localUserDataDir: LOCAL_USER_DATA,
      effectiveUserDataDir: 'E:\\portable-data',
      portable: true,
    });
    const sameScopeDifferentCase = runtimeCacheScopeDir({
      localUserDataDir: LOCAL_USER_DATA,
      effectiveUserDataDir: 'e:\\portable-data\\',
      portable: true,
    });
    const fDrive = runtimeCacheScopeDir({
      localUserDataDir: LOCAL_USER_DATA,
      effectiveUserDataDir: 'F:\\portable-data',
      portable: true,
    });

    expect(path.win32.relative(eDrive, sameScopeDifferentCase)).toBe('');
    expect(path.win32.relative('E:\\portable-data', eDrive)).toBe('portable-runtime-cache');
    expect(path.win32.relative('F:\\portable-data', fDrive)).toBe('portable-runtime-cache');
    expect(eDrive).not.toBe(LOCAL_USER_DATA);
    expect(eDrive).not.toBe(fDrive);
    expect(eDrive).not.toContain(LOCAL_USER_DATA);
    expect(fDrive).not.toContain(LOCAL_USER_DATA);
  });

  it('uses the effective data root for non-Windows portable deployments', () => {
    expect(
      runtimeCacheScopeDir({
        localUserDataDir: '/host/application-data',
        effectiveUserDataDir: '/media/device/application-data',
        portable: true,
      }),
    ).toBe(path.join('/media/device/application-data', 'portable-runtime-cache'));
  });
});
