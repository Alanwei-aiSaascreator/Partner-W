/**
 * 隐私工单的归一化。
 *
 * 三条纪律（与 community-service / growth-service 一致）：
 *   · PostgREST 会把 int 序列化成字符串 ⇒ 一律 Number()
 *   · 枚举越界降级成 'unknown'，不把脏值透给界面
 *   · 坏数据丢弃 / 降级，**不抛**（UI 不该因为一条脏字段整页崩）
 *
 * 字段名逐字对应迁移 51 `privacy_my_state()` 的返回：
 *   export.{id,status,requested_at,snapshot_bytes}
 *   deletion.{id,status,requested_at,scheduled_for,cancellable}
 *
 * ⚠️ 剩余天数**不由这里算**：服务端只给 `scheduled_for`（绝对时刻），
 *    倒计时交给渲染层现算，免得归一化结果一缓存就变成骗人的天数。
 */

export type PrivacyRequestStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'completed'
  | 'cancelled'
  | 'rejected'
  | 'failed'
  | 'unknown';

export interface PrivacyExportState {
  id: string;
  status: PrivacyRequestStatus;
  requestedAt: string;
  snapshotBytes: number | null;
}

export interface PrivacyDeletionState {
  id: string;
  status: PrivacyRequestStatus;
  requestedAt: string;
  scheduledFor: string | null;
  cancellable: boolean;
}

export interface PrivacyState {
  export: PrivacyExportState | null;
  deletion: PrivacyDeletionState | null;
}

/**
 * 删除申请落到 `privacy_requests.note` 的**审计口径**：固定机器码，**不是**界面文案。
 *
 * ⚠️ 以前这一格发的是 `privacy.deletionReason`（当前语言的 UI 文案）⇒ 用户换个语言，
 *    运营在后台看到的"理由"就跟着变，审计口径不是稳定的东西。机器码只此一处定义，
 *    main 与渲染层共用，改码名 = 改口径（迁移 51 的 `left(coalesce(p_reason,''),500)`
 *    原样收下，不做语义校验）。
 * 人类可读的理由另走可选字段（`reason`），界面目前不收集它 ⇒ 让出（见 privacy-handlers.ts）。
 */
export const DELETION_REQUEST_NOTE = 'user_requested';

/** 与迁移 50 的 `check (status in (...))` 逐字对齐；'unknown' 是客户端降级态，不在此列。 */
const STATUSES: readonly PrivacyRequestStatus[] = [
  'pending',
  'processing',
  'ready',
  'completed',
  'cancelled',
  'rejected',
  'failed',
];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function count(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

function status(value: unknown): PrivacyRequestStatus {
  const raw = text(value);
  return raw && (STATUSES as readonly string[]).includes(raw) ? (raw as PrivacyRequestStatus) : 'unknown';
}

export function normalizePrivacyState(raw: unknown): PrivacyState {
  const root = record(raw);
  if (!root) return { export: null, deletion: null };

  const exportRow = record(root.export);
  const deletionRow = record(root.deletion);
  const exportId = exportRow ? text(exportRow.id) : null;
  const deletionId = deletionRow ? text(deletionRow.id) : null;

  return {
    export:
      exportRow && exportId
        ? {
            id: exportId,
            status: status(exportRow.status),
            requestedAt: text(exportRow.requested_at) ?? '',
            snapshotBytes: count(exportRow.snapshot_bytes),
          }
        : null,
    deletion:
      deletionRow && deletionId
        ? {
            id: deletionId,
            status: status(deletionRow.status),
            requestedAt: text(deletionRow.requested_at) ?? '',
            scheduledFor: text(deletionRow.scheduled_for),
            // 只认真布尔：服务端序列化成字符串时**不能**当 true
            cancellable: deletionRow.cancellable === true,
          }
        : null,
  };
}
