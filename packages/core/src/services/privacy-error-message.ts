/**
 * 错误码 → 中文。**刻意不走 i18n**（与 describeCommunityError / describeGrowthError 一致）：
 * 这些码来自数据库 raise exception，是运维/客服对得上的稳定标识，翻成 9 种语言反而对不上账。
 *
 * 码必须与迁移 51 里的 `raise exception '<码>'` **逐字对齐**（客户端工单那条路）：
 *   not_authenticated / export_too_large / request_not_found / not_an_export_request /
 *   snapshot_missing / owner_transfer_required / not_a_deletion_request / invalid_state /
 *   cooldown_elapsed / request_not_downloadable
 * 另有几组码不在这两份迁移里：
 *   · invalid_event / invalid_payload / rate_limited —— 迁移 49（埋点上报）
 *   · network / unknown —— handler 兜底（`privacy-handlers.ts`）
 *   · cancelled —— 用户在保存对话框点了取消，handler 如实回这个码让界面安静收场
 *   · local_export_failed —— **本地**那一半失败（组装读库 / 写文件：磁盘满、无权限、
 *     保存位置不可写）。它**不是**网络问题：说成 network 会让用户去反复重试网络，
 *     而真正该做的是换保存位置 / 清磁盘空间
 *   · target_is_operator / reason_required —— **只在计划 Task 11**（运营侧 RPC 尚未落库），
 *     落地时必须逐字核对；`cooldown_active` / `invalid_status` 同理（后两条客户端不可达、
 *     仅运营后台可见，标准中文在 growth / agent-template 两份表里已有先例：'不支持的状态。'）
 * 改码名就是改客户端文案，两边都有人手写；认不出的码一律走兜底，绝不回显机器码。
 * `privacy-migration-consistency.test.ts` 会**读迁移文件**把这条锁死（漏码 = 测试红）。
 */
const MESSAGES: Record<string, string> = {
  not_authenticated: '请先登录后再操作',
  invalid_event: '事件名不在允许范围内',
  invalid_payload: '上报的数据格式不正确',
  rate_limited: '上报过于频繁，请稍后再试',
  request_not_found: '没有找到这条申请',
  not_an_export_request: '这条申请不是导出申请',
  not_a_deletion_request: '这条申请不是删除申请',
  snapshot_missing: '导出内容已过期，请重新申请',
  request_not_downloadable: '这条申请当前不能下载，请刷新后重试',
  export_too_large: '数据量较大，已转人工处理，我们会尽快联系你',
  invalid_state: '当前状态不允许这个操作',
  cooldown_elapsed: '冷却期已过，无法再撤回',
  owner_transfer_required: '你是团队的创建者，请先移交或解散团队再删除账号',
  target_is_operator: '该账号是运营账号，不能通过此流程删除',
  reason_required: '请填写驳回理由',
  cancelled: '已取消导出',
  local_export_failed: '本地数据整理或写文件失败，请检查磁盘空间与保存位置后重试',
  network: '网络连接失败，请检查网络后重试',
  unknown: '操作失败，请稍后重试',
};

export function describePrivacyError(code: string | null | undefined): string {
  const key = (code ?? '').trim();
  // ⚠️ 不能写 `MESSAGES[key] ?? fallback`：查表会走原型链，`constructor` / `__proto__`
  //    这类码会命中 Object.prototype 上的成员（函数/对象），而签名声称返回 string。
  const message = Object.prototype.hasOwnProperty.call(MESSAGES, key) ? MESSAGES[key] : undefined;
  return message ?? MESSAGES.unknown;
}
