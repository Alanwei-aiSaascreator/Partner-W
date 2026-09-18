import { describe, expect, it, vi } from 'vitest';
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
