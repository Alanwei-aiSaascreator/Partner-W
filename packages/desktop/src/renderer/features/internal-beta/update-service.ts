import { updateStatusFromCheck } from '@/lib/update-status';

export interface InternalBetaUpdateApi {
  getAppVersion: () => Promise<string>;
  checkForUpdates: () => Promise<{
    hasUpdate: boolean;
    currentVersion: string;
    latestVersion: string;
    releaseUrl: string;
    releaseNotes?: string | null;
    /** 主进程此刻的更新状态（自动下载可能已经跑完了）。见 lib/update-status.ts。 */
    state?: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
    /** 盘上运行（U 盘形态）：不自动下载、不安装，界面该提示"换包"。 */
    portable?: boolean;
  }>;
  downloadUpdate: () => Promise<{ ok: boolean; error?: string }>;
  installUpdate: () => Promise<{ ok: boolean; error?: string }>;
  onUpdateDownloadProgress: (callback: (progress: { percent: number }) => void) => () => void;
  onUpdateDownloaded: (callback: (info: { version: string }) => void) => () => void;
  onUpdateError: (callback: (error: { message: string }) => void) => () => void;
}

interface VersionSnapshot {
  currentVersion: string | null;
  latestVersion?: string;
  releaseUrl?: string;
  releaseNotes?: string | null;
}

export type InternalBetaUpdateState =
  | ({ status: 'idle' | 'checking' } & VersionSnapshot)
  | ({ status: 'available' } & Required<Pick<VersionSnapshot, 'currentVersion' | 'latestVersion' | 'releaseUrl'>> & {
        releaseNotes: string | null;
      })
  | ({ status: 'downloading'; percent: number } & VersionSnapshot)
  | ({ status: 'downloaded' | 'installing' } & VersionSnapshot & { latestVersion: string })
  | ({ status: 'error'; operation: 'check' | 'download' | 'install' | 'updater'; message: string } & VersionSnapshot);

export interface InternalBetaUpdateService {
  getState: () => InternalBetaUpdateState;
  subscribe: (listener: (state: InternalBetaUpdateState) => void) => () => void;
  loadVersion: () => Promise<void>;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  dispose: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createInternalBetaUpdateService(api: InternalBetaUpdateApi): InternalBetaUpdateService {
  let state: InternalBetaUpdateState = { status: 'idle', currentVersion: null };
  const listeners = new Set<(next: InternalBetaUpdateState) => void>();
  const setState = (next: InternalBetaUpdateState) => {
    state = next;
    listeners.forEach((listener) => listener(state));
  };
  const versionSnapshot = (): VersionSnapshot => ({
    currentVersion: state.currentVersion,
    latestVersion: state.latestVersion,
    releaseUrl: state.releaseUrl,
    releaseNotes: state.releaseNotes,
  });

  const unsubs = [
    api.onUpdateDownloadProgress((progress) => {
      setState({ status: 'downloading', ...versionSnapshot(), percent: Math.max(0, Math.min(100, progress.percent)) });
    }),
    api.onUpdateDownloaded((info) => {
      setState({ status: 'downloaded', ...versionSnapshot(), latestVersion: info.version });
    }),
    api.onUpdateError((error) => {
      setState({ status: 'error', ...versionSnapshot(), operation: 'updater', message: error.message });
    }),
  ];

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    loadVersion: async () => {
      try {
        const currentVersion = await api.getAppVersion();
        setState({ ...state, currentVersion });
      } catch (error) {
        setState({ status: 'error', ...versionSnapshot(), operation: 'check', message: errorMessage(error) });
      }
    },
    check: async () => {
      setState({ status: 'checking', ...versionSnapshot() });
      try {
        const result = await api.checkForUpdates();
        // ⚠️ 状态由主进程说了算：自动下载可能已经跑完 ⇒ 必须是 downloaded，
        //    不能一律显示成 available（见 lib/update-status.ts）。
        const status = updateStatusFromCheck(result);
        const snapshot = {
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion,
          releaseUrl: result.releaseUrl,
          releaseNotes: result.releaseNotes ?? null,
        };
        if (status === 'idle') {
          setState({ status: 'idle', currentVersion: result.currentVersion });
        } else if (status === 'downloading') {
          setState({ status: 'downloading', percent: 0, ...snapshot });
        } else if (status === 'downloaded') {
          setState({ status: 'downloaded', ...snapshot });
        } else {
          setState({ status: 'available', ...snapshot });
        }
      } catch (error) {
        // 检查失败不该弄丢"已经拿到手"的更新：主进程那边也**故意**保着
        // downloaded / downloading（见 auto-updater.ts 的 holdUpdate），界面要跟它一致。
        if (state.status === 'downloaded' || state.status === 'downloading') return;
        setState({ status: 'error', ...versionSnapshot(), operation: 'check', message: errorMessage(error) });
      }
    },
    download: async () => {
      setState({ status: 'downloading', ...versionSnapshot(), percent: 0 });
      try {
        const result = await api.downloadUpdate();
        if (!result.ok) {
          setState({
            status: 'error',
            ...versionSnapshot(),
            operation: 'download',
            message: result.error ?? 'Download failed',
          });
        }
      } catch (error) {
        setState({ status: 'error', ...versionSnapshot(), operation: 'download', message: errorMessage(error) });
      }
    },
    install: async () => {
      if (state.status !== 'downloaded') return;
      const snapshot = versionSnapshot();
      setState({ status: 'installing', ...snapshot, latestVersion: state.latestVersion });
      try {
        const result = await api.installUpdate();
        if (!result.ok) {
          setState({
            status: 'error',
            ...snapshot,
            operation: 'install',
            message: result.error ?? 'Install failed',
          });
        }
      } catch (error) {
        setState({ status: 'error', ...snapshot, operation: 'install', message: errorMessage(error) });
      }
    },
    dispose: () => {
      unsubs.forEach((unsubscribe) => unsubscribe());
      listeners.clear();
    },
  };
}
