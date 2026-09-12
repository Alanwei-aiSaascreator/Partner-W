import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ⚠️ 用 `join` 拼，**不要写字面量 `/tmp/...`**：`config.ts` 那边是 `join(app.getPath('userData'), …)`，
//    在 Windows 上得到的是反斜杠路径，字面量只在 POSIX 上相等。
//    这四条断言此前在 Windows 上**全红**，且与它们本该保护的改动无关 ——
//    红着的安全网等于没有安全网（见 util/json-file.ts 的抽取）。
const userDataPath = join('/tmp', 'clawwork-user-data');
const configPath = join(userDataPath, 'clawwork-config.json');
const tmpPath = `${configPath}.tmp`;

const fsMock = vi.hoisted(() => ({
  closeSync: vi.fn(),
  existsSync: vi.fn(),
  fsyncSync: vi.fn(),
  openSync: vi.fn(),
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userDataPath),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    closeSync: fsMock.closeSync,
    existsSync: fsMock.existsSync,
    fsyncSync: fsMock.fsyncSync,
    openSync: fsMock.openSync,
    readFileSync: fsMock.readFileSync,
    renameSync: fsMock.renameSync,
    unlinkSync: fsMock.unlinkSync,
    writeFileSync: fsMock.writeFileSync,
  };
});

async function loadConfigModule() {
  return import('../src/main/workspace/config.js');
}

describe('workspace config persistence', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fsMock.existsSync.mockReturnValue(true);
    fsMock.openSync.mockImplementation((path: unknown) => (path === tmpPath ? 10 : 11));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes config through a temp file and atomic rename', async () => {
    const { writeConfig } = await loadConfigModule();

    writeConfig({ workspacePath: '/workspace', gateways: [] });

    expect(fsMock.openSync).toHaveBeenCalledWith(tmpPath, 'w', 0o600);
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      10,
      JSON.stringify({ workspacePath: '/workspace', gateways: [] }, null, 2),
      { encoding: 'utf-8' },
    );
    expect(fsMock.fsyncSync).toHaveBeenCalledWith(10);
    expect(fsMock.closeSync).toHaveBeenCalledWith(10);
    expect(fsMock.renameSync).toHaveBeenCalledWith(tmpPath, configPath);
    if (process.platform === 'win32') {
      // Windows 上目录 fsync 必定 EPERM（2026-09-13 实测 node 26.3.1），
      // 所以 `syncDirectory` 刻意**不尝试** —— 见 util/json-file.ts。
      expect(fsMock.openSync).not.toHaveBeenCalledWith(userDataPath, 'r');
    } else {
      expect(fsMock.openSync).toHaveBeenCalledWith(userDataPath, 'r');
      expect(fsMock.fsyncSync).toHaveBeenCalledWith(11);
      expect(fsMock.closeSync).toHaveBeenCalledWith(11);
    }
  });

  it('cleans up temp config file when atomic rename fails', async () => {
    const renameError = new Error('rename failed');
    fsMock.renameSync.mockImplementationOnce(() => {
      throw renameError;
    });
    fsMock.existsSync.mockImplementation((path: unknown) => path === tmpPath);
    const { writeConfig } = await loadConfigModule();

    expect(() => writeConfig({ workspacePath: '/workspace', gateways: [] })).toThrow(renameError);
    expect(fsMock.unlinkSync).toHaveBeenCalledWith(tmpPath);
  });

  it('does not rename when temp write fails', async () => {
    const writeError = new Error('disk full');
    fsMock.writeFileSync.mockImplementationOnce(() => {
      throw writeError;
    });
    const { writeConfig } = await loadConfigModule();

    expect(() => writeConfig({ workspacePath: '/workspace', gateways: [] })).toThrow(writeError);
    expect(fsMock.renameSync).not.toHaveBeenCalled();
    expect(fsMock.unlinkSync).toHaveBeenCalledWith(tmpPath);
  });

  it('backs up malformed JSON config without running migration', async () => {
    fsMock.readFileSync.mockReturnValue('{bad json');
    const { readConfig } = await loadConfigModule();

    expect(readConfig()).toBeNull();
    expect(fsMock.renameSync).toHaveBeenCalledTimes(1);
    expect(fsMock.renameSync.mock.calls[0][0]).toBe(configPath);
    expect(fsMock.renameSync.mock.calls[0][1]).toMatch(/clawwork-config\.json\.corrupted-/);
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('does not move config when migration write fails', async () => {
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({
        workspacePath: '/workspace',
        gatewayUrl: 'ws://127.0.0.1:18789',
        bootstrapToken: 'pairing-code',
      }),
    );
    fsMock.writeFileSync.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const { readConfig } = await loadConfigModule();

    expect(readConfig()).toBeNull();
    expect(fsMock.renameSync).not.toHaveBeenCalled();
  });
});
