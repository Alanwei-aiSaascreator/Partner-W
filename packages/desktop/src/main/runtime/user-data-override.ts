/**
 * dev/test 的 userData 隔离 —— **只能用这个办法模拟"新用户"**。
 *
 * ⚠️ 为什么非要这么绕（这是**一次真事故**换来的规则）：
 * OpenClaw 相关目录可能含 Windows junction（实测：state 目录里有指回
 * `node_modules/openclaw` 的 junction），`rm -rf` 会**沿着 junction 进真实目录**
 * 把真身删掉。我们因此删过 `openclaw.mjs`。
 * ⇒ 「首次启动」这类测试**绝不能**靠删真实 `%APPDATA%/魔方罗盘` / `openclaw-state`
 *   / `.state-*` 来模拟；只能把 userData **指到**一次性临时目录。
 *
 * ⚠️ 这个后门**只在显式设了环境变量时**生效，而且**打包后的正式版一律不认**
 * —— 否则用户环境里一个变量就能把数据目录改到别处去。
 *
 * ⚠️ 调用时机：必须在 Electron `app.ready` **之前**（`setPath('userData')`
 * 之后再建窗口，路径才是一致的）。
 */

import path from 'node:path';

/** 覆盖 userData 的环境变量名。 */
export const USER_DATA_OVERRIDE_ENV = 'CLAWWORK_USER_DATA_DIR';

/**
 * 解析出要改成的目录；不该改就返回 null（纯函数）。
 *
 * @param isPackaged 打包后的正式版 —— 一律不接受覆盖。
 * @param defaultUserData 当前的 userData —— 与目标相同时不必改（避免无谓的 setPath）。
 */
export function resolveUserDataOverride(opts: {
  env?: NodeJS.ProcessEnv;
  isPackaged: boolean;
  defaultUserData: string;
}): string | null {
  const { env = process.env, isPackaged, defaultUserData } = opts;

  if (isPackaged) return null;

  const raw = env[USER_DATA_OVERRIDE_ENV];
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;

  const resolved = path.resolve(raw.trim());
  if (resolved === path.resolve(defaultUserData)) return null;
  return resolved;
}

/**
 * 应用覆盖（副作用）。返回实际生效的目录，没生效则 null。
 *
 * ⚠️ 未设环境变量时**一次都不调用 `setPath`** —— 这条是硬要求，已有测试钉住。
 */
export function applyUserDataOverride(opts: {
  // ⚠️ 只声明真正用到的那两个 path 名。写成 `(name: string)` 的话签名比 Electron 的
  // `setPath` 宽，strictFunctionTypes 下**传不进真实的 app**（逆变）。
  app: {
    getPath: (name: 'userData') => string;
    setPath: (name: 'userData', value: string) => void;
  };
  env?: NodeJS.ProcessEnv;
  isPackaged: boolean;
}): string | null {
  const target = resolveUserDataOverride({
    env: opts.env,
    isPackaged: opts.isPackaged,
    defaultUserData: opts.app.getPath('userData'),
  });
  if (!target) return null;

  opts.app.setPath('userData', target);
  return target;
}
