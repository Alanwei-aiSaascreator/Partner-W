import { describe, expect, it, vi } from 'vitest';
import type { PortableUpdatePublicState } from '@clawwork/shared';
import {
  createInternalBetaUpdateService,
  type InternalBetaUpdateApi,
} from '../src/renderer/features/internal-beta/update-service';

function createApi(overrides: Partial<InternalBetaUpdateApi> = {}) {
  let progress: ((value: { percent: number }) => void) | null = null;
  let downloaded: ((value: { version: string }) => void) | null = null;
  let updateError: ((value: { message: string }) => void) | null = null;
  const api: InternalBetaUpdateApi = {
    getAppVersion: vi.fn().mockResolvedValue('1.0.0'),
    checkForUpdates: vi.fn().mockResolvedValue({
      hasUpdate: false,
      currentVersion: '1.0.0',
      latestVersion: '1.0.0',
      releaseUrl: '',
      releaseNotes: null,
    }),
    downloadUpdate: vi.fn().mockResolvedValue({ ok: true }),
    installUpdate: vi.fn().mockResolvedValue({ ok: true }),
    onUpdateDownloadProgress: vi.fn((callback) => {
      progress = callback;
      return vi.fn();
    }),
    onUpdateDownloaded: vi.fn((callback) => {
      downloaded = callback;
      return vi.fn();
    }),
    onUpdateError: vi.fn((callback) => {
      updateError = callback;
      return vi.fn();
    }),
    ...overrides,
  };
  return {
    api,
    emitProgress: (percent: number) => progress?.({ percent }),
    emitDownloaded: (version: string) => downloaded?.({ version }),
    emitError: (message: string) => updateError?.({ message }),
  };
}

describe('internal beta update service', () => {
  it('reports no update and available update truthfully', async () => {
    const current = createApi();
    const currentService = createInternalBetaUpdateService(current.api);
    await currentService.check();
    expect(currentService.getState()).toMatchObject({ status: 'idle', currentVersion: '1.0.0' });

    const available = createApi({
      checkForUpdates: vi.fn().mockResolvedValue({
        hasUpdate: true,
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        releaseUrl: 'https://example.com/release',
        releaseNotes: 'Fixes',
      }),
    });
    const availableService = createInternalBetaUpdateService(available.api);
    await availableService.check();
    expect(availableService.getState()).toMatchObject({
      status: 'available',
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
    });
  });

  it('keeps check and download failures as actionable error states', async () => {
    const failedCheck = createApi({ checkForUpdates: vi.fn().mockRejectedValue(new Error('offline')) });
    const checkService = createInternalBetaUpdateService(failedCheck.api);
    await checkService.check();
    expect(checkService.getState()).toMatchObject({ status: 'error', operation: 'check', message: 'offline' });

    const failedDownload = createApi({ downloadUpdate: vi.fn().mockResolvedValue({ ok: false, error: 'disk full' }) });
    const downloadService = createInternalBetaUpdateService(failedDownload.api);
    await downloadService.check();
    await downloadService.download();
    expect(downloadService.getState()).toMatchObject({
      status: 'error',
      operation: 'download',
      message: 'disk full',
    });
  });

  it('tracks download events and requests installation only after download', async () => {
    const mock = createApi({
      checkForUpdates: vi.fn().mockResolvedValue({
        hasUpdate: true,
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        releaseUrl: '',
        releaseNotes: null,
      }),
    });
    const service = createInternalBetaUpdateService(mock.api);
    await service.check();
    await service.download();
    mock.emitProgress(42);
    expect(service.getState()).toMatchObject({ status: 'downloading', percent: 42 });
    mock.emitDownloaded('1.1.0');
    expect(service.getState()).toMatchObject({ status: 'downloaded', latestVersion: '1.1.0' });

    await service.install();
    expect(mock.api.installUpdate).toHaveBeenCalledTimes(1);
    expect(service.getState()).toMatchObject({ status: 'installing' });
  });

  it('⭐ 下载好之后再检查一次：状态保持 downloaded（自动下载已完成时不能显示成"可下载"）', async () => {
    const mock = createApi({
      checkForUpdates: vi.fn().mockResolvedValue({
        hasUpdate: true,
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        releaseUrl: '',
        releaseNotes: null,
        state: 'downloaded',
        portable: false,
      }),
    });
    const service = createInternalBetaUpdateService(mock.api);

    await service.check();

    expect(service.getState()).toMatchObject({ status: 'downloaded', latestVersion: '1.1.0' });
  });

  it('subscribes once, forwards updater errors, and releases listeners', () => {
    const mock = createApi();
    const service = createInternalBetaUpdateService(mock.api);
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    mock.emitError('signature invalid');
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'error', operation: 'updater', message: 'signature invalid' }),
    );
    unsubscribe();
    service.dispose();
    expect(mock.api.onUpdateDownloadProgress).toHaveBeenCalledTimes(1);
    expect(mock.api.onUpdateDownloaded).toHaveBeenCalledTimes(1);
    expect(mock.api.onUpdateError).toHaveBeenCalledTimes(1);
  });
});

describe('盘上运行：服务的便携相位', () => {
  function portableApi() {
    let listener: ((state: PortableUpdatePublicState) => void) | null = null;
    const unsubscribe = vi.fn();
    let current: PortableUpdatePublicState | null = null;
    const api: InternalBetaUpdateApi = {
      getAppVersion: vi.fn().mockResolvedValue('0.0.25'),
      checkForUpdates: vi.fn().mockResolvedValue({
        hasUpdate: false,
        currentVersion: '0.0.25',
        latestVersion: '0.0.25',
        releaseUrl: '',
        releaseNotes: null,
      }),
      downloadUpdate: vi.fn().mockResolvedValue({ ok: true }),
      installUpdate: vi.fn().mockResolvedValue({ ok: true }),
      onUpdateDownloadProgress: vi.fn(() => vi.fn()),
      onUpdateDownloaded: vi.fn(() => vi.fn()),
      onUpdateError: vi.fn(() => vi.fn()),
      getUpdateState: vi.fn(async () => current),
      onUpdateStateChanged: vi.fn((callback) => {
        listener = callback;
        return unsubscribe;
      }),
    };
    return {
      api,
      unsubscribe,
      emit: (state: PortableUpdatePublicState) => {
        current = state;
        listener?.(state);
      },
    };
  }

  it('loadVersion 会把主进程那边的相位取回来', async () => {
    const { api, emit } = portableApi();
    const service = createInternalBetaUpdateService(api);
    emit({ phase: 'preparing' as never, currentVersion: '0.0.25', updatedAt: 1 });
    emit({ phase: 'ready', currentVersion: '0.0.25', targetVersion: '0.0.26', updatedAt: 2 });

    await service.loadVersion();

    expect(service.getState().portable).toMatchObject({ phase: 'ready', targetVersion: '0.0.26' });
  });

  it('主进程后来改相位时，服务跟着改（订阅而不是轮询）', () => {
    const { api, emit } = portableApi();
    const service = createInternalBetaUpdateService(api);
    const seen: unknown[] = [];
    service.subscribe((state) => seen.push(state.portable));

    emit({ phase: 'downloading', currentVersion: '0.0.25', transferred: 1, total: 2, updatedAt: 3 });

    expect(service.getState().portable).toMatchObject({ phase: 'downloading', transferred: 1, total: 2 });
    expect(seen.length).toBeGreaterThan(0);
  });

  it('dispose 会把便携相位的订阅也退掉', () => {
    const { api, unsubscribe } = portableApi();
    const service = createInternalBetaUpdateService(api);

    service.dispose();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('没有这条链的调用方（已安装路径）不会因为缺方法而炸', () => {
    const { api } = portableApi();
    const withoutPortable: InternalBetaUpdateApi = { ...api };
    delete withoutPortable.getUpdateState;
    delete withoutPortable.onUpdateStateChanged;

    const service = createInternalBetaUpdateService(withoutPortable);

    expect(service.getState().portable).toBeNull();
    expect(() => service.dispose()).not.toThrow();
  });
});
