import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Smartphone, Loader2, Copy } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useUiStore } from '@/stores/uiStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { isMobileGatewayAddress } from '@/lib/mobile-pairing';

/**
 * 手机配对对话框。
 *
 * 两种模式：
 *   - remote（生产默认）：二维码是 v2 payload —— "公网地址 + 一次性 setup code"，
 *     里面**不含**网关 token / 密码（技术方案 v1.1 §6.2）。手机在 4G 下可用。
 *   - lan（仅开发态）：历史 v1 payload，把网关凭据明文编进二维码。
 *     只用来在本机调试 PWA，生产构建里不出现这个开关。
 */
interface LegacyQrPayload {
  v: 1;
  s?: string;
  g: {
    u: string;
    n: string;
    t?: string;
    p?: string;
    c?: string;
    m?: 'token' | 'password' | 'pairingCode';
  }[];
}

type PairMode = 'remote' | 'lan';

const IS_DEV = Boolean(import.meta.env.DEV);
const PUBLIC_URL_KEY = 'clawwork.pair.publicUrl';
/** 远程二维码跟着网关 setup code 的 10 分钟有效期走。 */
const REMOTE_TTL_SECONDS = 600;
const LAN_TTL_SECONDS = 60;

export default function PairMobileDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const gatewayInfoMap = useUiStore((s) => s.gatewayInfoMap);
  const gatewayStatusMap = useUiStore((s) => s.gatewayStatusMap);
  const gatewayConfigs = useSettingsStore((s) => s.settings?.gateways);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const loadSettings = useSettingsStore((s) => s.load);

  const [mode, setMode] = useState<PairMode>('remote');
  const [publicUrl, setPublicUrl] = useState(() => {
    try {
      return localStorage.getItem(PUBLIC_URL_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [selectedGatewayId, setSelectedGatewayId] = useState<string | null>(null);
  const [shareIdentity, setShareIdentity] = useState(true);
  const [qrData, setQrData] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [generating, setGenerating] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const gatewayEntries = useMemo(
    () =>
      Object.entries(gatewayInfoMap).filter(([id]) => {
        const cfg = gatewayConfigs?.find((gateway) => gateway.id === id);
        if (!cfg) return false;
        // 远程模式走隧道，本机 loopback 网关是**合法**的配对目标；
        // 局域网模式才需要"手机直接够得着"的地址。
        return mode === 'remote' ? true : isMobileGatewayAddress(cfg.url);
      }),
    [gatewayInfoMap, gatewayConfigs, mode],
  );

  useEffect(() => {
    if (!open) return;
    const firstConnectedId = gatewayEntries.find(([id]) => gatewayStatusMap[id] === 'connected')?.[0] ?? null;
    const firstGatewayId = gatewayEntries[0]?.[0] ?? null;
    setSelectedGatewayId(firstConnectedId ?? firstGatewayId);
    setShareIdentity(true);
    setQrData(null);
    setCountdown(0);
    setGenerating(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, [open, gatewayStatusMap, gatewayEntries]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (settingsLoaded) return;
    void loadSettings().catch((err: unknown) => {
      console.error('[PairMobileDialog] loadSettings failed:', err);
    });
  }, [settingsLoaded, loadSettings]);

  const startCountdown = useCallback((seconds: number) => {
    setCountdown(seconds);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = null;
          setQrData(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const handleGenerate = useCallback(
    async (identity = shareIdentity, gatewayId = selectedGatewayId, nextMode = mode) => {
      if (!gatewayId) return;
      const cfg = gatewayConfigs?.find((gateway) => gateway.id === gatewayId);
      if (!cfg) return;

      if (nextMode === 'remote') {
        const url = publicUrl.trim();
        if (!url) {
          toast.error(t('settings.pairPublicUrlRequired'));
          return;
        }
        setGenerating(true);
        try {
          const deviceId = identity ? await window.clawwork.getDeviceId() : undefined;
          const res = await window.clawwork.mobilePairSetupCode(gatewayId, url, {
            gatewayName: cfg.name,
            deviceId,
          });
          if (!res.ok || !res.result) {
            throw new Error(res.error ?? 'pair setup failed');
          }
          const result = res.result as { payload?: unknown; url?: string };
          // 优先用 url：手机相机扫 URL 才会出现"打开"并直接进配对页。
          const qrValue = result.url ?? (result.payload ? JSON.stringify(result.payload) : null);
          if (!qrValue) throw new Error('gateway returned an empty payload');

          try {
            localStorage.setItem(PUBLIC_URL_KEY, url);
          } catch {
            /* storage unavailable */
          }
          setQrData(qrValue);
          startCountdown(REMOTE_TTL_SECONDS);
        } catch (err) {
          console.error('[PairMobileDialog] remote pair failed:', err);
          toast.error(t('settings.pairGenerateFailed'));
          setQrData(null);
          setCountdown(0);
        } finally {
          setGenerating(false);
        }
        return;
      }

      // lan（仅开发态）
      if (!isMobileGatewayAddress(cfg.url)) return;
      setGenerating(true);
      try {
        const payload: LegacyQrPayload = { v: 1, g: [] };
        if (identity) {
          payload.s = await window.clawwork.getDeviceId();
        }

        const authMode: 'token' | 'password' | 'pairingCode' =
          cfg.authMode ?? (cfg.pairingCode ? 'pairingCode' : cfg.password ? 'password' : 'token');
        payload.g.push({
          u: cfg.url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:'),
          t: authMode === 'token' ? (cfg.token ?? '') : undefined,
          p: authMode === 'password' ? cfg.password : undefined,
          c: authMode === 'pairingCode' ? cfg.pairingCode : undefined,
          m: authMode,
          n: cfg.name,
        });

        setQrData(JSON.stringify(payload));
        startCountdown(LAN_TTL_SECONDS);
      } catch (err) {
        console.error('[PairMobileDialog] handleGenerate failed:', err);
        toast.error(t('settings.pairGenerateFailed'));
        setQrData(null);
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        setCountdown(0);
      } finally {
        setGenerating(false);
      }
    },
    [gatewayConfigs, publicUrl, selectedGatewayId, shareIdentity, mode, startCountdown, t],
  );

  if (gatewayEntries.length === 0) return null;

  const canGenerate = mode === 'remote' ? Boolean(publicUrl.trim()) : Boolean(selectedGatewayId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone size={18} />
            {t('settings.pairMobile')}
          </DialogTitle>
          <DialogDescription>{t('settings.pairMobileDesc')}</DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-4">
          {IS_DEV && (
            <div className="flex gap-2">
              <Button
                variant={mode === 'remote' ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setMode('remote');
                  setQrData(null);
                  setCountdown(0);
                }}
              >
                {t('settings.pairModeRemote')}
              </Button>
              <Button
                variant={mode === 'lan' ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setMode('lan');
                  setQrData(null);
                  setCountdown(0);
                }}
              >
                {t('settings.pairModeLan')}
              </Button>
            </div>
          )}

          {mode === 'remote' && (
            <div>
              <p className="mb-2 type-label text-[var(--text-primary)]">{t('settings.pairPublicUrl')}</p>
              <input
                type="url"
                value={publicUrl}
                onChange={(e) => setPublicUrl(e.target.value)}
                placeholder={t('settings.pairPublicUrlPlaceholder')}
                spellCheck={false}
                autoComplete="off"
                className="w-full rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 type-body text-[var(--text-primary)] outline-none focus:ring-1 focus:ring-[var(--accent)]"
              />
              <p className="mt-2 type-support text-[var(--text-muted)]">{t('settings.pairRemoteHint')}</p>
            </div>
          )}

          <div>
            <p className="mb-2 type-label text-[var(--text-primary)]">{t('settings.pairSelectGateways')}</p>
            <div className="space-y-2">
              {gatewayEntries.map(([id, info]) => {
                const status = gatewayStatusMap[id] ?? 'disconnected';
                return (
                  <label
                    key={id}
                    className="flex cursor-pointer items-center gap-3 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 transition-colors hover:bg-[var(--bg-hover)]"
                  >
                    <input
                      type="radio"
                      name="pair-mobile-gateway"
                      checked={selectedGatewayId === id}
                      onChange={() => {
                        setSelectedGatewayId(id);
                        if (qrData) handleGenerate(shareIdentity, id);
                      }}
                      className="h-4 w-4 accent-[var(--accent)]"
                    />
                    <span className="flex-1 truncate type-body text-[var(--text-primary)]">{info.name}</span>
                    <span
                      className={`h-2 w-2 flex-shrink-0 rounded-full ${
                        status === 'connected'
                          ? 'bg-[var(--accent)]'
                          : status === 'connecting'
                            ? 'bg-[var(--warning)]'
                            : 'bg-[var(--text-muted)]'
                      }`}
                    />
                  </label>
                );
              })}
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-3 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 transition-colors hover:bg-[var(--bg-hover)]">
            <input
              type="checkbox"
              checked={shareIdentity}
              onChange={(e) => {
                const next = e.target.checked;
                setShareIdentity(next);
                if (qrData) handleGenerate(next, selectedGatewayId);
              }}
              className="h-4 w-4 accent-[var(--accent)]"
            />
            <span className="type-body text-[var(--text-primary)]">{t('settings.pairShareIdentity')}</span>
          </label>

          {qrData ? (
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-xl p-3" style={{ backgroundColor: 'var(--surface-qr-bg)' }}>
                <QRCodeSVG value={qrData} size={300} level="M" />
              </div>
              <p className="type-body text-[var(--text-muted)]">
                {t('settings.pairExpiresIn', { seconds: countdown })}
              </p>
              {/* 扫不出来时的兜底：把链接直接发到手机（微信/隔空投送）再粘贴。 */}
              <Button
                className="w-full"
                onClick={async () => {
                  try {
                    const res = await window.clawwork.copyText(qrData);
                    if (!res.ok) throw new Error(res.error ?? 'copy failed');
                    toast.success(t('settings.pairLinkCopied'));
                  } catch {
                    toast.error(t('settings.pairLinkCopyFailed'));
                  }
                }}
              >
                <Copy size={16} className="mr-2" />
                {t('settings.pairCopyLink')}
              </Button>
              {/* 复制失败时的兜底：这行可以手动选中。 */}
              <p
                className="type-support w-full select-all break-all text-center"
                style={{ color: 'var(--text-muted)' }}
                data-testid="pair-link-text"
              >
                {qrData}
              </p>
            </div>
          ) : (
            <Button onClick={() => handleGenerate()} disabled={!canGenerate || generating} className="w-full">
              {generating ? <Loader2 size={16} className="animate-spin" /> : t('settings.pairGenerate')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
