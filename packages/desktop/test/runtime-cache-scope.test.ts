import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeCacheScopeDir } from '../src/main/runtime/cache-scope.js';

const LOCAL_USER_DATA = 'C:\\Users\\u\\AppData\\Roaming\\@clawwork\\desktop';

describe('runtimeCacheScopeDir', () => {
  it('安装形态沿用原 userData，保持现有缓存兼容', () => {
    expect(
      runtimeCacheScopeDir({
        localUserDataDir: LOCAL_USER_DATA,
        effectiveUserDataDir: LOCAL_USER_DATA,
        portable: false,
      }),
    ).toBe(LOCAL_USER_DATA);
  });

  it('便携形态按单实例 userData 隔离本机缓存，不与安装版或另一块盘争写', () => {
    const eDrive = runtimeCacheScopeDir({
      localUserDataDir: LOCAL_USER_DATA,
      effectiveUserDataDir: 'E:\\荣盈魔方-运行数据',
      portable: true,
    });
    const sameScopeDifferentCase = runtimeCacheScopeDir({
      localUserDataDir: LOCAL_USER_DATA,
      effectiveUserDataDir: 'e:\\荣盈魔方-运行数据\\',
      portable: true,
    });
    const fDrive = runtimeCacheScopeDir({
      localUserDataDir: LOCAL_USER_DATA,
      effectiveUserDataDir: 'F:\\荣盈魔方-运行数据',
      portable: true,
    });

    expect(eDrive).toBe(sameScopeDifferentCase);
    expect(eDrive).not.toBe(LOCAL_USER_DATA);
    expect(eDrive).not.toBe(fDrive);
    expect(path.basename(path.dirname(eDrive))).toBe('portable-runtime-cache');
    expect(path.basename(eDrive)).toMatch(/^[a-f0-9]{64}$/u);
  });
});
