import { describe, expect, it } from 'vitest';
import { describePrivacyError } from '../src/services/privacy-error-message.js';

/**
 * 码 → 中文的对照表**逐字**钉住（不是"有文案就行"）：
 * 写错一个字就是用户看到一句错话，而这是隐私流程里唯一告诉用户
 * "为什么没成功"的东西。
 *
 * 码的来源（写测试时逐个 grep 过）：
 *   · 迁移 51 `privacy_rpcs.sql`（客户端工单）：not_authenticated /
 *     export_too_large / request_not_found / not_an_export_request /
 *     snapshot_missing / owner_transfer_required / not_a_deletion_request /
 *     invalid_state / cooldown_elapsed
 *   · 迁移 49 `analytics_rpcs.sql`：invalid_event / invalid_payload / rate_limited
 *   · 运营侧 RPC（计划 Task 11）：target_is_operator / reason_required
 *   · 客户端合成的码：network / unknown（handler 兜底）、cancelled（用户点了保存对话框的取消）、
 *     local_export_failed（本地组装/写盘失败 —— 磁盘满、无权限这类，**不是**网络问题）
 */

const TABLE: ReadonlyArray<readonly [string, string]> = [
  ['not_authenticated', '请先登录后再操作'],
  ['invalid_event', '事件名不在允许范围内'],
  ['invalid_payload', '上报的数据格式不正确'],
  ['rate_limited', '上报过于频繁，请稍后再试'],
  ['request_not_found', '没有找到这条申请'],
  ['not_an_export_request', '这条申请不是导出申请'],
  ['not_a_deletion_request', '这条申请不是删除申请'],
  ['snapshot_missing', '导出内容已过期，请重新申请'],
  ['request_not_downloadable', '这条申请当前不能下载，请刷新后重试'],
  ['export_too_large', '数据量较大，已转人工处理，我们会尽快联系你'],
  ['invalid_state', '当前状态不允许这个操作'],
  ['cooldown_elapsed', '冷却期已过，无法再撤回'],
  ['owner_transfer_required', '你是团队的创建者，请先移交或解散团队再删除账号'],
  ['target_is_operator', '该账号是运营账号，不能通过此流程删除'],
  ['reason_required', '请填写驳回理由'],
  ['cancelled', '已取消导出'],
  ['local_export_failed', '本地数据整理或写文件失败，请检查磁盘空间与保存位置后重试'],
  ['network', '网络连接失败，请检查网络后重试'],
  ['unknown', '操作失败，请稍后重试'],
];

describe('describePrivacyError —— 码 → 中文', () => {
  it.each(TABLE)('%s → 逐字对齐', (code, message) => {
    expect(describePrivacyError(code)).toBe(message);
  });

  it('认不出的码给兜底中文，绝不回显原文', () => {
    expect(describePrivacyError('some_new_code')).toBe('操作失败，请稍后重试');
    expect(describePrivacyError('owner_transfer_require')).toBe('操作失败，请稍后重试');
    expect(describePrivacyError('请先登录')).toBe('操作失败，请稍后重试');
  });

  it('空码也走兜底', () => {
    expect(describePrivacyError(null)).toBe('操作失败，请稍后重试');
    expect(describePrivacyError(undefined)).toBe('操作失败，请稍后重试');
    expect(describePrivacyError('')).toBe('操作失败，请稍后重试');
  });

  it('表里没有两条相同的码（复制粘贴改漏会静默盖掉一条）', () => {
    const codes = TABLE.map(([code]) => code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('原型链上的名字不当成码（`constructor`/`__proto__` 必须走兜底，不能返回函数/对象）', () => {
    // 查表若写成 `MESSAGES[key] ?? fallback`，这两个会命中原型链上的成员 ——
    // 而签名声称返回 string，界面会把函数渲染成崩溃或空白。
    expect(describePrivacyError('constructor')).toBe('操作失败，请稍后重试');
    expect(describePrivacyError('__proto__')).toBe('操作失败，请稍后重试');
    expect(describePrivacyError('toString')).toBe('操作失败，请稍后重试');
  });

  it('码两侧的空白被容忍（服务端原文可能带换行）', () => {
    expect(describePrivacyError(' not_authenticated\n')).toBe('请先登录后再操作');
  });
});
