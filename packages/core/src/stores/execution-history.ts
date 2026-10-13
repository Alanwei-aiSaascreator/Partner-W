import type { ExecutionEvent, ExecutionEventType } from '../protocol/execution-events.js';
import { stepKeyOf } from './execution-projection.js';

/**
 * V4（2026-10-13 step 5）· 执行历史的**事件选择**（core 侧纯函数）。
 *
 * 口径（计划 114–122 + 05 §4）：只保存**已收到的状态边缘**、稳定事件 ID、
 * 必要关联与**脱敏摘要** —— 不保存高频累计 thinking 正文（V2 起根本不映射）、
 * 不保存原始参数；连续累计快照不线性保存完整全文（同 step 进度只留最新）。
 * 写入侧（main `execution/history.ts`）用 `executionEventPriority` 在队列/预算
 * 耗尽时**先丢进度、终态/审批/取消不丢**。
 */

/** 单条记录字节预算（设计值；离线测量核定后改这里）。 */
export const EXECUTION_HISTORY_ENTRY_BUDGET_BYTES = 4096;
/** 脱敏摘要字符上限。 */
export const EXECUTION_HISTORY_SUMMARY_LIMIT = 200;
/** 单 run 字节预算。 */
export const EXECUTION_HISTORY_RUN_BUDGET_BYTES = 2 * 1024 * 1024;
/** 待写队列条数/字节预算。 */
export const EXECUTION_HISTORY_QUEUE_LIMIT_ENTRIES = 512;
export const EXECUTION_HISTORY_QUEUE_BUDGET_BYTES = 2 * 1024 * 1024;
/** 专用目录总量预算。 */
export const EXECUTION_HISTORY_DIR_BUDGET_BYTES = 64 * 1024 * 1024;
/** 保留天数（只清理本模块自有的 ndjson 文件）。 */
export const EXECUTION_HISTORY_RETENTION_DAYS = 7;

export type ExecutionHistoryPriority = 'terminal' | 'progress';

/** 终态/审批/取消优先于进度 —— 队列溢出时从尾部（进度）开始丢。 */
export function executionEventPriority(type: ExecutionEventType): ExecutionHistoryPriority {
  switch (type) {
    case 'step.result':
    case 'approval.requested':
    case 'approval.resolved':
    case 'cancel.requested':
    case 'cancel.confirmed':
    case 'cancel.unconfirmed':
    case 'delivery.settled':
    case 'model.ended':
    case 'model.failed':
    case 'evidence.gap':
      return 'terminal';
    default:
      return 'progress';
  }
}

export interface SelectHistoryOptions {
  /** 公共脱敏（`sanitizeForLog` 注入，保持本模块纯函数）。 */
  sanitize: (text: string) => string;
  maxEntryBytes?: number;
  summaryLimit?: number;
}

export interface HistorySelection {
  /** 脱敏后的可持久化事件（= ExecutionEvent，payload 已脱敏/截断）。 */
  records: ExecutionEvent[];
  /** 因进度合并/预算被丢弃的条数（writer 侧据 gap 语义另记）。 */
  dropped: number;
}

function sanitizeRecord(event: ExecutionEvent, options: Required<SelectHistoryOptions>): ExecutionEvent {
  switch (event.type) {
    case 'step.declared': {
      const { args: _args, ...payload } = event.payload;
      void _args;
      return { ...event, payload };
    }
    case 'step.result': {
      const { resultText, ...rest } = event.payload;
      const summary =
        resultText !== undefined ? options.sanitize(resultText).slice(0, options.summaryLimit) : undefined;
      return {
        ...event,
        payload: { ...rest, ...(summary !== undefined && summary !== '' ? { resultText: summary } : {}) },
      };
    }
    default:
      return event;
  }
}

export function selectHistoryEvents(
  events: readonly ExecutionEvent[],
  options: SelectHistoryOptions,
): HistorySelection {
  const full: Required<SelectHistoryOptions> = {
    sanitize: options.sanitize,
    maxEntryBytes: options.maxEntryBytes ?? EXECUTION_HISTORY_ENTRY_BUDGET_BYTES,
    summaryLimit: options.summaryLimit ?? EXECUTION_HISTORY_SUMMARY_LIMIT,
  };

  // 第一步：按 step 合并进度（同 stepKey 只留最新；终态到达后丢弃更早进度；
  // 终态与终态都保留 —— 都是状态边缘）。
  const byStep = new Map<string, { index: number; priority: ExecutionHistoryPriority }>();
  const kept: ExecutionEvent[] = [];
  let mergedAway = 0;

  for (const event of events) {
    const sanitized = sanitizeRecord(event, full);
    const stepId =
      sanitized.type === 'step.declared' || sanitized.type === 'step.dispatched' || sanitized.type === 'step.result'
        ? sanitized.payload.toolCallId
        : undefined;
    if (stepId === undefined) {
      kept.push(sanitized);
      continue;
    }
    const stepKey = stepKeyOf(
      sanitized.source.gatewayId,
      sanitized.source.nativeSessionKey,
      sanitized.source.nativeRunId,
      stepId,
    );
    const priority = executionEventPriority(sanitized.type);
    const existing = byStep.get(stepKey);
    if (existing) {
      if (existing.priority === 'progress' && priority === 'progress') {
        kept[existing.index] = sanitized; // 进度合并：只留最新
        mergedAway += 1;
        continue;
      }
      if (existing.priority === 'terminal' && priority === 'progress') {
        mergedAway += 1; // 终态之后不再存进度
        continue;
      }
      // 终态到达：替换更早的进度；或终态+终态：都保留
      if (existing.priority === 'progress') {
        kept[existing.index] = sanitized;
        mergedAway += 1;
      } else {
        kept.push(sanitized);
      }
      byStep.set(stepKey, { index: kept.length - 1, priority });
      continue;
    }
    byStep.set(stepKey, { index: kept.length, priority });
    kept.push(sanitized);
  }

  // 第二步：单条预算（≤ maxEntryBytes）。超限先截摘要、再丢摘要、仍超则丢整条。
  const records: ExecutionEvent[] = [];
  let dropped = mergedAway;
  for (const record of kept) {
    if (JSON.stringify(record).length <= full.maxEntryBytes) {
      records.push(record);
      continue;
    }
    if (record.type === 'step.result' && record.payload.resultText !== undefined) {
      const shortened: ExecutionEvent = {
        ...record,
        payload: { ...record.payload, resultText: record.payload.resultText.slice(0, 80) },
      };
      if (JSON.stringify(shortened).length <= full.maxEntryBytes) {
        records.push(shortened);
        continue;
      }
      const bare: ExecutionEvent = {
        ...record,
        payload: { ...record.payload, resultText: undefined },
      };
      if (JSON.stringify(bare).length <= full.maxEntryBytes) {
        records.push(bare);
        continue;
      }
    }
    dropped += 1;
  }

  // 第三步（history-order，2026-10-14 修正）：**不再按 priority / seq 重排批次**。
  //
  // 旧口径"终态在前，writer 溢出时从尾部丢"把两个概念捆在一起，代价是**持久化顺序
  // ≠ 消费顺序**：同一批里 requested → confirmed 这类同 run 多事件被倒装，恢复重放
  // 会得到与现场不同的投影；而跨生产者/重建后的 `seq` 根本不是同一计数域（dispatcher
  // 与 main 各从 0 起），拿它当序也是错的。
  // 现在：**保持输入（接收）顺序落盘**；溢出丢载由 writer 按每条记录自带的
  // `executionEventPriority` 自行扫描（见 main/execution/history.ts 的 enqueue）。
  return { records, dropped };
}
