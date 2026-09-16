export interface InternalBetaUpdateApi {
  getAppVersion: () => Promise<string>;
  checkForUpdates: () => Promise<{
    hasUpdate: boolean;
    currentVersion: string;
    latestVersion: string;
    releaseUrl: string;
    releaseNotes?: string | null;
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
        if (result.hasUpdate) {
          setState({
            status: 'available',
            currentVersion: result.currentVersion,
            latestVersion: result.latestVersion,
            releaseUrl: result.releaseUrl,
            releaseNotes: result.releaseNotes ?? null,
          });
        } else {
          setState({ status: 'idle', currentVersion: result.currentVersion });
        }
      } catch (error) {
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
