import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QueuedAnalyticsEvent } from '@clawwork/shared';
import { getCommercialClient } from '../commercial/client.js';
import { getDebugLogger } from '../debug/index.js';
import { initAnalyticsReporter, stopAnalyticsReporter, trackEvent, type AnalyticsStorage } from './reporter.js';

/**
 * 把 `reporter.ts` 的队列接到**真实存储**与**真实 RPC** 上。
 *
 * 队列落盘在 userData 下：**不用** SQLite（那是任务/消息的库，加表要走它自己的迁移），
 * 也不用 localStorage（这段跑在主进程）。
 */
const FILE = 'analytics-queue.json';

function fileStorage(): AnalyticsStorage {
  const path = join(app.getPath('userData'), FILE);
  return {
    read: () => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    write: (value: string) => {
      try {
        writeFileSync(path, value, 'utf8');
      } catch (error) {
        getDebugLogger().warn({
          domain: 'analytics',
          event: 'analytics.queue-write-failed',
          data: { message: error instanceof Error ? error.message : String(error) },
        });
      }
    },
  };
}

/** 单次上报的超时上限（照 `commercial/usage-reporter.ts` 的做法，同一量级）。 */
const SEND_TIMEOUT_MS = 20_000;

/**
 * ⚠️ **必须带超时**：没有它的话，`client.rpc` 一旦永不 settle（本仓库有过「商业调用成串挂死」的历史），
 * reporter 的单飞标志就会**永久为 true** ⇒ 之后每次 flush（含 60 秒定时器）全是空转
 * ⇒ **本进程再也不会发任何埋点，而且不报任何错**。
 * ⚠️ 返回类型**必须**带上 `permanent` / `errorCode`：错误分支要返回它们，
 * 而 TS 对对象字面量有多余属性检查 —— 少写一个字段这一行就编译不过。
 */
async function sendBatch(batch: QueuedAnalyticsEvent[]): Promise<{
  ok: boolean;
  inserted?: number;
  permanent?: boolean;
  errorCode?: string;
}> {
  const client = getCommercialClient();
  // 未登录时**不丢**：返回 ok:false，条目留在队列里，登录后自然补发
  if (!client) return { ok: false };
  try {
    const rpc = client.rpc.bind(client);
    const { data, error } = await withTimeout(
      rpc('analytics_track', {
        p_events: batch.map((e) => ({
          client_event_id: e.clientEventId,
          event: e.event,
          occurred_at: e.occurredAt,
          app_version: app.getVersion(),
          platform: process.platform,
          props: e.props ?? {},
        })),
      }),
      SEND_TIMEOUT_MS,
    );
    if (error) {
      const code = (error.message ?? '').trim();
      // 服务端**永久性**拒绝：重试永远不会成功 ⇒ 让 reporter 丢掉这批。
      // ⚠️ `rate_limited` 与超时都是**临时**的，别归到这类（否则一次限流会白丢一批数据）。
      const permanent = code === 'invalid_event' || code === 'invalid_payload';
      return { ok: false, permanent, errorCode: code };
    }
    return { ok: true, inserted: typeof data === 'number' ? data : 0 };
  } catch (error) {
    getDebugLogger().warn({
      domain: 'analytics',
      event: 'analytics.track-failed',
      data: { message: error instanceof Error ? error.message : String(error) },
    });
    return { ok: false };
  }
}

/**
 * 与 `commercial/usage-reporter.ts` 里那个同款：**超时返回一个"失败"结果而不是抛**，
 * 让调用方走正常失败路径（队列留着、也不是永久失败）。`data?` 必须可选，
 * 否则 `const { data, error } = await withTimeout(...)` 那行过不了类型检查。
 */
type RpcOutcome = { data?: unknown; error: { message?: string } | null };

async function withTimeout<T extends RpcOutcome>(work: PromiseLike<T>, ms: number): Promise<T | RpcOutcome> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RpcOutcome>((resolve) => {
    handle = setTimeout(() => resolve({ error: { message: 'timeout' } }), ms);
  });
  try {
    return await Promise.race([Promise.resolve(work), timeout]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

export function setupAnalytics(): void {
  initAnalyticsReporter(fileStorage(), sendBatch);
  trackEvent('app_launch');
}

/**
 * 应用退出时调用（照 `destroyUsageReporter` 的位置挂）。
 * ⚠️ 不挂的话 `stopAnalyticsReporter` 就是**死代码**（`check:dead-code` 会把它算成未用导出），
 * 而且退出前那一次 flush 永远不会发生 —— 用户关掉应用的最后一个动作区间就白采了。
 */
export function teardownAnalytics(): void {
  stopAnalyticsReporter();
}
