import path from 'node:path';

export function runtimeCacheScopeDir(opts: {
  localUserDataDir: string;
  effectiveUserDataDir: string;
  portable: boolean;
}): string {
  if (!opts.portable) return opts.localUserDataDir;

  return path.join(opts.effectiveUserDataDir, 'portable-runtime-cache');
}
