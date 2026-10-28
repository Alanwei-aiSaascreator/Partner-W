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
import { useMessageStore } from '@/stores/messageStore';
import { useDeliveryActivityStore } from '@/stores/deliveryActivityStore';
import { describeUpdateErrorFromState, type UpdateOperation } from '@/features/internal-beta/update-errors';
import { installAllowedForStatus, portablePhaseToUiStatus, updateStatusFromCheck } from '@/lib/update-status';
import type { PortableUpdatePublicState } from '@clawwork/shared';

const linkClass = cn(
  'type-label flex h-9 items-center justify-center gap-2 rounded-lg px-4 transition-colors',
  'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border border-[var(--border)]',
  'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] active:scale-[0.98]',
);

type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'
  | 'preparing'
  | 'ready'
  | 'applying'
  | 'committed'
  | 'rolled-back';
type UpdateChannel = 'stable' | 'beta';

interface VersionInfo {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  releaseNotes?: string | null;
}

const DEV_MODE_TAP_COUNT = 5;
const DEV_MODE_TAP_WINDOW_MS = 3000;

/** `ActiveTurn` 的**结构**视图（只需要这几个字段；不 import core 的类型，避免测试桩耦合）。 */
interface ActiveTurnLike {
  finalized?: boolean;
  streamingText?: string;
  streamingThinking?: string;
  toolCalls?: unknown[];
}

/**
 * 「应用现在忙吗」——**真实任务/run 活动状态**（2026-10-11 升级补齐）。
 *
 * 判据与 core 的 `deriveSessionActivity` 同一套，只是从全局视角看：
 *   · 有会话在处理（`processingBySession`：网关已接单，还没落地）；
 *   · 有会话正在流正文/思考，或还有工具调用没走完（未被 finalize 收口）；
 *   · 有文件交付操作在途（登记/落位/重放那一串，见 deliveryActivityStore）。
 *
 * ⚠️ **不把 ready/downloaded 当空闲证明**：更新包准备好与否，和"现在能不能退出应用"
 *    是两件事 —— 装好了包的同时用户完全可能正在生成 PPT。
 * ⚠️ 这里**不**区分"是不是当前正看的那个任务"：后台调用（团队开会、技能审核）同样在途，
 *    退出应用会把它们连同账目一起打断 —— 忙就是忙。
 */
export function isAppBusyFromActivity(input: {
  processingBySession: ReadonlySet<string>;
  activeTurnBySession: Readonly<Record<string, ActiveTurnLike | undefined>>;
  activeDeliveryCount: number;
}): boolean {
  if (input.processingBySession.size > 0) return true;
  if (input.activeDeliveryCount > 0) return true;
  return Object.values(input.activeTurnBySession).some(
    (turn) =>
      Boolean(turn) &&
      turn?.finalized !== true &&
      Boolean(
        turn?.streamingText || turn?.streamingThinking || (Array.isArray(turn?.toolCalls) && turn.toolCalls.length > 0),
      ),
  );
}

/**
 * 「现在能不能真的去换目录/退出应用」。
 *
 * ⚠️ 单独抽成纯函数（同 `installAllowedForStatus` 的理由）：按钮灰掉只是**观感**，
 *    真正的许可必须单独成立 —— 双击、快捷键、程序化触发都不该绕过它。
 *    盘上形态还有两道同源的闸：主进程 IPC（`app:install-update`，读渲染层推来的
 *    真实 run 状态）与便携服务的 `requestRestart` 边界（启动启动器/退出之前）。
 */
export function canStartInstallNow(status: UpdateState, busy: boolean): boolean {
  return installAllowedForStatus(status) && !busy;
}

/**
 * @param hideHeading 在**弹窗**里复用它时隐藏页面级标题（`settings.about`）——
 *   弹窗自己已经有 `DialogTitle`，否则同一句话会出现两遍（2026-10-19）。
 */
export default function AboutSection({ hideHeading = false }: { hideHeading?: boolean } = {}) {
  const { t } = useTranslation();
  const [updateState, setUpdateState] = useState<UpdateState>('idle');
  // 盘上运行时，主进程的签名清单相位是唯一的真相源；已安装路径没有这条链。
  const [portablePhase, setPortablePhase] = useState<PortableUpdatePublicState | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [downloadPercent, setDownloadPercent] = useState(0);
  /**
   * 存**原始报错 + 操作**，不存翻译好的句子。
   *
   * 为什么（2026-09-23）：盘上形态的失败原因与"还差多少 GiB"都在主进程的公开状态里，
   * 翻译必须等渲染时拿得到 `portablePhase` 才算得对。以前这里存的是翻译结果 ⇒
   * 空间不足时界面上只有「更新失败：」后面**空的**（`errorMessage` 那条链压根没被设过）。
   */
  const [errorInfo, setErrorInfo] = useState<{ raw: string; operation: UpdateOperation } | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  /** 盘上运行（U 盘形态）：不自动下载、不安装，改为提示"换包"。 */
  const [portable, setPortable] = useState(false);

  const devMode = useUiStore((s) => s.devMode);
  const setDevMode = useUiStore((s) => s.setDevMode);
  /**
   * ⭐ 忙态（真实任务/run 活动）：生成/写文件期间**不许**退出应用或换目录。
   *
   * 只挡「安装」这一个动作 —— 检查更新、下载并准备**照常可用**（盘上那条链在后台
   * 把包下好、验好、解压好，缓存成 ready 候选，等用户手头的事了了再重启）。
   */
  const processingBySession = useMessageStore((s) => s.processingBySession);
  const activeTurnBySession = useMessageStore((s) => s.activeTurnBySession);
  const activeDeliveryCount = useDeliveryActivityStore((s) => s.active.length);
  const busy = isAppBusyFromActivity({ processingBySession, activeTurnBySession, activeDeliveryCount });
  const updateChannel = useSettingsStore((s) => (s.settings?.updateChannel ?? 'stable') as UpdateChannel);
  const loadSettings = useSettingsStore((s) => s.load);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const tapCountRef = useRef(0);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  /**
   * 当前显示状态的一份**回调可读**副本。
   *
   * ⚠️ 为什么不能只靠渲染条件：渲染条件决定"按钮在不在"，而命令的**许可**必须单独成立 ——
   *    「立即重启更新」一旦被点到就把换目录交给启动器，那是**有副作用**的动作；
   *    双击、或被别处状态驱动着触到同一个 handler，都不该真的发出去。
   */
  const displayStateRef = useRef<UpdateState>('idle');
  /** 同上：忙态也要在**命令许可**那一层读得到最新值（回调不是每帧重建）。 */
  const busyRef = useRef(busy);
  busyRef.current = busy;

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
      window.clawwork.onUpdateStateChanged?.((state) => {
        setPortablePhase(state);
      }) ?? (() => {}),
    );
    void window.clawwork
      .getUpdateState?.()
      .then((state) => {
        if (state) setPortablePhase(state);
      })
      .catch(() => {});

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
        setErrorInfo({ raw: err.message, operation: 'updater' });
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
        setErrorInfo({ raw, operation: 'check' });
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
    setErrorInfo(null);
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
      setErrorInfo({ raw: err instanceof Error ? err.message : String(err), operation: 'check' });
    }
  }, [t]);

  const handleDownload = useCallback(async () => {
    // ⚠️ 双击保护：下载/准备期间再点一次，不该再发一条命令。
    //    （盘上形态的入口按钮在这个相位本来就不渲染，但 handler 不能靠渲染兜底。）
    if (displayStateRef.current === 'downloading' || displayStateRef.current === 'preparing') return;
    setUpdateState('downloading');
    setDownloadPercent(0);
    const result = await window.clawwork.downloadUpdate();
    if (!result.ok && result.error !== 'cancelled') {
      setUpdateState('error');
      setErrorInfo({ raw: result.error ?? '', operation: 'download' });
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
    // ⚠️ **只有"已经准备好"才允许换目录**：盘上形态要等 `ready`（下载、验签、解压、
    //    逐文件核对全过），装机版要等 `downloaded`。其余相位（含一切失败相位）
    //    一律**不发出**这条命令 —— 渲染条件不等于命令许可，双击/程序化触发都在这道闸下。
    // ⚠️ 2026-10-11 升级补齐：**忙态是第二道判据**。生成/写文件期间"换目录 + 退出应用"
    //    会打断真实任务（还会留下未结算的在途调用）—— 按钮灰掉只是观感，
    //    命令许可必须在这里单独成立。
    if (!canStartInstallNow(displayStateRef.current, busyRef.current)) {
      if (installAllowedForStatus(displayStateRef.current) && busyRef.current) {
        toast(t('settings.portableUpdate.busyHint'));
      }
      return;
    }
    // 成功的话应用会直接退出并重启，走不到下一句；失败必须说出来 ——
    // 原来这里把返回值丢掉，点了没反应用户只会以为"按钮坏了"。
    const result = await window.clawwork.installUpdate();
    if (!result.ok) {
      // 主进程在**边界上**又判了一次忙（渲染层这一刻看到的可能已经过期）：
      // 保留 ready 候选、说清原因，**不落错误态** —— 任务结束后用户再点一次即可。
      if (result.error === 'app-busy') {
        toast(t('settings.portableUpdate.busyHint'));
        return;
      }
      setUpdateState('error');
      setErrorInfo({ raw: result.error ?? '', operation: 'install' });
    }
  }, [t]);

  const handleChannelChange = useCallback(
    async (next: UpdateChannel) => {
      if (next === updateChannel) return;
      await updateSettings({ updateChannel: next });
      handleCheckForUpdates();
    },
    [updateChannel, updateSettings, handleCheckForUpdates],
  );

  const displayState: UpdateState = portablePhase === null ? updateState : portablePhaseToUiStatus(portablePhase.phase);
  const isChecking = displayState === 'checking';
  // ⚠️ 百分比**按形态分源**：盘上那条链的百分比在公开状态里（`portablePhase.percent`，
  //    由便携服务逐次 publish），装机版那条走 `onUpdateDownloadProgress` 事件。
  //    混用会让盘上用户盯着一个永远 0% 的进度条。
  const shownPercent = portable ? (portablePhase?.percent ?? 0) : downloadPercent;
  displayStateRef.current = displayState;

  return (
    <div>
      {hideHeading ? null : (
        <h3 className="type-section-title mb-4 text-[var(--text-primary)]">{t('settings.about')}</h3>
      )}
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

        {displayState === 'available' && versionInfo && (
          <div className="px-5 py-4">
            <InlineNotice tone="info">
              <div>
                <p className="type-label mb-2 text-[var(--text-primary)]">
                  {t('settings.newVersionAvailable', { version: versionInfo.latestVersion })}
                </p>
                {portable ? (
                  // U 盘版：主进程**会**下载、校验、解压到暂存目录，全部通过才叫 `ready`；
                  // 换目录那一步由盘上的启动器做。以前这里只给一句"用新文件夹替换"的指引，
                  // 而那句在便携更新服务做好之后就**过时了** —— 用户于是没有可达的入口。
                  <Button variant="default" size="sm" onClick={() => void handleDownload()} className="gap-1.5">
                    <Download size={14} />
                    {t('settings.portableUpdate.downloadAndPrepare')}
                  </Button>
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

        {displayState === 'downloading' && (
          <div className="px-5 py-4">
            <div className="rounded-lg px-4 py-3 bg-[var(--bg-tertiary)] border border-[var(--border)]">
              <div className="flex items-center justify-between gap-3 mb-2">
                <p className="type-body text-[var(--text-secondary)]">
                  {t('settings.downloadProgress', { percent: shownPercent })}
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
                  style={{ width: `${shownPercent}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {displayState === 'downloaded' && (
          <div className="px-5 py-4">
            <InlineNotice tone="info">
              <div>
                <p className="type-label mb-2 text-[var(--text-primary)]">
                  {t('settings.newVersionAvailable', { version: versionInfo?.latestVersion })}
                </p>
                <Button variant="default" size="sm" disabled={busy} onClick={handleInstall} className="gap-1.5">
                  <RotateCcw size={14} />
                  {t('settings.readyToInstall')}
                </Button>
                {busy ? (
                  <p className="type-support mt-2 text-[var(--text-muted)]">{t('settings.portableUpdate.busyHint')}</p>
                ) : null}
              </div>
            </InlineNotice>
          </div>
        )}

        {displayState === 'preparing' && (
          <div className="space-y-2">
            <p className="type-body text-[var(--text-secondary)]">
              {t('settings.portableUpdate.preparing')}
              {/* 校验/解压也有真实百分比 ⇒ 一并显示，别让用户盯着不动的界面 */}
              {shownPercent > 0 ? ` ${t('settings.downloadProgress', { percent: shownPercent })}` : ''}
            </p>
            <Button variant="ghost" size="sm" onClick={handleCancelDownload}>
              {t('settings.portableUpdate.cancel')}
            </Button>
          </div>
        )}

        {displayState === 'ready' && (
          <div className="space-y-2">
            <p className="type-body text-[var(--text-secondary)]">
              {t('settings.portableUpdate.ready', { version: versionInfo?.latestVersion ?? '' })}
            </p>
            {/* 忙态不是错误：候选已经备好，等手头的任务结束再重启即可（检查/下载不受影响） */}
            {busy ? (
              <p className="type-support text-[var(--text-muted)]">{t('settings.portableUpdate.busyHint')}</p>
            ) : null}
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => void handleInstall()}>
                {t('settings.portableUpdate.restartNow')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPortablePhase(null)}>
                {t('settings.portableUpdate.later')}
              </Button>
            </div>
          </div>
        )}

        {displayState === 'applying' && (
          <p className="type-body text-[var(--text-secondary)]">{t('settings.portableUpdate.applying')}</p>
        )}

        {displayState === 'rolled-back' && (
          <p className="type-body text-[var(--text-secondary)]">
            {t('settings.portableUpdate.rolledBack', { version: versionInfo?.currentVersion ?? '' })}
          </p>
        )}

        {displayState === 'error' && (
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
              {/* 翻译放在渲染时：盘上形态的失败原因与"还差多少"都在 `portablePhase` 里 */}
              {t('settings.updateError', {
                message: describeUpdateErrorFromState(errorInfo?.raw, errorInfo?.operation ?? 'updater', portablePhase),
              })}
            </InlineNotice>
            {/* ⭐ 出错之后**入口还得在**：否则用户只有"检查更新"这一条路，
                而他要的明明是"再试一次下载"。⚠️ 这里只给下载入口 ——
                失败之后**绝不允许**出现任何通往换目录的按钮。 */}
            {portable && (
              <Button variant="outline" size="sm" onClick={() => void handleDownload()} className="mt-2 gap-1.5">
                <Download size={14} />
                {t('settings.portableUpdate.downloadAndPrepare')}
              </Button>
            )}
          </div>
        )}

        <div className="px-5 py-4 space-y-2">
          {/* 便携形态的"有新版本"卡片上没有下载按钮，得留一个重新检查的入口；
              其余状态各自有按钮（下载/安装/重试），不用重复给。 */}
          {(displayState === 'idle' || displayState === 'checking' || (portable && displayState === 'available')) && (
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
