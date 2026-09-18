import { ipcMain } from 'electron';
import { isAnalyticsEvent } from '@clawwork/shared';
import { trackEvent } from '../analytics/reporter.js';

/**
 * 渲染层唯一能主动送的埋点通道。
 *
 * 只收白名单里的事件名（`module_opened` 目前是唯一的使用者）：渲染层不能
 * 自定义事件名，否则看板会被前端随手加的名字污染，而白名单是**要改迁移**的。
 */

/**
 * `props` 同样**不能原样信任**（渲染层是本进程唯一的不可信来源）：
 *   · 服务端 `analytics_events` 卡 `pg_column_size(props) <= 1024`，超了抛 `invalid_payload`，
 *     而上报器把 `invalid_payload` 判为**永久拒绝 ⇒ 整批（最多 50 条）一起丢** ——
 *     一个坏 props 会让同批 49 条健康事件陪葬；
 *   · 循环引用 / BigInt 这类值连 `JSON.stringify` 都过不去，会在上报器里变成
 *     「落盘失败 + 队首卡死」的毒条目（Task 5 的毒条目防护只覆盖服务端拒绝这一路）。
 * 所以这里只放行**标量**键值，并按序列化字节数卡上限（服务端按 jsonb 体积算，
 * 与 JSON 字节数不完全相等 ⇒ 取一半留余量）。超限时**丢 props、保事件**。
 */
const MAX_PROPS_BYTES = 512;

function sanitizeProps(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' || typeof raw === 'boolean') {
      out[key] = raw;
    } else if (typeof raw === 'number' && Number.isFinite(raw)) {
      out[key] = raw;
    }
    // 其余（嵌套对象/数组/BigInt/null/undefined/函数）一律丢弃
  }
  const keys = Object.keys(out);
  if (keys.length === 0) return undefined;
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_PROPS_BYTES) return undefined;
  return out;
}

export function registerAnalyticsHandlers(): void {
  ipcMain.handle('analytics:track', (_e, payload?: { event?: string; props?: unknown }) => {
    if (!isAnalyticsEvent(payload?.event)) {
      return { ok: false as const, errorCode: 'invalid_event' };
    }
    trackEvent(payload.event, sanitizeProps(payload?.props));
    return { ok: true as const, result: null };
  });
}
