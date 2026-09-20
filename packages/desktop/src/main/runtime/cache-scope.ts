import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * 便携运行时缓存按 Electron 的单实例域（effective userData）隔离。
 *
 * 同一个 userData 的两个进程会被 `requestSingleInstanceLock()` 挡住；不同 U 盘的
 * userData 则落到不同 hash 目录。这样既不与安装版共用 current.json，也不会让两块
 * 盘上的首次启动互删 `deploy-*` 半成品。
 */
export function runtimeCacheScopeDir(opts: {
  localUserDataDir: string;
  effectiveUserDataDir: string;
  portable: boolean;
}): string {
  if (!opts.portable) return opts.localUserDataDir;

  const raw = opts.effectiveUserDataDir;
  const canonical = /^[A-Za-z]:[\\/]/u.test(raw)
    ? path.win32
        .normalize(raw)
        .replace(/[\\/]+$/u, '')
        .toLowerCase()
    : path.resolve(raw);
  const scope = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return path.join(opts.localUserDataDir, 'portable-runtime-cache', scope);
}
