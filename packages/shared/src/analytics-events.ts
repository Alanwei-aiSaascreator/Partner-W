/**
 * 埋点事件白名单。
 *
 * ⚠️ 必须与迁移 48 的 `check (event in (...))` **逐字一致** ——
 * `analytics-events.test.ts` 直接读那份迁移文件比对，改动任一边都会红。
 *
 * 只收「主进程能钉住真实动作点」的事件：`agent_created` / `template_installed`
 * 等目前没有可依赖的成功回调，**刻意不收**
 * （加事件 = 迁移加一个名字 + **本常量加一个名字** + 一处调用，三处缺一不可）。
 */
export const ANALYTICS_EVENTS = [
  'app_launch',
  'login_success',
  'license_activated',
  'chat_sent',
  'first_chat_sent',
  'module_opened',
  'post_published',
  'team_joined',
  'bounty_published',
  'daily_check_in',
  'artifact_saved',
  'file_attached',
] as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number];

const SET: ReadonlySet<string> = new Set(ANALYTICS_EVENTS);

export function isAnalyticsEvent(value: unknown): value is AnalyticsEvent {
  return typeof value === 'string' && SET.has(value);
}

/** 一条待上报的事件。`clientEventId` 是幂等键：重传只落一行。 */
export interface QueuedAnalyticsEvent {
  clientEventId: string;
  event: AnalyticsEvent;
  occurredAt: string;
  props?: Record<string, string | number | boolean>;
}
