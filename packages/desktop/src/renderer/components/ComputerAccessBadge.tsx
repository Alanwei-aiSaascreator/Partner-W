import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Zap } from 'lucide-react';
import { findPermissionMode, isFullAccessMode } from '@/lib/session-permission-mode';

/**
 * 「全权」徽章 —— 当前这个任务的会话**真的**是全权时才显示。
 *
 * ⚠️ 值来自 `sessions.list` 读回来的 `permissionMode`，**不是**设置里那个开关。
 *    两者会漂，而且漂的方向恰好是最危险的那一边：
 *    **在任务 A 里开了全权、切到任务 B 把开关关掉 —— A 仍然是 full。**
 *    只显示开关的猜测，用户在 A 里就看不见"这个任务还能碰整台电脑"。
 *
 * ⚠️ 只在**全权**时显示（不是"常显"）：安全档是这个产品的默认状态，
 *    在输入框那一行常驻一个「默认安全」等于往最常看的地方加噪音。
 *    档位的完整说明在设置页里，那里两种状态都写着。
 *
 * ⚠️ 读不到（掉线 / 抛错 / 没有当前任务）**一律不显示**，而且**不抛**：
 *    "读不到"绝不能被画成"全权"，也不该把输入框带崩。
 */
export default function ComputerAccessBadge({
  gatewayId,
  sessionKey,
}: {
  gatewayId: string | null | undefined;
  sessionKey: string | null | undefined;
}) {
  const { t } = useTranslation();
  const [fullAccess, setFullAccess] = useState(false);

  useEffect(() => {
    if (!gatewayId || !sessionKey) {
      setFullAccess(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await window.clawwork.listSessions(gatewayId);
        if (cancelled) return;
        // 两种包法都见过：`{ok, result}` 里 result 可能是 `{sessions:[…]}` 也可能是裸数组。
        const rows = res && typeof res === 'object' && 'result' in res ? res.result : res;
        setFullAccess(isFullAccessMode(findPermissionMode(rows, sessionKey)));
      } catch {
        if (!cancelled) setFullAccess(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gatewayId, sessionKey]);

  if (!fullAccess) return null;

  return (
    <span
      data-field="computer-access-badge"
      title={t('computerAccess.badgeTitle')}
      className="inline-flex items-center gap-1 rounded-md bg-[var(--bg-warning)] px-2 py-1 type-badge text-[var(--warning)]"
    >
      <Zap size={13} aria-hidden="true" />
      {t('computerAccess.stateOn')}
    </span>
  );
}
