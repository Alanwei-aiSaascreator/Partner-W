import type { PortableAppDataApplyResult } from './portable-app-data.js';

export interface PortableStartupFailureCopy {
  title: string;
  content: string;
}

export interface PortableStartupFailureHooks {
  notifyFailure: (copy: PortableStartupFailureCopy) => void;
  exit: (code: number) => void;
}

export function continueAfterPortableAppData(
  result: PortableAppDataApplyResult,
  hooks: PortableStartupFailureHooks,
  continuation: () => void,
): boolean {
  if (result.failed !== undefined) {
    try {
      hooks.notifyFailure({
        title: 'Portable startup failed',
        content: [
          'The app could not prepare application data on the portable drive.',
          `Drive: ${(result.volumeRoot ?? 'Unknown').slice(0, 256)}`,
          'Reconnect the drive and check that it is writable and has enough free space, then try again.',
          `Details: ${result.failed.slice(0, 1024) || 'Path preparation failed.'}`,
          'The app will close.',
        ].join('\n\n'),
      });
    } finally {
      hooks.exit(1);
    }
    return false;
  }

  continuation();
  return true;
}
