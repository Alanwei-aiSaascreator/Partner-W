import { useEffect, useState } from 'react';
import { RefreshCw, WifiOff, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { reconnectAllClients } from '../gateway/client-registry';
import { useUiStore } from '../stores/hooks';

/**
 * 连接状态横幅（手机端）—— 对齐桌面端 `ConnectionBanner` 的那条纪律：
 * **"正在重连"和"真的断了"必须说两套话，并且永远给一个出口**。
 *
 * 之前的手机端只在"一条都没连上"时才整屏拦住；一旦连过又掉线（切后台、换网、隧道抖），
 * 界面看起来完全正常，发消息却石沉大海 —— 没有任何提示。
 */
export function ConnectionBanner() {
  const { t } = useTranslation();
  const statusMap = useUiStore((s) => s.gatewayStatusMap);
  const [dismissed, setDismissed] = useState(false);

  const entries = Object.entries(statusMap);
  const connected = entries.some(([, status]) => status === 'connected');
  const disconnected = entries.filter(([, status]) => status === 'disconnected');

  // 连上就自动收起提示（下一次掉线会重新出现）
  useEffect(() => {
    if (connected) setDismissed(false);
  }, [connected]);

  if (connected || disconnected.length === 0 || dismissed) return null;

  return (
    <div
      className="flex items-start gap-2 px-3 py-2"
      style={{
        backgroundColor: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border-subtle)',
      }}
      role="status"
    >
      <WifiOff size={15} className="mt-0.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
      <div className="min-w-0 flex-1">
        <p className="type-support" style={{ color: 'var(--text-primary)' }}>
          {t('connection.lostTitle')}
        </p>
        <p className="type-support" style={{ color: 'var(--text-muted)' }}>
          {t('connection.lostHint')}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={reconnectAllClients}
          className="flex items-center gap-1 rounded-lg px-2 py-1 type-support"
          style={{ backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)', minHeight: 36 }}
        >
          <RefreshCw size={13} />
          {t('shell.reconnect')}
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="rounded-lg p-2"
          style={{ color: 'var(--text-muted)', minHeight: 36, minWidth: 36 }}
          aria-label={t('connection.dismiss')}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
