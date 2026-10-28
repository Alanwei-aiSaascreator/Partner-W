import { useEffect, useState, lazy, Suspense, Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isPaired } from './persistence/db';
import { reportDebugEvent } from './lib/debug';
import { useGatewayBootstrap } from './hooks/useGatewayBootstrap';
import { useUiStore } from './stores/hooks';
import { reconnectAllClients } from './gateway/client-registry';
import { clearAll } from './persistence/db';
import { DrawerLayout } from './views/DrawerLayout';
import { Toaster } from 'sonner';
import { useThemeInit } from './hooks/useThemeInit';

const PairingViewLazy = lazy(() => import('./views/PairingView').then((m) => ({ default: m.PairingView })));

export default function App() {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const [paired, setPaired] = useState(false);
  const storeTheme = useUiStore((s) => s.theme);

  // 带配对参数的链接强制进配对页（哪怕本地已配对过）：给真机联调用的后门。
  // ⚠️ 只取**首次渲染**的值：配对成功后要复位，否则 URL 参数还在，用户会一直
  //    停在配对页（实测踩过）。
  const [forcePairing, setForcePairing] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return Boolean(params.get('pair') || (params.get('host') && params.get('token')));
    } catch {
      return false;
    }
  });

  useThemeInit();

  useEffect(() => {
    isPaired()
      .then((p) => {
        setPaired(p);
        setReady(true);
      })
      .catch((err: unknown) => {
        reportDebugEvent({
          level: 'error',
          domain: 'app',
          event: 'app.isPaired.failed',
          error: { message: err instanceof Error ? err.message : 'Failed to check pairing status' },
        });
        setReady(true);
      });
  }, []);

  if (!ready) return <LoadingSpinner text={t('app.loading')} />;

  return (
    <ErrorBoundary>
      <Suspense fallback={<LoadingSpinner text={t('app.loading')} />}>
        {paired && !forcePairing ? (
          <AppShell onSignedOut={() => setPaired(false)} />
        ) : (
          <PairingViewLazy
            onPaired={() => {
              setPaired(true);
              setForcePairing(false);
              // 配对成功后清掉 URL 里的配对参数，避免刷新又被打回配对页。
              if (window.location.search) {
                window.history.replaceState({}, '', window.location.pathname);
              }
            }}
          />
        )}
      </Suspense>
      <Toaster theme={storeTheme === 'auto' ? 'system' : storeTheme} richColors position="top-center" />
    </ErrorBoundary>
  );
}

function AppShell({ onSignedOut }: { onSignedOut: () => void }) {
  useGatewayBootstrap();
  const { t } = useTranslation();
  const gatewaysLoaded = useUiStore((s) => s.gatewaysLoaded);
  const statusMap = useUiStore((s) => s.gatewayStatusMap);

  const entries = Object.entries(statusMap);
  const anyConnected = entries.some(([, s]) => s === 'connected');
  const gaveUp = entries.length > 0 && entries.every(([, s]) => s === 'disconnected');

  if (gatewaysLoaded && !anyConnected) {
    return (
      <div
        className="safe-area-top safe-area-bottom flex h-full flex-col items-center justify-center gap-4 px-8"
        style={{ backgroundColor: 'var(--bg-primary)' }}
      >
        <img src={`${import.meta.env.BASE_URL}icons/logo.png`} alt="ClawWork" className="mb-2 h-16 w-16" />
        {!gaveUp && (
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
        )}
        <p className="text-center type-body" style={{ color: 'var(--text-secondary)' }}>
          {gaveUp ? t('gateway.disconnected') : t('chat.authorizationPending')}
        </p>
        <p className="max-w-sm text-center type-support" style={{ color: 'var(--text-muted)' }}>
          {t('pairing.instruction')}
        </p>
        <div className="flex w-full max-w-xs flex-col gap-2">
          <button
            onClick={reconnectAllClients}
            className="w-full rounded-xl px-6 type-body"
            style={{
              backgroundColor: 'var(--accent)',
              color: 'var(--accent-foreground)',
              minHeight: 44,
            }}
          >
            {t('shell.reconnect')}
          </button>
          {/*
           * ⚠️ 出口必须有：真机上这一步曾经是个死胡同 —— 首次连接失败后整屏只剩"重新连接"，
           *    用户既回不到扫码页、也清不掉坏凭据（唯一的办法是卸载重装）。
           *    "重新配对"= 清空本地身份/网关后重载，回到扫码页。
           */}
          <button
            onClick={() => {
              void (async () => {
                try {
                  await clearAll();
                } catch {
                  /* 清不掉也要往下走：重载后至少能重新扫码 */
                }
                window.location.replace(`${import.meta.env.BASE_URL}?forcePairing=1`);
              })();
            }}
            className="w-full rounded-xl px-6 type-body"
            style={{
              backgroundColor: 'var(--bg-secondary)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border-subtle)',
              minHeight: 44,
            }}
          >
            {t('pairing.restartPairing')}
          </button>
        </div>
      </div>
    );
  }

  return <DrawerLayout onSignedOut={onSignedOut} />;
}

function LoadingSpinner({ text }: { text?: string }) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3"
      style={{ backgroundColor: 'var(--bg-primary)' }}
    >
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
      {text && (
        <span className="type-support" style={{ color: 'var(--text-muted)' }}>
          {text}
        </span>
      )}
    </div>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    reportDebugEvent({
      level: 'error',
      domain: 'app',
      event: 'app.error-boundary',
      error: { message: error.message, stack: error.stack },
    });
  }

  override render() {
    if (this.state.error) {
      return <ErrorFallback error={this.state.error} />;
    }
    return this.props.children;
  }
}

function ErrorFallback({ error }: { error: Error }) {
  const { t } = useTranslation();

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 px-8"
      style={{ backgroundColor: 'var(--bg-primary)' }}
      role="alert"
    >
      <p className="text-center type-body font-medium" style={{ color: 'var(--danger)' }}>
        {t('app.error')}
      </p>
      <pre
        className="max-w-full overflow-x-auto rounded-lg px-4 py-2 type-support"
        style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
      >
        {error.message}
      </pre>
      <button
        onClick={() => window.location.reload()}
        aria-label={t('app.reload')}
        className="rounded-lg px-4 type-body"
        style={{
          backgroundColor: 'var(--accent)',
          color: 'var(--accent-foreground)',
          minHeight: 44,
          minWidth: 44,
        }}
      >
        {t('app.reload')}
      </button>
    </div>
  );
}
