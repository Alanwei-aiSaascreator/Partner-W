import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPortableAppData,
  portableAppDataPathFor,
  type PortableAppDataApplyInput,
  type PortableAppDataApplyResult,
} from '../src/main/runtime/portable-app-data.js';
import {
  continueAfterPortableAppData,
  type PortableStartupFailureCopy,
} from '../src/main/runtime/portable-startup-gate.js';

const WIN = path.win32;
const PORTABLE_ROOT = 'E:\\';
const DEFAULT_DATA = 'C:\\Users\\tester\\AppData\\Roaming\\desktop';
const PORTABLE_DATA = portableAppDataPathFor(PORTABLE_ROOT);

function input(overrides: Partial<PortableAppDataApplyInput> = {}): PortableAppDataApplyInput {
  return {
    app: { getPath: () => DEFAULT_DATA, setPath: vi.fn() },
    exePath: WIN.join(PORTABLE_ROOT, 'Compass', 'Compass.exe'),
    isPackaged: true,
    systemDrive: 'C:',
    exists: (candidate) => candidate === WIN.join(PORTABLE_ROOT, 'openclaw-runtime-manifest.json'),
    removableDrives: () => [],
    mkdir: vi.fn(),
    ...overrides,
  };
}

describe('portable application data failures', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['userData', 'sessionData', 'logs'] as const)('reports a %s setPath failure', (failedPath) => {
    const setPath = vi.fn((name: string) => {
      if (name === failedPath) throw new Error(`cannot redirect ${name}`);
    });

    expect(applyPortableAppData(input({ app: { getPath: () => DEFAULT_DATA, setPath } }))).toEqual({
      target: null,
      volumeRoot: PORTABLE_ROOT,
      reason: 'volume-marker',
      failed: `cannot redirect ${failedPath}`,
    });
    expect(setPath.mock.calls.map(([name]) => name)).toEqual(
      ['userData', 'sessionData', 'logs'].slice(0, ['userData', 'sessionData', 'logs'].indexOf(failedPath) + 1),
    );
  });

  it.each(['target', 'logs'])('reports a %s directory creation failure before setting paths', (failedDir) => {
    const setPath = vi.fn();
    const mkdir = vi.fn((directory: string) => {
      if (directory === (failedDir === 'target' ? PORTABLE_DATA : WIN.join(PORTABLE_DATA, 'logs'))) {
        throw new Error('portable volume unavailable');
      }
    });

    expect(applyPortableAppData(input({ app: { getPath: () => DEFAULT_DATA, setPath }, mkdir }))).toEqual({
      target: null,
      volumeRoot: PORTABLE_ROOT,
      reason: 'volume-marker',
      failed: 'portable volume unavailable',
    });
    expect(setPath).not.toHaveBeenCalled();
  });
});

describe('portable startup gate', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function run(result: PortableAppDataApplyResult) {
    const events: string[] = [];
    const continuation = vi.fn(() => events.push('continue'));
    const notifyFailure = vi.fn((_copy: PortableStartupFailureCopy) => events.push('notify'));
    const exit = vi.fn(() => events.push('exit'));
    const continued = continueAfterPortableAppData(result, { notifyFailure, exit }, continuation);
    return { events, continuation, notifyFailure, exit, continued };
  }

  it.each(['target', 'logs', 'userData', 'sessionData', 'logPath'])(
    'blocks continuation after a real %s preparation failure even when exit returns',
    (failure) => {
      const mkdir = (directory: string): void => {
        if (failure === 'target' || (failure === 'logs' && directory === WIN.join(PORTABLE_DATA, 'logs'))) {
          throw new Error(`cannot prepare ${failure}`);
        }
      };
      const setPath = (name: string): void => {
        if (name === (failure === 'logPath' ? 'logs' : failure)) {
          throw new Error(`cannot prepare ${failure}`);
        }
      };
      const outcome = run(applyPortableAppData(input({ app: { getPath: () => DEFAULT_DATA, setPath }, mkdir })));

      expect(outcome.continued).toBe(false);
      expect(outcome.events).toEqual(['notify', 'exit']);
      expect(outcome.continuation).not.toHaveBeenCalled();
      expect(outcome.exit).toHaveBeenCalledExactlyOnceWith(1);
      expect(outcome.notifyFailure).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          title: 'Portable startup failed',
          content: expect.stringContaining(`cannot prepare ${failure}`),
        }),
      );
    },
  );

  it('blocks startup for an empty failure string', () => {
    const outcome = run({ target: null, volumeRoot: PORTABLE_ROOT, reason: 'volume-marker', failed: '' });

    expect(outcome.events).toEqual(['notify', 'exit']);
    expect(outcome.continued).toBe(false);
    expect(outcome.continuation).not.toHaveBeenCalled();
  });

  it('exits even when native notification throws', () => {
    const exit = vi.fn();
    const continuation = vi.fn();

    expect(() =>
      continueAfterPortableAppData(
        { target: null, volumeRoot: PORTABLE_ROOT, reason: 'volume-marker', failed: 'EPERM' },
        {
          notifyFailure: () => {
            throw new Error('dialog unavailable');
          },
          exit,
        },
        continuation,
      ),
    ).toThrow('dialog unavailable');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(continuation).not.toHaveBeenCalled();
  });

  it('bounds native error details and preserves actionable recovery copy', () => {
    const outcome = run({
      target: null,
      volumeRoot: PORTABLE_ROOT,
      reason: 'volume-marker',
      failed: 'x'.repeat(20_000),
    });
    const copy = outcome.notifyFailure.mock.calls[0]?.[0];

    expect(copy?.content.length).toBeLessThan(2_000);
    expect(copy?.content).toContain(PORTABLE_ROOT);
    expect(copy?.content).toContain('writable');
    expect(copy?.content).toContain('free space');
    expect(copy?.content).toContain('close');
  });

  it.each([
    ['portable', {}],
    ['installed', { exePath: 'C:\\Program Files\\Compass\\Compass.exe' }],
    ['development', { isPackaged: false }],
    ['already redirected', { app: { getPath: () => PORTABLE_DATA, setPath: vi.fn() } }],
    [
      'relocated portable volume',
      {
        exePath: 'F:\\Compass\\Compass.exe',
        exists: (candidate: string) => candidate === 'F:\\openclaw-runtime-manifest.json',
      },
    ],
  ] as const)('continues a healthy %s launch exactly once', (_mode, overrides) => {
    const result = applyPortableAppData(input(overrides));
    const outcome = run(result);

    expect(result.failed).toBeUndefined();
    expect(outcome.continued).toBe(true);
    expect(outcome.events).toEqual(['continue']);
    expect(outcome.notifyFailure).not.toHaveBeenCalled();
    expect(outcome.exit).not.toHaveBeenCalled();
  });

  it('propagates healthy continuation errors without notifying or exiting', () => {
    const notifyFailure = vi.fn();
    const exit = vi.fn();

    expect(() =>
      continueAfterPortableAppData({ target: null, volumeRoot: null, reason: null }, { notifyFailure, exit }, () => {
        throw new Error('startup failed later');
      }),
    ).toThrow('startup failed later');
    expect(notifyFailure).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
