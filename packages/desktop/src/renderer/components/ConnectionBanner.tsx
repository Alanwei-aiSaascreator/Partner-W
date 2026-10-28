import { useEffect, useState } from 'react';
import { AlertTriangle, LoaderCircle, XCircle, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUiStore } from '../stores/uiStore';
import InlineNotice from '@/components/semantic/InlineNotice';
import ToolbarButton from '@/components/semantic/ToolbarButton';
import { STARTUP_GRACE_MS, deriveGatewayDisplayPhase } from '../lib/gateway-display-phase';

/**
 * 「正在启动」这句话最多说多久 —— 过了就改口成失败 + 给出口。
 *
 * ⚠️ 这是**兜底**：正常首启（首次部署 2–3 分钟 + 等就绪）不会撞上 6 分钟这个预算；
 *    撞上了就说明"这台机器上它已经不可能起来了"，那就不能再让用户对着"正在启动"等下去
 *    （那正是我们在别处反复修过的"永久 loading"）。
 */
function useStartupOverdue(active: boolean, graceMs = STARTUP_GRACE_MS): boolean {
  const [overdue, setOverdue] = useState(false);
  useEffect(() => {
    if (!active) {
      setOverdue(false);
      return;
    }
    const timer = window.setTimeout(() => setOverdue(true), graceMs);
    return () => window.clearTimeout(timer);
  }, [active, graceMs]);
  return active && overdue;
}

/**
 * 网关状态横幅。
 *
 * ⭐ 分档判据在 `lib/gateway-display-phase.ts`（纯函数，有单测）：**预热期**与**真断开**
 * 必须说两套话。实机现场（2026-09-20）：首启那 50 秒里横幅写着「网关"X"已断开，
 * 正在尝试重连… (0/10)」，同时准备面板写着「正在准备…」—— 用户以为坏了。
 */
export default function ConnectionBanner() {
  const { t } = useTranslation();
  const defaultGatewayId = useUiStore((s) => s.defaultGatewayId);
  const gatewayStatusMap = useUiStore((s) => s.gatewayStatusMap);
  const gatewayInfoMap = useUiStore((s) => s.gatewayInfoMap);
  const gatewayReconnectInfo = useUiStore((s) => s.gatewayReconnectInfo);
  const gatewayEverConnected = useUiStore((s) => s.gatewayEverConnected);
  const gatewaysLoaded = useUiStore((s) => s.gatewaysLoaded);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);

  const status = defaultGatewayId ? gatewayStatusMap[defaultGatewayId] : undefined;
  const reconnectInfo = defaultGatewayId ? gatewayReconnectInfo[defaultGatewayId] : undefined;
  // `?.`：手写 store 桩缺这个字段时按"从没连上过"算（那本来就是这个字段缺席的含义）。
  const everConnected = defaultGatewayId ? gatewayEverConnected?.[defaultGatewayId] === true : false;
  const phase = deriveGatewayDisplayPhase({ status, everConnected, reconnect: reconnectInfo });
  // ⚠️ 这个 hook 必须在任何 early return **之前**调用（hooks 顺序）。
  const startupOverdue = useStartupOverdue(phase === 'starting');

  if (!gatewaysLoaded) return null;

  const hasGateways = Object.keys(gatewayInfoMap).length > 0;

  if (!hasGateways) {
    return (
      <div className="px-4 pt-2">
        <InlineNotice
          tone="warning"
          action={
            <ToolbarButton size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
              {t('connection.addGateway')}
            </ToolbarButton>
          }
        >
          <span className="inline-flex items-center gap-3">
            <Server size={15} className="flex-shrink-0" />
            {t('connection.noGateway')}
          </span>
        </InlineNotice>
      </div>
    );
  }

  if (!defaultGatewayId || phase === 'live') return null;

  const gwName = gatewayInfoMap[defaultGatewayId]?.name ?? defaultGatewayId;
  const retryNow = (
    <ToolbarButton size="sm" variant="outline" onClick={() => window.clawwork.reconnectGateway(defaultGatewayId)}>
      {t('connection.retryNow')}
    </ToolbarButton>
  );
  const openSettings = (
    <ToolbarButton size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}>
      {t('connection.openSettings')}
    </ToolbarButton>
  );

  // ⭐ 还在启动窗口里（这次运行从没连上过）：说"正在启动"，**不说**"已断开"，
  //    也不显示那个看着像失败计数的 `(0/10)`。
  if (phase === 'starting' && !startupOverdue) {
    return (
      <div className="px-4 pt-2">
        <InlineNotice tone="warning">
          <span className="inline-flex items-center gap-2">
            <LoaderCircle size={13} className="flex-shrink-0 animate-spin motion-reduce:animate-none" />
            {t('connection.startingBanner')}
          </span>
        </InlineNotice>
      </div>
    );
  }

  // 启动预算用完了还没连上 —— 这时"正在启动"已经不再是真的说法，改成失败 + 出口。
  if (phase === 'starting') {
    return (
      <div className="px-4 pt-2">
        <InlineNotice
          tone="error"
          action={
            <div className="flex items-center gap-2">
              {retryNow}
              {openSettings}
            </div>
          }
        >
          <span className="inline-flex items-center gap-2">
            <XCircle size={13} className="flex-shrink-0" />
            {t('connection.startupFailedBanner')}
          </span>
        </InlineNotice>
      </div>
    );
  }

  if (phase === 'unreachable') {
    return (
      <div className="px-4 pt-2">
        <InlineNotice
          tone="error"
          action={
            <div className="flex items-center gap-2">
              {retryNow}
              {openSettings}
            </div>
          }
        >
          <span className="inline-flex items-center gap-2">
            <XCircle size={13} className="flex-shrink-0" />
            {t('connection.unreachableBanner', { name: gwName })}
          </span>
        </InlineNotice>
      </div>
    );
  }

  if (phase === 'retrying') {
    return (
      <div className="px-4 pt-2">
        <InlineNotice tone="warning">
          <span className="inline-flex items-center gap-2">
            <AlertTriangle size={13} className="flex-shrink-0" />
            {t('connection.reconnectingBanner', { name: gwName })}
            {/* ⚠️ 只在**真的重试过**（attempt > 0）之后才显示计数：`(0/10)` 读起来像
                "已经失败 0 次"，而它真正的意思是"一次都还没试"——那还叫重连吗。 */}
            {reconnectInfo &&
              reconnectInfo.attempt > 0 &&
              ` ${t('connection.attemptProgress', { attempt: reconnectInfo.attempt, max: reconnectInfo.max })}`}
          </span>
        </InlineNotice>
      </div>
    );
  }

  // 终态：连上过、现在断了，而且没有任何"正在重连"的信息 —— 必须给出口。
  return (
    <div className="px-4 pt-2">
      <InlineNotice
        tone="error"
        action={
          <div className="flex items-center gap-2">
            {retryNow}
            {openSettings}
          </div>
        }
      >
        <span className="inline-flex items-center gap-2">
          <XCircle size={13} className="flex-shrink-0" />
          {t('connection.disconnectedBanner', { name: gwName })}
        </span>
      </InlineNotice>
    </div>
  );
}
