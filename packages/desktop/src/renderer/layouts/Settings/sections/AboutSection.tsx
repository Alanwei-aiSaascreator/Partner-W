import { useState, useEffect, useCallback, useRef } from 'react';
import { Globe, Headset, RefreshCw, Loader2, Download, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import SettingRow from '@/components/semantic/SettingRow';
import SettingGroup from '@/components/semantic/SettingGroup';
import InlineNotice from '@/components/semantic/InlineNotice';
import SegmentedControl from '../components/SegmentedControl';
import { useUiStore } from '@/stores/uiStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { describeUpdateError } from '@/features/internal-beta/update-errors';
import { updateStatusFromCheck } from '@/lib/update-status';

const linkClass = cn(
  'type-label flex h-9 items-center justify-center gap-2 rounded-lg px-4 transition-colors',
  'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border border-[var(--border)]',
  'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] active:scale-[0.98]',
);

type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
type UpdateChannel = 'stable' | 'beta';

interface VersionInfo {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  releaseNotes?: string | null;
}

const DEV_MODE_TAP_COUNT = 5;
const DEV_MODE_TAP_WINDOW_MS = 3000;

export default function AboutSection() {
  const { t } = useTranslation();
  const [updateState, setUpdateState] = useState<UpdateState>('idle');
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [deviceId, setDeviceId] = useState<string | null>(null);
  /** 盘上运行（U 盘形态）：不自动下载、不安装，改为提示"换包"。 */
  const [portable, setPortable] = useState(false);

  const devMode = useUiStore((s) => s.devMode);
  const setDevMode = useUiStore((s) => s.setDevMode);
  const updateChannel = useSettingsStore((s) => (s.settings?.updateChannel ?? 'stable') as UpdateChannel);
  const loadSettings = useSettingsStore((s) => s.load);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const tapCountRef = useRef(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!settingsLoaded) loadSettings().catch(() => {});
  }, [settingsLoaded, loadSettings]);

  const handleVersionClick = useCallback(() => {
    if (devMode) return;
    tapCountRef.current += 1;
    clearTimeout(tapTimerRef.current);
    const remaining = DEV_MODE_TAP_COUNT - tapCountRef.current;
    if (remaining > 0 && remaining <= 3) {
      toast.dismiss('dev-mode-hint');
      toast(t('settings.devModeSteps', { count: remaining }), { id: 'dev-mode-hint', duration: 2000 });
    }
    if (tapCountRef.current >= DEV_MODE_TAP_COUNT) {
      tapCountRef.current = 0;
      toast.dismiss('dev-mode-hint');
      setDevMode(true);
      toast.success(t('settings.devModeEnabled'));
      return;
    }
    tapTimerRef.current = setTimeout(() => {
      tapCountRef.current = 0;
    }, DEV_MODE_TAP_WINDOW_MS);
  }, [devMode, setDevMode, t]);

  const handleDisableDevMode = useCallback(() => {
    setDevMode(false);
    toast.success(t('settings.devModeDisabled'));
  }, [setDevMode, t]);

  useEffect(() => {
    window.clawwork
      .getAppVersion()
      .then(setCurrentVersion)
      .catch((err: unknown) => {
        console.error('[AboutSection] getAppVersion failed:', err);
      });

    window.clawwork
      .getDeviceId()
      .then(setDeviceId)
      .catch((err: unknown) => {
        console.error('[AboutSection] getDeviceId failed:', err);
      });

    const unsubs: (() => void)[] = [];

    unsubs.push(
      window.clawwork.onUpdateDownloadProgress((progress) => {
        setUpdateState('downloading');
        setDownloadPercent(progress.percent);
      }),
    );

    unsubs.push(
      window.clawwork.onUpdateDownloaded((info) => {
        setUpdateState('downloaded');
        setVersionInfo((prev) => (prev ? { ...prev, latestVersion: info.version } : prev));
      }),
    );

    unsubs.push(
      window.clawwork.onUpdateError((err) => {
        setUpdateState('error');
        // electron-updater 的原文是英文堆栈，翻译层见 update-errors.ts
        setErrorMessage(describeUpdateError(err.message, 'updater'));
      }),
    );

    window.clawwork
      .checkForUpdates()
      .then((result) => {
        setVersionInfo({
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion,
          releaseUrl: result.releaseUrl,
          releaseNotes: result.releaseNotes,
        });
        setCurrentVersion(result.currentVersion);
        setPortable(result.portable);
        // 状态照主进程说的显示：它可能**已经自动下载完了**（见 lib/update-status.ts）
        setUpdateState(updateStatusFromCheck(result));
      })
      .catch((err: unknown) => {
        const raw = err instanceof Error ? err.message : String(err);
        // ⚠️ 顺序有意为之：**先**把错误摆到界面上，**再**写调试日志。
        //    反过来（日志在前）时，只要 `reportDebugEvent` 不可用（老版本 preload、
        //    测试桩、上报本身抛错），catch 会自己抛出去 ⇒ 错误状态永远设不上，
        //    界面静默 —— 2026-09-17 我就是这么被它骗了一轮。
        //    更新服务没部署时每次打开设置都会走这里，静默等于"关于页坏了"。
        // 但**已经拿到手**的更新不能被一次失败的检查弄没：主进程那边保的是
        // downloaded 与 downloading 两个（见 auto-updater.ts 的 holdUpdate），
        // 界面照抄 —— 否则下载中点一次检查失败，进度条和「取消下载」会一起消失。
        setUpdateState((prev) => (prev === 'downloaded' || prev === 'downloading' ? prev : 'error'));
        setErrorMessage(describeUpdateError(raw, 'check'));
        window.clawwork.reportDebugEvent?.({
          domain: 'renderer',
          event: 'about.update-check.mount-failed',
          data: { error: raw },
        });
      });

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, []);

  const handleCheckForUpdates = useCallback(async () => {
    setUpdateState('checking');
    setErrorMessage('');
    try {
      const result = await window.clawwork.checkForUpdates();
      setVersionInfo({
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
        releaseUrl: result.releaseUrl,
        releaseNotes: result.releaseNotes,
      });
      setCurrentVersion(result.currentVersion);
      setPortable(result.portable);
      const status = updateStatusFromCheck(result);
      setUpdateState(status);
      if (status === 'idle') toast.success(t('settings.alreadyLatest'));
    } catch (err: unknown) {
      setUpdateState('error');
      setErrorMessage(describeUpdateError(err instanceof Error ? err.message : String(err), 'check'));
    }
  }, [t]);

  const handleDownload = useCallback(async () => {
    setUpdateState('downloading');
    setDownloadPercent(0);
    const result = await window.clawwork.downloadUpdate();
    if (!result.ok && result.error !== 'cancelled') {
      setUpdateState('error');
      setErrorMessage(describeUpdateError(result.error, 'download'));
    }
  }, []);

  const handleCancelDownload = useCallback(async () => {
    const result = await window.clawwork.cancelUpdateDownload();
    if (result.ok) {
      setUpdateState('available');
      setDownloadPercent(0);
    }
  }, []);

  const handleInstall = useCallback(async () => {
    // 成功的话应用会直接退出并重启，走不到下一句；失败必须说出来 ——
    // 原来这里把返回值丢掉，点了没反应用户只会以为"按钮坏了"。
    const result = await window.clawwork.installUpdate();
    if (!result.ok) {
      setUpdateState('error');
      setErrorMessage(describeUpdateError(result.error, 'install'));
    }
  }, []);

  const handleChannelChange = useCallback(
    async (next: UpdateChannel) => {
      if (next === updateChannel) return;
      await updateSettings({ updateChannel: next });
      handleCheckForUpdates();
    },
    [updateChannel, updateSettings, handleCheckForUpdates],
  );

  const isChecking = updateState === 'checking';

  return (
    <div>
      <h3 className="type-section-title mb-4 text-[var(--text-primary)]">{t('settings.about')}</h3>
      <SettingGroup>
        <div>
          <SettingRow label={t('settings.version')}>
            <span
              className="type-mono-data text-[var(--text-primary)] cursor-default select-none"
              onClick={handleVersionClick}
            >
              {currentVersion ? `v${currentVersion}` : '—'}
            </span>
          </SettingRow>
          <SettingRow label={t('settings.updateChannel')} description={t('settings.updateChannelHint')}>
            <SegmentedControl<UpdateChannel>
              value={updateChannel}
              onChange={handleChannelChange}
              options={[
                { value: 'stable', label: t('settings.channelStable') },
                { value: 'beta', label: t('settings.channelBeta') },
              ]}
              layoutId="update-channel"
              ariaLabel={t('settings.updateChannel')}
            />
          </SettingRow>
          {devMode && (
            <SettingRow label={t('settings.devMode')}>
              <Button variant="outline" size="sm" onClick={handleDisableDevMode}>
                {t('settings.devModeDisable')}
              </Button>
            </SettingRow>
          )}
          {devMode && deviceId && (
            <SettingRow label={t('settings.deviceId')}>
              <span className="type-mono-data select-all text-[var(--text-secondary)]">{deviceId}</span>
            </SettingRow>
          )}
        </div>

        {updateState === 'available' && versionInfo && (
          <div className="px-5 py-4">
            <InlineNotice tone="info">
              <div>
                <p className="type-label mb-2 text-[var(--text-primary)]">
                  {t('settings.newVersionAvailable', { version: versionInfo.latestVersion })}
                </p>
                {portable ? (
                  // U 盘版：主进程既不下载也不安装（装到本机只会多出一份副本，
                  // 盘上那份还是旧的）⇒ 这里给一句能照做的指引，而不是一个点了没用的按钮。
                  <p className="type-support text-[var(--text-muted)]">{t('settings.portableUpdateHint')}</p>
                ) : (
                  <div className="flex items-center gap-2">
                    <Button variant="default" size="sm" onClick={handleDownload} className="gap-1.5">
                      <Download size={14} />
                      {t('settings.downloadUpdate')}
                    </Button>
                    {versionInfo.releaseUrl && (
                      <a
                        href={versionInfo.releaseUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="type-support text-[var(--text-muted)] hover:text-[var(--text-secondary)] underline"
                      >
                        {t('settings.downloadManually')}
                      </a>
                    )}
                  </div>
                )}
              </div>
            </InlineNotice>
          </div>
        )}

        {updateState === 'downloading' && (
          <div className="px-5 py-4">
            <div className="rounded-lg px-4 py-3 bg-[var(--bg-tertiary)] border border-[var(--border)]">
              <div className="flex items-center justify-between gap-3 mb-2">
                <p className="type-body text-[var(--text-secondary)]">
                  {t('settings.downloadProgress', { percent: downloadPercent })}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCancelDownload}
                  className="gap-1.5 h-7 px-2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X size={14} />
                  {t('settings.cancelDownload')}
                </Button>
              </div>
              <div className="h-2 rounded-full bg-[var(--bg-hover)] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
                  style={{ width: `${downloadPercent}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {updateState === 'downloaded' && (
          <div className="px-5 py-4">
            <InlineNotice tone="info">
              <div>
                <p className="type-label mb-2 text-[var(--text-primary)]">
                  {t('settings.newVersionAvailable', { version: versionInfo?.latestVersion })}
                </p>
                <Button variant="default" size="sm" onClick={handleInstall} className="gap-1.5">
                  <RotateCcw size={14} />
                  {t('settings.readyToInstall')}
                </Button>
              </div>
            </InlineNotice>
          </div>
        )}

        {updateState === 'error' && (
          <div className="px-5 py-4">
            <InlineNotice
              tone="error"
              action={
                <Button variant="outline" size="sm" onClick={handleCheckForUpdates} className="gap-1.5">
                  <RefreshCw size={14} />
                  {t('settings.checkForUpdates')}
                </Button>
              }
            >
              {t('settings.updateError', { message: errorMessage })}
            </InlineNotice>
          </div>
        )}

        <div className="px-5 py-4 space-y-2">
          {/* 便携形态的"有新版本"卡片上没有下载按钮，得留一个重新检查的入口；
              其余状态各自有按钮（下载/安装/重试），不用重复给。 */}
          {(updateState === 'idle' || updateState === 'checking' || (portable && updateState === 'available')) && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCheckForUpdates}
              disabled={isChecking}
              className="titlebar-no-drag gap-1.5 w-full justify-center"
            >
              {isChecking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {t('settings.checkForUpdates')}
            </Button>
          )}
          <a href="https://www.rongyinghudong.com" target="_blank" rel="noreferrer" className={linkClass}>
            <Globe size={14} />
            {t('settings.companySite')}
          </a>
          <a
            href="https://www.rongyinghudong.com/cooperation.html#contact"
            target="_blank"
            rel="noreferrer"
            className={linkClass}
          >
            <Headset size={14} />
            {t('settings.contactSupport')}
          </a>
        </div>
      </SettingGroup>
    </div>
  );
}
