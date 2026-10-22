import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { isNativeApp } from '../persistence/native-bridge';
import { ScanLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const QrScanner = lazy(() => import('../components/QrScanner').then((m) => ({ default: m.QrScanner })));

const ERROR_AUTO_CLEAR_MS = 5000;

interface PairingViewProps {
  onPaired: () => void;
}

export function PairingView({ onPaired }: PairingViewProps) {
  const { t } = useTranslation();
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState('');
  const pairingRef = useRef(false);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), ERROR_AUTO_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [error]);

  const handleScanResult = useCallback(
    async (data: string) => {
      if (pairingRef.current) return;
      pairingRef.current = true;
      try {
        const { parseQrPayloadOrUrl } = await import('../lib/qr-decode');
        const { parseSetupCode, isSameGatewayHost } = await import('../lib/setup-code');
        // v1（明文凭据）只在开发态或 URL 带 ?legacyPair=1 时接受 —— 内测真机验证用。
        // 原生 App 里没有 URL 参数可用（用户是粘贴一条链接进来的），
        // 所以原生环境也放行明文凭据 —— 这是当前引擎唯一可用的配对方式。
        const legacyAllowed =
          new URLSearchParams(window.location.search).get('legacyPair') === '1' ||
          isNativeApp() ||
          Boolean(import.meta.env.DEV);
        // 扫码拿到的可能是 JSON payload，也可能是电脑端生成的 legacyPair URL：两者都认。
        const payload = parseQrPayloadOrUrl(data, { allowLegacyCredentials: legacyAllowed });

        const { saveIdentity, saveGateway, saveScopeId, clearAll } = await import('../persistence/db');
        await clearAll();
        const { exportDeviceIdentity, generateDeviceIdentity } = await import('../gateway/device-identity');
        const identity = await generateDeviceIdentity();
        const record = await exportDeviceIdentity(identity);
        await saveIdentity(record);

        if (payload.s) {
          await saveScopeId(payload.s);
        }

        for (const gw of payload.g) {
          if (payload.v === 2) {
            // v2：二维码只带 setup code —— 一次性凭据，用完即废（方案 v1.1 §6.2）。
            const setup = parseSetupCode(gw.c ?? '');
            if (!isSameGatewayHost(setup.url, gw.u)) {
              throw new Error(t('pairing.invalidQr'));
            }
            await saveGateway({
              id: crypto.randomUUID(),
              name: gw.n,
              url: setup.url,
              pairingCode: setup.bootstrapToken,
              authMode: 'pairingCode',
            });
            continue;
          }

          // v1（仅调试）：明文凭据，生产构建已被 parseQrPayload 拒绝。
          await saveGateway({
            id: crypto.randomUUID(),
            name: gw.n,
            url: gw.u,
            token: gw.m === 'token' || !gw.m ? gw.t : undefined,
            password: gw.m === 'password' ? gw.p : undefined,
            pairingCode: gw.m === 'pairingCode' ? gw.c : undefined,
            authMode: gw.m === 'setupCode' ? 'token' : (gw.m ?? 'token'),
          });
        }

        setScanning(false);
        onPaired();
      } catch (e) {
        pairingRef.current = false;
        setError(e instanceof Error ? e.message : t('pairing.invalidQr'));
        setScanning(false);
      }
    },
    [onPaired, t],
  );

  // 兜底：URL 直接带配对参数，跳过摄像头。
  //   `?pair=<base64url(payload)>`  —— 完整 payload
  //   `?host=<域名>&token=<网关 token>` —— 短链接形式（方便手机输入/复制）
  // 有些手机相机对长二维码识别率低（v1 码带 token，字符多），扫码会"没反应"。
  const handlePaste = useCallback(async () => {
    const raw = pasteValue.trim();
    if (!raw) return;
    let host = '';
    let token = '';
    try {
      const url = new URL(raw);
      host = (url.searchParams.get('host') ?? url.hostname).trim();
      token = (url.searchParams.get('token') ?? '').trim();
    } catch {
      setError(t('pairing.pasteInvalid'));
      return;
    }
    if (!host || !token) {
      setError(t('pairing.pasteInvalid'));
      return;
    }
    await handleScanResult(
      JSON.stringify({ v: 1, s: '', g: [{ n: '魔方罗盘', u: `wss://${host}`, t: token, m: 'token' }] }),
    );
  }, [pasteValue, handleScanResult, t]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    const rawPair = params.get('pair');
    if (rawPair) {
      try {
        const normalized = rawPair.replace(/-/g, '+').replace(/_/g, '/');
        const json = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
        void handleScanResult(json);
      } catch {
        /* 参数坏了就当没有 */
      }
      return;
    }

    const host = params.get('host')?.trim();
    const token = params.get('token')?.trim();
    if (host && token) {
      const payload = {
        v: 1,
        g: [{ n: 'Local Runtime', u: `wss://${host.replace(/^wss?:\/\//, '')}`, t: token, m: 'token' }],
      };
      void handleScanResult(JSON.stringify(payload));
    }
  }, [handleScanResult]);

  if (scanning) {
    return (
      <div style={{ position: 'fixed', inset: 0, backgroundColor: 'var(--bg-primary)' }}>
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center" style={{ color: 'var(--text-secondary)' }}>
              {t('pairing.loadingCamera')}
            </div>
          }
        >
          <QrScanner onScan={handleScanResult} onError={(msg) => setError(msg)} />
        </Suspense>
        <div className="safe-area-top" style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10 }}>
          <div className="flex items-center justify-between px-4 py-3">
            <button
              onClick={() => setScanning(false)}
              aria-label={t('pairing.cancelButton')}
              className="type-label rounded-lg px-3"
              style={{
                color: 'var(--accent)',
                backgroundColor: 'var(--overlay-scrim)',
                borderRadius: 8,
                minHeight: 44,
                minWidth: 44,
              }}
            >
              {t('pairing.cancelButton')}
            </button>
          </div>
        </div>
        {error && (
          <div
            className="type-body rounded-lg px-4 py-3"
            role="alert"
            style={{
              position: 'absolute',
              bottom: 'env(safe-area-inset-bottom, 40px)',
              left: 16,
              right: 16,
              zIndex: 10,
              backgroundColor: 'var(--danger-bg)',
              color: 'var(--danger)',
            }}
          >
            {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="safe-area-top safe-area-bottom flex h-full flex-col items-center justify-center px-8"
      style={{ backgroundColor: 'var(--bg-primary)' }}
    >
      <img src={`${import.meta.env.BASE_URL}icons/logo.png`} alt="魔方罗盘" className="mb-6 h-20 w-20" />
      <h1 className="type-page-title mb-2" style={{ color: 'var(--text-primary)' }}>
        {t('app.name')}
      </h1>
      <p className="mb-3 text-center" style={{ color: 'var(--text-secondary)' }}>
        {t('pairing.subtitle')}
      </p>
      <p className="type-body mb-8 max-w-sm text-center" style={{ color: 'var(--text-muted)' }}>
        {t('pairing.instruction')}
      </p>

      {error && (
        <div
          className="type-body mb-4 w-full max-w-sm rounded-lg px-4 py-3"
          style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' }}
          role="alert"
        >
          {error}
        </div>
      )}

      <button
        onClick={() => {
          setError(null);
          setScanning(true);
        }}
        aria-label={t('pairing.scanButton')}
        className="type-section-title flex items-center gap-2 rounded-xl px-8 transition-colors"
        style={{
          backgroundColor: 'var(--accent)',
          color: 'var(--accent-foreground)',
          minHeight: 52,
        }}
      >
        <ScanLine size={24} />
        {t('pairing.scanButton')}
      </button>

      {/* 手机 App 里没有桌面那条链接可扫时，粘贴链接是最快的兜底路径。 */}
      <div className="mt-8 w-full max-w-sm">
        <p className="type-support mb-2" style={{ color: 'var(--text-muted)' }}>
          {t('pairing.pasteHint')}
        </p>
        <textarea
          value={pasteValue}
          onChange={(event) => {
            setPasteValue(event.target.value);
            setError(null);
          }}
          placeholder="https://…/m/?legacyPair=1&host=…&token=…"
          rows={2}
          className="type-body w-full rounded-lg px-3 py-2 outline-none"
          style={{
            backgroundColor: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
          }}
        />
        <button
          onClick={() => void handlePaste()}
          disabled={!pasteValue.trim()}
          className="type-body mt-2 w-full rounded-lg py-2 font-medium transition-opacity disabled:opacity-40"
          style={{ backgroundColor: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
        >
          {t('pairing.pasteButton')}
        </button>
      </div>
    </div>
  );
}
