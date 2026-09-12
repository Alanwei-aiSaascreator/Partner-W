import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  USER_DATA_OVERRIDE_ENV,
  applyUserDataOverride,
  resolveUserDataOverride,
} from '../src/main/runtime/user-data-override.js';

/**
 * dev/test 的 userData 隔离 —— **硬缺口 ②**（用户复审提出）。
 *
 * 背景是**一次真事故**：OpenClaw 相关目录可能含 Windows junction，
 * `rm -rf` 会沿着 junction 进真实目录把真身删掉。所以「模拟新用户」这件事
 * **绝不能**靠删真实 `%APPDATA%`，只能靠把 userData 指到一个一次性的临时目录。
 *
 * 这组测试守的是同一条规则的**另一半**：这个后门**只在显式设了环境变量时**生效。
 * 未设时"绝不改 userData" —— 否则正式用户的数据会被指到某个奇怪的路径上。
 */

const DEFAULT_DIR = 'C:\\Users\\someone\\AppData\\Roaming\\ClawWork';

describe('resolveUserDataOverride', () => {
  it('⭐ 未设 ⇒ null（正式用户跑起来必须原样）', () => {
    expect(resolveUserDataOverride({ env: {}, isPackaged: false, defaultUserData: DEFAULT_DIR })).toBeNull();
  });

  it('设了空串 / 纯空白 ⇒ null（不能因为一个空变量就把 userData 指到当前目录）', () => {
    expect(
      resolveUserDataOverride({
        env: { [USER_DATA_OVERRIDE_ENV]: '' },
        isPackaged: false,
        defaultUserData: DEFAULT_DIR,
      }),
    ).toBeNull();
    expect(
      resolveUserDataOverride({
        env: { [USER_DATA_OVERRIDE_ENV]: '   ' },
        isPackaged: false,
        defaultUserData: DEFAULT_DIR,
      }),
    ).toBeNull();
  });

  it('设了 + dev ⇒ 返回**绝对**路径', () => {
    const res = resolveUserDataOverride({
      env: { [USER_DATA_OVERRIDE_ENV]: path.join('tmp', 'clawwork-e2e-1') },
      isPackaged: false,
      defaultUserData: DEFAULT_DIR,
    });
    expect(res).not.toBeNull();
    expect(path.isAbsolute(res!)).toBe(true);
    expect(res!.endsWith(path.join('tmp', 'clawwork-e2e-1'))).toBe(true);
  });

  it('⭐ 打包后的正式版**绝不**认这个后门（否则用户环境里一个变量就能改数据目录）', () => {
    expect(
      resolveUserDataOverride({
        env: { [USER_DATA_OVERRIDE_ENV]: 'C:\\somewhere-else' },
        isPackaged: true,
        defaultUserData: DEFAULT_DIR,
      }),
    ).toBeNull();
  });

  it('指到默认目录本身 ⇒ null（没有要改的东西，别做无谓的 setPath）', () => {
    expect(
      resolveUserDataOverride({
        env: { [USER_DATA_OVERRIDE_ENV]: DEFAULT_DIR },
        isPackaged: false,
        defaultUserData: DEFAULT_DIR,
      }),
    ).toBeNull();
  });
});

describe('applyUserDataOverride', () => {
  function fakeApp() {
    return {
      getPath: vi.fn((name: string) => {
        if (name === 'userData') return DEFAULT_DIR;
        throw new Error(`unexpected app path: ${name}`);
      }),
      setPath: vi.fn(),
    };
  }

  it('⭐ 未设环境变量 ⇒ setPath **一次都不调用**（硬断言）', () => {
    const app = fakeApp();
    const applied = applyUserDataOverride({ app, env: {}, isPackaged: false });

    expect(applied).toBeNull();
    expect(app.setPath).not.toHaveBeenCalled();
  });

  it('设了 ⇒ 用解析后的目录调一次 setPath("userData", …)', () => {
    const app = fakeApp();
    const target = path.resolve('tmp', 'clawwork-e2e-2');
    const applied = applyUserDataOverride({
      app,
      env: { [USER_DATA_OVERRIDE_ENV]: target },
      isPackaged: false,
    });

    expect(app.setPath).toHaveBeenCalledTimes(1);
    expect(app.setPath).toHaveBeenCalledWith('userData', target);
    expect(applied).toBe(target);
  });

  it('⭐ 打包版即使设了也不动 userData', () => {
    const app = fakeApp();
    expect(applyUserDataOverride({ app, env: { [USER_DATA_OVERRIDE_ENV]: 'C:\\x' }, isPackaged: true })).toBeNull();
    expect(app.setPath).not.toHaveBeenCalled();
  });
});
