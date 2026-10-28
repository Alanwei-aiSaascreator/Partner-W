import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { RelayLivenessPublicState } from '@clawwork/shared';
import InlineNotice from '@/components/semantic/InlineNotice';
import ToolbarButton from '@/components/semantic/ToolbarButton';
import { deriveRelayConnectionNotice } from '@/lib/relay-connection-notice';

/**
 * relay（商业服务）**运行期断开**的横幅（2026-10-03 真机缺口：杀了 8791 工作台无感）。
 *
 * ⚠️ 刻意**不锁输入框**：缺口在"无感"，不在"可用"——本地功能（历史 / 文件）照用，
 *    发送失败时既有错误路径照旧。与网关横幅的分工：那条断=全停（所以离线只读），
 *    这条断=模型调用会失败（所以只明示 + 给重试）。
 *
 * 事件纪律与 `useStartupReadiness` 的 relay 订阅完全一致：**先订阅、后补读、按
 * `updatedAt` 取舍**（晚到的旧结论不许把新的翻回去；内容相同的事件可能重复发）。
 */
function useRelayLiveness(): RelayLivenessPublicState | null {
  const [state, setState] = useState<RelayLivenessPublicState | null>(null);
  useEffect(() => {
    const api = window.clawwork;
    // ⚠️ 可选调用：这个方法比有些宿主新，缺了不许把整块横幅带崩。
    if (typeof api?.onCommercialRelayLivenessState !== 'function') return;
    let active = true;
    const accept = (next: RelayLivenessPublicState): void => {
      setState((current) => (current && current.updatedAt >= next.updatedAt ? current : next));
    };
    const unsubscribe = api.onCommercialRelayLivenessState((next) => {
      if (active) accept(next);
    });
    void api
      .commercialRelayLivenessState()
      .then((result) => {
        if (!active) return;
        // ⚠️ 读不到 = **没有结论**，不是"出错了"：什么都不改。
        if (result?.ok && result.result) accept(result.result);
      })
      .catch(() => {
        // 初始读这条路不可用，不该在界面上变成一条失败结论。
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return state;
}

export default function RelayConnectionBanner() {
  const { t } = useTranslation();
  const liveness = useRelayLiveness();
  const notice = deriveRelayConnectionNotice({ liveness });
  if (!notice) return null;
  return (
    <div className="px-4 pt-2">
      <InlineNotice
        tone="warning"
        action={
          <ToolbarButton
            size="sm"
            variant="outline"
            onClick={() => void window.clawwork.commercialRelayLivenessProbe()}
          >
            {t('connection.retryNow')}
          </ToolbarButton>
        }
      >
        <span className="inline-flex items-center gap-2">
          <AlertTriangle size={13} className="flex-shrink-0" />
          {t(notice.textKey)}
        </span>
      </InlineNotice>
    </div>
  );
}
