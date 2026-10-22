import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Smartphone, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';

/**
 * 待批 / 已配对的手机设备。
 *
 * 为什么必须有这块：手机第一次连上来会停在「请在桌面端批准此设备」，
 * 而 `device.pair.approve` 只能由桌面壳调（需要 operator.pairing）——
 * 没有这个界面，产品链路到这里就断了（真机验证时踩到）。
 *
 * 轮询而不是事件：`device.pair.changed` 事件在桌面壳这边还没有订阅通道，
 * 3 秒一次 list 足够（手机端也会自动重试连接）。
 */

interface PendingDevice {
  requestId: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  scopes?: string[];
  ts?: number;
}

interface PairedDevice {
  deviceId: string;
  displayName?: string;
  platform?: string;
  scopes?: string[];
  connected?: boolean;
  lastSeenAtMs?: number;
  approvedAtMs?: number;
}

const POLL_MS = 3000;

function formatWhen(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function RemoteDevicesPanel({ gatewayId }: { gatewayId: string | null }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<PendingDevice[]>([]);
  const [paired, setPaired] = useState<PairedDevice[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!gatewayId) return;
    try {
      const res = await window.clawwork.devicePairList(gatewayId);
      if (!res.ok || !res.result) return;
      const payload = res.result as { pending?: PendingDevice[]; paired?: PairedDevice[] };
      setPending(payload.pending ?? []);
      setPaired(payload.paired ?? []);
    } catch {
      /* 网关没连上时静默：这块是辅助信息，不弹错 */
    }
  }, [gatewayId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleApprove = useCallback(
    async (requestId: string) => {
      if (!gatewayId) return;
      setBusy(requestId);
      try {
        const res = await window.clawwork.devicePairApprove(gatewayId, requestId);
        if (!res.ok) throw new Error(res.error ?? 'approve failed');
        toast.success(t('settings.remoteDeviceApproved'));
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('settings.remoteDeviceApproveFailed'));
      } finally {
        setBusy(null);
      }
    },
    [gatewayId, refresh, t],
  );

  const handleRemove = useCallback(
    async (deviceId: string) => {
      if (!gatewayId) return;
      setBusy(deviceId);
      try {
        const res = await window.clawwork.devicePairRemove(gatewayId, deviceId);
        if (!res.ok) throw new Error(res.error ?? 'remove failed');
        toast.success(t('settings.remoteDeviceRemoved'));
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('settings.remoteDeviceRemoveFailed'));
      } finally {
        setBusy(null);
      }
    },
    [gatewayId, refresh, t],
  );

  if (!gatewayId) return null;

  return (
    <div className="space-y-3 px-3 py-3">
      {pending.length > 0 && (
        <div className="space-y-2">
          <p className="type-label text-[var(--warning)]">{t('settings.remoteDevicesPending')}</p>
          {pending.map((device) => (
            <div
              key={device.requestId}
              className="flex items-center gap-3 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2"
            >
              <Smartphone size={16} className="flex-shrink-0 text-[var(--text-muted)]" />
              <div className="min-w-0 flex-1">
                <p className="truncate type-body text-[var(--text-primary)]">
                  {device.displayName ?? device.platform ?? 'Unknown'}
                </p>
                <p className="type-support text-[var(--text-muted)]">
                  {(device.scopes ?? []).join(', ')}
                  {device.ts ? ` · ${formatWhen(device.ts)}` : ''}
                </p>
              </div>
              <button
                onClick={() => void handleApprove(device.requestId)}
                disabled={busy === device.requestId}
                className="glow-focus type-label rounded-lg border border-[var(--accent)] px-3 py-1 text-[var(--accent)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                {busy === device.requestId ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <span className="flex items-center gap-1">
                    <Check size={14} />
                    {t('settings.remoteDeviceApprove')}
                  </span>
                )}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <p className="type-label text-[var(--text-primary)]">{t('settings.remoteDevicesPaired')}</p>
        {paired.length === 0 ? (
          <p className="type-body text-[var(--text-muted)]">{t('settings.remoteDevicesEmpty')}</p>
        ) : (
          paired.map((device) => (
            <div
              key={device.deviceId}
              className="flex items-center gap-3 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2"
            >
              <span
                className={`h-2 w-2 flex-shrink-0 rounded-full ${
                  device.connected ? 'bg-[var(--accent)]' : 'bg-[var(--text-muted)]'
                }`}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate type-body text-[var(--text-primary)]">
                  {device.displayName ?? device.platform ?? device.deviceId.slice(0, 8)}
                </p>
                <p className="type-support text-[var(--text-muted)]">
                  {(device.scopes ?? []).join(', ')}
                  {device.connected
                    ? ` · ${t('settings.remoteDeviceOnline')}`
                    : device.lastSeenAtMs
                      ? ` · ${formatWhen(device.lastSeenAtMs)}`
                      : ''}
                </p>
              </div>
              <button
                onClick={() => void handleRemove(device.deviceId)}
                disabled={busy === device.deviceId}
                aria-label={t('settings.remoteDeviceRemove')}
                className="glow-focus rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--danger)]"
              >
                {busy === device.deviceId ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Trash2 size={14} />
                )}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
