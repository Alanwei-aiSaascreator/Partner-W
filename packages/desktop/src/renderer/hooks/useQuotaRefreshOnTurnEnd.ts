import { useEffect, useRef } from 'react';
import { useMessageStore } from '../stores/messageStore';
import { useCommercialStore } from '../stores/commercialStore';

/**
 * 一轮对话结束后把额度拉新的。
 *
 * 起因（2026-09-12）：服务端的扣费是准的，但界面只在**进账户页 / 切任务**时
 * 才重拉额度 —— 发完消息顶栏的数字纹丝不动，用户以为「没扣费」。
 * 而当时后台确实也没扣成（那是另一个 bug，见迁移 23）；这个钩子解决的是
 * 「扣了但你得切页面才看得见」。
 *
 * 两条设计约束：
 *
 * 1. **顺序不能反**：先 `commercialUsageReport()` 把本机累计量推上去，
 *    再 `refresh()` 拉服务端额度。走中转的调用服务端已经自己记了账，
 *    那一步是幂等的；但走本地 provider 的调用只有推上去才会计费。
 *    反过来的话，拉到的还是上一次推送前的旧值。
 *
 * 2. **必须防抖**：Ensemble 多 agent 协作会在一轮里连续产生多次
 *    processing 结束/开始，不防抖会打出十几个请求。800ms 是「人已经看到
 *    回复了、但不会和下一轮的开头撞上」的量级。
 *
 * ⚠️ 挂在 `MainArea`（常驻）而不是 `ChatHeader` —— 后者带着
 *    `key={chat-${activeTaskId}}`，切任务会重挂，重挂就会多触发一次。
 */
const SETTLE_MS = 800;

export function useQuotaRefreshOnTurnEnd(): void {
  // 任一会话在跑就算忙。用「集合是否为空」而不是逐个会话比较：
  // 后者在会话切换时会产生假的「结束」跳变。
  const busy = useMessageStore((s) => s.processingBySession.size > 0);
  const wasBusy = useRef(false);

  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    // 挂载时不触发 —— 那一刻并没有「刚结束一轮」这回事
    if (!wasBusy.current) return;
    wasBusy.current = false;

    // 未登录/无商业配置：不空跑。真实网络请求失败在 refresh 里静默吞掉。
    if (!useCommercialStore.getState().overview?.account) return;

    const timer = setTimeout(() => {
      void (async () => {
        try {
          await window.clawwork.commercialUsageReport();
        } catch {
          // 上报失败不影响下一步：refresh 仍然可能拿到服务端已经记好的账
        }
        await useCommercialStore.getState().refresh();
      })();
    }, SETTLE_MS);

    // 下一轮在 800ms 内开始的话，cleanup 会把这个定时器取消 —— 这正是防抖
    return () => clearTimeout(timer);
  }, [busy]);
}
