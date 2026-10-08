import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { continueAfterPortableAppData } from '../src/main/runtime/portable-startup-gate';
import type { PortableAppDataApplyResult } from '../src/main/runtime/portable-app-data';

function runStartup(result: PortableAppDataApplyResult) {
  const source =
    process.env.PORTABLE_STARTUP_INDEX_SOURCE === '1'
      ? execFileSync('git', ['show', ':packages/desktop/src/main/index.ts'], { encoding: 'utf8' })
      : readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const start = source.indexOf("const localUserDataDir = app.getPath('userData');");
  const end = source.indexOf("app.on('window-all-closed',");
  if (start < 0 || end <= start) throw new Error('Missing production startup boundary');
  const code = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  const exit = vi.fn();
  const notify = vi.fn();
  const lock = vi.fn(() => true);
  const owner = vi.fn();
  const cache = vi.fn(() => 'isolated-cache');
  const whenReady = vi.fn(() => new Promise<void>(() => {}));
  runInNewContext(code, {
    app: {
      getPath: () => 'isolated-user-data',
      getVersion: () => '0.0.0',
      requestSingleInstanceLock: lock,
      whenReady,
      on: vi.fn(),
      exit,
      isPackaged: true,
    },
    dialog: { showErrorBox: notify },
    process: { execPath: 'E:\\App\\App.exe', env: { SystemDrive: 'C:' }, resourcesPath: 'isolated-resources' },
    continueAfterPortableAppData,
    applyPortableAppData: () => result,
    existsSync: () => false,
    removableDrives: () => [],
    runtimeCacheScopeDir: cache,
    recordInstanceOwner: owner,
    readPortableHealthEnvironment: () => ({}),
    createPortableHealthCoordinator: () => ({}),
    expectedProgramPathFor: () => undefined,
    dirname: () => 'isolated-program',
    // ⚠️ 部署进度的看门狗在"抢到锁"的分支里**定义时就建**（`createDeployStallWatch`）：
    //    这个替身只回答"存在" —— vm 里不跑定时器，也不关心部署进度。
    createDeployStallWatch: () => ({ touch: () => {}, cancel: () => {} }),
  });
  return { exit, notify, lock, owner, cache, whenReady };
}

describe('production main portable startup gate', () => {
  it.each(['EPERM', ''])('does not start host storage after preparation failure %j', (failed) => {
    const result = runStartup({ target: null, volumeRoot: 'E:\\', reason: 'volume-marker', failed });
    expect(result.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(result.notify).toHaveBeenCalledOnce();
    expect(result.lock).not.toHaveBeenCalled();
    expect(result.owner).not.toHaveBeenCalled();
    expect(result.cache).not.toHaveBeenCalled();
    expect(result.whenReady).not.toHaveBeenCalled();
  });

  it.each([
    { target: 'isolated-portable', volumeRoot: 'E:\\', reason: 'volume-marker' as const },
    { target: null, volumeRoot: 'C:\\', reason: null },
  ])('preserves healthy startup for %j', (portable) => {
    const result = runStartup(portable);
    expect(result.exit).not.toHaveBeenCalled();
    expect(result.notify).not.toHaveBeenCalled();
    expect(result.cache).toHaveBeenCalledOnce();
    expect(result.lock).toHaveBeenCalledOnce();
    expect(result.owner).toHaveBeenCalledOnce();
    expect(result.whenReady).toHaveBeenCalledOnce();
  });
});
