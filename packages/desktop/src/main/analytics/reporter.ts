import { randomUUID } from 'node:crypto';
import { isAnalyticsEvent, type AnalyticsEvent, type QueuedAnalyticsEvent } from '@clawwork/shared';
import { getDebugLogger } from '../debug/index.js';

/**
 * 埋点上报器。
 *
 * 三条纪律（照 `commercial/usage-reporter.ts`）：
 *   · **绝不打断用户操作**：任何失败只 warn，不上抛、不 await 在关键路径上
 *   · **单飞**：并发 flush 只发一次
 *   · **丢了也不影响业务**：队列满了丢最旧的，事件不是账本
 *
 * 未登录时 `send` 会失败（`analytics_track` 要求 authenticated）⇒ 条目留在队列里，
 * 登录后自然补发；队列因此可能攒着未登录期间的事件，这是**有意**的。
 */

const DEFAULT_MAX = 500;
const BATCH = 50; // 与服务端 `v_len > 50 then invalid_payload` 对齐
const INTERVAL_MS = 60_000;
/** 服务端只收 `occurred_at ∈ [now()-30d, now()+1d]`；更老的条目**永远发不出去**，必须丢。 */
const MAX_EVENT_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface AnalyticsStorage {
  read(): string | null;
  write(value: string): void;
}

export interface AnalyticsSendResult {
  ok: boolean;
  inserted?: number;
  /**
   * 服务端**永久性**拒绝（`invalid_event` / `invalid_payload`）—— 重试永远不会成功。
   * 对这类失败必须**丢弃这一批**，否则一条「毒事件」会把队首永久卡住：
   * 批次整批被拒 ⇒ 整批留在队列 ⇒ 后面的事件永远排不到。
   */
  permanent?: boolean;
  errorCode?: string;
}

export interface AnalyticsReporterOptions {
  storage: AnalyticsStorage;
  send: (batch: QueuedAnalyticsEvent[]) => Promise<AnalyticsSendResult>;
  max?: number;
  now?: () => string;
  newId?: () => string;
}

interface Persisted {
  events: QueuedAnalyticsEvent[];
  chatSentCount: number;
}

export interface AnalyticsReporter {
  track(event: AnalyticsEvent, props?: QueuedAnalyticsEvent['props']): void;
  trackChatSent(): void;
  peek(): QueuedAnalyticsEvent[];
  flush(): Promise<void>;
}

export function createAnalyticsReporter(options: AnalyticsReporterOptions): AnalyticsReporter {
  const max = options.max ?? DEFAULT_MAX;
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => randomUUID());

  const state: Persisted = load(options.storage);
  let running = false;

  function load(storage: AnalyticsStorage): Persisted {
    try {
      const raw = storage.read();
      if (!raw) return { events: [], chatSentCount: 0 };
      const parsed = JSON.parse(raw) as Partial<Persisted>;
      const events = Array.isArray(parsed.events)
        ? parsed.events.filter(
            (e): e is QueuedAnalyticsEvent =>
              !!e &&
              typeof e === 'object' &&
              typeof (e as QueuedAnalyticsEvent).clientEventId === 'string' &&
              isAnalyticsEvent((e as QueuedAnalyticsEvent).event) &&
              typeof (e as QueuedAnalyticsEvent).occurredAt === 'string',
          )
        : [];
      return {
        events: events.slice(-max),
        chatSentCount: typeof parsed.chatSentCount === 'number' && parsed.chatSentCount >= 0 ? parsed.chatSentCount : 0,
      };
    } catch {
      return { events: [], chatSentCount: 0 };
    }
  }

  function persist(): void {
    try {
      options.storage.write(JSON.stringify(state));
    } catch (error) {
      getDebugLogger().warn({
        domain: 'analytics',
        event: 'analytics.persist-failed',
        data: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  function push(event: AnalyticsEvent, props?: QueuedAnalyticsEvent['props']): void {
    state.events.push({
      clientEventId: newId(),
      event,
      occurredAt: now(),
      ...(props ? { props } : {}),
    });
    if (state.events.length > max) state.events = state.events.slice(-max);
    persist();
  }

  return {
    track(event, props) {
      if (!isAnalyticsEvent(event)) return;
      push(event, props);
    },

    trackChatSent() {
      state.chatSentCount += 1;
      if (state.chatSentCount === 1) push('first_chat_sent');
      push('chat_sent');
    },

    peek: () => [...state.events],

    async flush() {
      if (running) return;
      running = true;
      try {
        // ① 先丢掉**永远不可能被接受**的条目：服务端只收 30 天内的 occurred_at，
        //    留着它们会让队首永久卡住（整批被拒 ⇒ 整批留在队列 ⇒ 后面全排不到）。
        //    典型来源：用户离线了很久，队列里攒着老事件。
        // 判超龄也用注入的时钟（与事件时间戳同源）——否则测试分辨不出实现用的是哪个时钟。
        const staleCutoff = Date.parse(now()) - MAX_EVENT_AGE_MS;
        const stale = state.events.filter((e) => Date.parse(e.occurredAt) < staleCutoff);
        if (stale.length > 0) {
          getDebugLogger().warn({
            domain: 'analytics',
            event: 'analytics.dropped-stale',
            data: { count: stale.length },
          });
          const staleIds = new Set(stale.map((e) => e.clientEventId));
          state.events = state.events.filter((e) => !staleIds.has(e.clientEventId));
          persist();
        }

        while (state.events.length > 0) {
          const batch = state.events.slice(0, BATCH);
          let result: AnalyticsSendResult;
          try {
            result = await options.send(batch);
          } catch (error) {
            getDebugLogger().warn({
              domain: 'analytics',
              event: 'analytics.flush-failed',
              data: { message: error instanceof Error ? error.message : String(error) },
            });
            return;
          }
          // ② 永久性拒绝 ⇒ **丢弃这批并继续**；临时性失败（网络/未登录/限流）⇒ 留着下次再发
          if (!result.ok) {
            if (!result.permanent) return;
            getDebugLogger().warn({
              domain: 'analytics',
              event: 'analytics.dropped-rejected',
              data: { count: batch.length, errorCode: result.errorCode },
            });
          }
          // 只移除**这一批**：flush 期间新入队的事件必须留着
          const ids = new Set(batch.map((e) => e.clientEventId));
          state.events = state.events.filter((e) => !ids.has(e.clientEventId));
          persist();
        }
      } finally {
        running = false;
      }
    },
  };
}

let active: { reporter: AnalyticsReporter; timer: ReturnType<typeof setInterval> } | null = null;

export function initAnalyticsReporter(
  storage: AnalyticsStorage,
  send: (batch: QueuedAnalyticsEvent[]) => Promise<AnalyticsSendResult>,
): AnalyticsReporter {
  if (active) return active.reporter;
  const reporter = createAnalyticsReporter({ storage, send });
  const timer = setInterval(() => {
    void reporter.flush();
  }, INTERVAL_MS);
  active = { reporter, timer };
  return reporter;
}

export function stopAnalyticsReporter(): void {
  if (!active) return;
  clearInterval(active.timer);
  void active.reporter.flush();
  active = null;
}

/** 埋点调用点用这个：没初始化时静默丢弃（测试环境不该炸）。 */
export function trackEvent(event: AnalyticsEvent, props?: QueuedAnalyticsEvent['props']): void {
  active?.reporter.track(event, props);
}

export function trackChatSent(): void {
  active?.reporter.trackChatSent();
}
