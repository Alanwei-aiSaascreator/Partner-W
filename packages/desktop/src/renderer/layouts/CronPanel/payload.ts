import type { CronPayload } from '@clawwork/shared';

/**
 * 取定时任务 payload 的「人话预览」。
 *
 * ## 为什么必须是全函数（不能抛）
 *
 * **网关的 payload 种类比我们的类型多。** 2026-09-11 实测线上任务：
 *
 * ```json
 * "payload": { "kind": "heartbeat" }
 * ```
 *
 * 我们 fork 时的 `CronPayload` 只认 `systemEvent` / `agentTurn`，而旧实现是
 *
 * ```ts
 * const raw = payload.kind === 'systemEvent' ? payload.text : payload.message;
 * return raw.length > 60 ? ... : raw;      // ← heartbeat 落到这里 = undefined.length
 * ```
 *
 * → 点「定时任务」**整个面板白屏**，报
 * `Cannot read properties of undefined (reading 'length')`。
 *
 * 这类「上游加枚举值、前端只认旧的」会反复发生，所以这里的契约是：
 * **认识的 kind 取对应字段，不认识的原样显示 kind，永不抛。**
 * 显示 `heartbeat` 比白屏有用得多 —— 至少看得出是哪种任务、能去查。
 */
export function cronPayloadPreview(payload: CronPayload | undefined | null): string {
  if (!payload) return '';

  switch (payload.kind) {
    case 'systemEvent':
      return payload.text ?? '';
    case 'agentTurn':
      return payload.message ?? '';
    default:
      // 未知种类：显示 kind 本身。它是排障线索，不是一个错误。
      return String((payload as { kind?: unknown }).kind ?? '');
  }
}
