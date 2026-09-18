import { useEffect } from 'react';
import { createModuleOpenTracker, sendModuleOpened } from '@/lib/module-open-tracking';
import { useUiStore } from '@/stores/uiStore';

/**
 * 切换主视图时上报 `module_opened`（渲染层唯一一处埋点调用点）。
 *
 * ⚠️ 刻意读 `mainView` 而**不是**在每个 `setMainView` 调用点各包一层：调用点有十几处
 *    （侧栏 `onSelectView`、命令面板、`useKeyboardShortcuts`、`CronRunHistory`、
 *    `FileBrowser`、`TeamsPanel`、`MainArea`、托盘/通知导航、平台层 `onTaskCreated`…），
 *    漏一个就少记一种用户路径，而且以后新增入口还会继续漏。`mainView` 是它们的
 *    唯一汇合点 —— 谁调用 `setMainView` 都逃不出这个订阅。
 *
 * ⚠️ 单例建在**模块顶层**：节流表在 `createModuleOpenTracker` 的闭包里，必须活过
 *    组件重挂载（`test/module-open-tracking.test.tsx` 有专门的用例）。
 *
 * 语义：挂载时按当前视图记一次（应用打开落在哪个模块也算「打开」），之后同一个
 * 模块 60 秒内不再重复；值没变的重设不算切换。
 */
const trackModuleOpened = createModuleOpenTracker({ now: () => Date.now(), send: sendModuleOpened });

export function useModuleOpenTracking(): void {
  const mainView = useUiStore((s) => s.mainView);

  useEffect(() => {
    trackModuleOpened(mainView);
  }, [mainView]);
}
