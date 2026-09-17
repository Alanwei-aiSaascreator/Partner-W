import { ipcMain } from 'electron';
import { isAnalyticsEvent } from '@clawwork/shared';
import { trackEvent } from '../analytics/reporter.js';

/**
 * 渲染层唯一能主动送的埋点通道。
 *
 * 只收白名单里的事件名（`module_opened` 目前是唯一的使用者）：渲染层不能
 * 自定义事件名，否则看板会被前端随手加的名字污染，而白名单是**要改迁移**的。
 */
export function registerAnalyticsHandlers(): void {
  ipcMain.handle(
    'analytics:track',
    (_e, payload?: { event?: string; props?: Record<string, string | number | boolean> }) => {
      if (!isAnalyticsEvent(payload?.event)) {
        return { ok: false as const, errorCode: 'invalid_event' };
      }
      trackEvent(payload.event, payload.props);
      return { ok: true as const, result: null };
    },
  );
}
