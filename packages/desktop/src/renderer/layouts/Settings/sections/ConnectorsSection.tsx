import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, MessageSquare, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import SettingGroup from '@/components/semantic/SettingGroup';
import SettingRow from '@/components/semantic/SettingRow';
import InlineNotice from '@/components/semantic/InlineNotice';

/**
 * 设置 → 连接器（2026-10-17 起；2026-10-18 改为**应用内扫码**）。
 *
 * 产品语义：让用户**在应用里**把外部通道接进来 —— 弹出二维码、手机扫码、
 * 之后飞书私聊机器人就能指挥这台电脑干活。不再打开系统终端。
 *
 * ⚠️ 诚实边界（这决定了文案能写什么）：
 *   · 桌面侧只能确认「配置里有没有 channels.feishu」「绑到哪个助手」「通道开关」；
 *     长连接状态在网关进程里，我们没有查询通道 ⇒ **绝不显示"已连接"**。
 *   · `boundAgentId === null` 时飞书消息会 `AgentSelectionRequiredError`，必须提示用户选助手。
 */
interface FeishuAgentChoice {
  id: string;
  name: string;
}

interface FeishuState {
  id: 'feishu';
  configured: boolean;
  appId: string | null;
  enabled: boolean;
  pluginInstalled: boolean;
  runtimeReady: boolean;
  boundAgentId: string | null;
  agents: FeishuAgentChoice[];
  channelHealth?: {
    running: boolean;
    lifecycle: string;
    ingressUnavailable: boolean;
    lastError: string | null;
  } | null;
}

interface RegistrationSnapshot {
  phase: 'idle' | 'pending' | 'success' | 'denied' | 'expired' | 'cancelled' | 'error';
  qrUrl: string | null;
  userCode: string | null;
  expireAt: number | null;
  appId: string | null;
  boundAgentId: string | null;
  error: string | null;
}

const POLL_INTERVAL_MS = 1000;

/**
 * 主进程错误码 → 用户文案（内部码**不上屏**；明细只进日志）。
 *
 * 这套映射是"诚实边界"的一部分：`write-failed:hash-conflict` 这种字符串对用户
 * 没有任何行动价值，反而暴露实现细节。认不出的码统一说"接入失败"，不回显原文。
 */
function connectorErrorText(error: string, t: (key: string) => string): string {
  if (!error) return '';
  if (error === 'gateway-unavailable' || error === 'runtime-missing') {
    return t('settings.connectors.feishu.gatewayUnavailable');
  }
  if (error.startsWith('write-failed')) return t('settings.connectors.feishu.writeFailed');
  if (error === 'invalid-agent') return t('settings.connectors.feishu.invalidAgent');
  if (error.startsWith('plugin-install-failed')) return t('settings.connectors.feishu.pluginInstallFailed');
  if (error === 'unsupported-auth') return t('settings.connectors.feishu.unsupportedAuth');
  return t('settings.connectors.feishu.unknownError');
}

const SELECT_CLASS = cn(
  'type-body w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]',
  'px-3 py-2 text-[var(--text-primary)]',
  'focus-visible:outline-none glow-focus',
);

export default function ConnectorsSection() {
  const { t } = useTranslation();
  const [state, setState] = useState<FeishuState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [registration, setRegistration] = useState<RegistrationSnapshot | null>(null);
  const registrationRef = useRef<RegistrationSnapshot | null>(null);

  useEffect(() => {
    registrationRef.current = registration;
  }, [registration]);

  const applyConnectorsFallback = useCallback(async (): Promise<void> => {
    // 主进程还没有新 IPC 时（开发态热更新），退回旧的状态接口：只读盘上事实。
    const legacy = await window.clawwork.getConnectors();
    const feishu = legacy.ok ? legacy.result?.connectors.find((item) => item.id === 'feishu') : null;
    setState(
      feishu
        ? {
            ...feishu,
            boundAgentId: null,
            agents: [],
          }
        : null,
    );
  }, []);

  const refresh = useCallback(async () => {
    try {
      const result = await window.clawwork.getFeishuState();
      if (result.ok && result.result) {
        setState(result.result.state);
      } else {
        await applyConnectorsFallback();
      }
    } catch {
      try {
        await applyConnectorsFallback();
      } catch {
        setState(null);
      }
    } finally {
      setLoading(false);
    }
  }, [applyConnectorsFallback]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startScan = useCallback(async () => {
    setStarting(true);
    setRegistration(null);
    setDialogOpen(true);
    try {
      const result = await window.clawwork.beginFeishuRegistration();
      if (result.ok && result.result) {
        setRegistration(result.result);
      } else {
        setDialogOpen(false);
        const error = result.ok ? '' : (result.error ?? '');
        if (
          error === 'gateway-unavailable' ||
          error === 'runtime-missing' ||
          error.startsWith('plugin-install-failed')
        ) {
          toast.error(t('settings.connectors.feishu.gatewayUnavailable'));
        } else if (error === 'unsupported-auth' || error.startsWith('rejected') || error.startsWith('malformed')) {
          toast.error(t('settings.connectors.feishu.scanUnavailable'));
        } else {
          toast.error(t('settings.connectors.feishu.scanNetworkFailed'));
        }
      }
    } catch {
      setDialogOpen(false);
      toast.error(t('settings.connectors.feishu.scanNetworkFailed'));
    } finally {
      setStarting(false);
    }
  }, [t]);

  const cancelScan = useCallback(() => {
    void window.clawwork.cancelFeishuRegistration().catch(() => undefined);
  }, []);

  const handleDialogOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setDialogOpen(true);
        return;
      }
      if (registrationRef.current?.phase === 'pending') cancelScan();
      setDialogOpen(false);
    },
    [cancelScan],
  );

  // 扫码进行中：每秒向主进程要一次状态（主进程在后台轮询飞书）。
  useEffect(() => {
    if (!dialogOpen) return;
    if (registration?.phase !== 'pending') return;
    let disposed = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const result = await window.clawwork.getFeishuRegistration();
          if (disposed || !result.ok || !result.result) return;
          const next = result.result;
          setRegistration(next);
          if (next.phase === 'success') {
            toast.success(t('settings.connectors.feishu.scanSuccess'));
            void refresh();
          }
        } catch {
          // 单次读失败不打断：下一拍继续。
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [dialogOpen, registration?.phase, refresh, t]);

  const handleBind = useCallback(
    async (agentId: string | null) => {
      setBusy(true);
      try {
        const result = await window.clawwork.bindFeishuAgent(agentId);
        if (result.ok) {
          toast.success(
            agentId ? t('settings.connectors.feishu.bindChanged') : t('settings.connectors.feishu.bindCleared'),
          );
        } else {
          toast.error(t('settings.connectors.feishu.actionFailed'));
        }
      } catch {
        toast.error(t('settings.connectors.feishu.actionFailed'));
      } finally {
        setBusy(false);
        void refresh();
      }
    },
    [refresh, t],
  );

  const handleToggleChannel = useCallback(async () => {
    if (!state) return;
    setBusy(true);
    try {
      const result = await window.clawwork.setFeishuChannelEnabled(!state.enabled);
      if (result.ok) {
        toast.success(
          !state.enabled
            ? t('settings.connectors.feishu.channelEnabled')
            : t('settings.connectors.feishu.channelDisabled'),
        );
      } else {
        toast.error(t('settings.connectors.feishu.actionFailed'));
      }
    } catch {
      toast.error(t('settings.connectors.feishu.actionFailed'));
    } finally {
      setBusy(false);
      void refresh();
    }
  }, [refresh, state, t]);

  const agentChoices = useMemo(() => {
    const choices = state?.agents ?? [];
    const bound = state?.boundAgentId;
    if (!bound || choices.some((choice) => choice.id === bound)) return choices;
    return [{ id: bound, name: bound }, ...choices];
  }, [state?.agents, state?.boundAgentId]);

  const stateLabel =
    !state || !state.runtimeReady
      ? t('settings.connectors.feishu.stateUnavailable')
      : !state.configured
        ? t('settings.connectors.feishu.stateIdle')
        : state.enabled
          ? t('settings.connectors.feishu.stateConfigured')
          : t('settings.connectors.feishu.stateClosed');

  const phase = registration?.phase ?? 'idle';
  const phaseMessage = (() => {
    if (phase === 'pending') return t('settings.connectors.feishu.scanWaiting');
    if (phase === 'success') return t('settings.connectors.feishu.scanSuccess');
    if (phase === 'denied') return t('settings.connectors.feishu.scanDenied');
    if (phase === 'expired') return t('settings.connectors.feishu.scanExpired');
    if (phase === 'error') return t('settings.connectors.feishu.scanFailed');
    if (phase === 'cancelled') return t('settings.connectors.feishu.scanCancelled');
    return t('settings.connectors.feishu.scanWaiting');
  })();

  return (
    <div>
      <h3 className="type-section-title mb-4 text-[var(--text-primary)]">{t('settings.connectors.title')}</h3>
      <p className="type-body mb-4 text-[var(--text-secondary)]">{t('settings.connectors.subtitle')}</p>

      <SettingGroup>
        <SettingRow
          label={
            <span className="flex items-center gap-2">
              <MessageSquare size={15} className="text-[var(--text-secondary)]" />
              {t('settings.connectors.feishu.title')}
            </span>
          }
          description={t('settings.connectors.feishu.description')}
        >
          <span className="type-label text-[var(--text-secondary)]">{stateLabel}</span>
        </SettingRow>

        <div className="space-y-3 px-5 py-4">
          {state?.configured && state.appId ? (
            <p className="type-support text-[var(--text-muted)]">
              {t('settings.connectors.feishu.appId', { appId: state.appId })}
            </p>
          ) : null}

          {state && !state.pluginInstalled ? (
            <InlineNotice tone="info">{t('settings.connectors.feishu.pluginMissing')}</InlineNotice>
          ) : null}

          {state && !state.runtimeReady ? (
            <InlineNotice tone="error">{t('settings.connectors.feishu.runtimeMissing')}</InlineNotice>
          ) : null}

          {state?.configured ? (
            <div className="space-y-2">
              <label className="type-label block text-[var(--text-secondary)]" htmlFor="feishu-bound-agent">
                {t('settings.connectors.feishu.boundAgent')}
              </label>
              <select
                id="feishu-bound-agent"
                className={SELECT_CLASS}
                value={state.boundAgentId ?? ''}
                disabled={busy || !state.runtimeReady}
                onChange={(event) => void handleBind(event.target.value ? event.target.value : null)}
              >
                <option value="">
                  {state.boundAgentId
                    ? t('settings.connectors.feishu.bindNone')
                    : t('settings.connectors.feishu.bindUnset')}
                </option>
                {agentChoices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.name}
                  </option>
                ))}
              </select>
              {state.boundAgentId ? null : (
                <InlineNotice tone="warning">{t('settings.connectors.feishu.unboundWarning')}</InlineNotice>
              )}
              {state.channelHealth?.ingressUnavailable ? (
                <InlineNotice tone="error">{t('settings.connectors.feishu.ingressUnavailable')}</InlineNotice>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {state?.configured ? (
              <>
                <Button
                  variant="default"
                  size="sm"
                  className="gap-1.5"
                  disabled={starting}
                  onClick={() => void startScan()}
                >
                  {starting ? <Loader2 size={14} className="animate-spin" /> : <MessageSquare size={14} />}
                  {t('settings.connectors.feishu.reconnect')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !state.boundAgentId}
                  onClick={() => void handleBind(null)}
                >
                  {t('settings.connectors.feishu.unbind')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !state.runtimeReady}
                  onClick={() => void handleToggleChannel()}
                >
                  {state.enabled
                    ? t('settings.connectors.feishu.disableChannel')
                    : t('settings.connectors.feishu.enableChannel')}
                </Button>
              </>
            ) : (
              <Button
                variant="default"
                size="sm"
                className="gap-1.5"
                disabled={starting || !state?.runtimeReady}
                onClick={() => void startScan()}
              >
                {starting ? <Loader2 size={14} className="animate-spin" /> : <MessageSquare size={14} />}
                {t('settings.connectors.feishu.connect')}
              </Button>
            )}
            <Button variant="outline" size="sm" className="gap-1.5" disabled={loading} onClick={() => void refresh()}>
              <RefreshCw size={14} />
              {t('settings.connectors.refresh')}
            </Button>
          </div>

          <p className="type-support text-[var(--text-muted)]">{t('settings.connectors.feishu.scanHint')}</p>
        </div>
      </SettingGroup>

      <p className="type-support mt-4 text-[var(--text-muted)]">{t('settings.connectors.feishu.billingNote')}</p>

      <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.connectors.feishu.dialogTitle')}</DialogTitle>
            <DialogDescription>{t('settings.connectors.feishu.dialogDescription')}</DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-3">
            {starting || !registration ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 size={22} className="animate-spin text-[var(--text-secondary)]" />
              </div>
            ) : null}

            {!starting && registration?.phase === 'pending' && registration.qrUrl ? (
              <div className="flex flex-col items-center gap-3">
                <div className="rounded-xl bg-[var(--bg-secondary)] p-3">
                  <QRCodeSVG value={registration.qrUrl} size={240} level="M" />
                </div>
                {registration.userCode ? (
                  <p className="type-body text-[var(--text-primary)]">
                    {t('settings.connectors.feishu.userCode', { code: registration.userCode })}
                  </p>
                ) : null}
                <p className="type-support text-center text-[var(--text-secondary)]">
                  {t('settings.connectors.feishu.scanWaiting')}
                </p>
              </div>
            ) : null}

            {!starting && registration && registration.phase !== 'pending' ? (
              <div className="space-y-3">
                <p className="type-body text-[var(--text-primary)]">{phaseMessage}</p>
                {registration.phase === 'success' && registration.appId ? (
                  <p className="type-support text-[var(--text-secondary)]">
                    {t('settings.connectors.feishu.appId', { appId: registration.appId })}
                  </p>
                ) : null}
                {registration.error ? (
                  <p className="type-support break-all text-[var(--text-muted)]">
                    {connectorErrorText(registration.error, t)}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-end gap-2">
              {registration?.phase === 'pending' ? (
                <Button variant="outline" size="sm" onClick={() => handleDialogOpenChange(false)}>
                  {t('settings.connectors.feishu.cancelScan')}
                </Button>
              ) : null}
              {registration && registration.phase !== 'pending' && registration.phase !== 'success' ? (
                <Button variant="default" size="sm" disabled={starting} onClick={() => void startScan()}>
                  {t('settings.connectors.feishu.retryScan')}
                </Button>
              ) : null}
              {registration?.phase === 'success' || registration?.phase === 'cancelled' ? (
                <Button variant="default" size="sm" onClick={() => handleDialogOpenChange(false)}>
                  {t('settings.connectors.feishu.done')}
                </Button>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
