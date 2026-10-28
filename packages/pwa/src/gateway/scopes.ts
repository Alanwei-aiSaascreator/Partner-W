/**
 * 手机端（PWA）能拿到的**全部**权限。
 *
 * 见《Partner-W-手机网页远程控制-技术方案 v1.1》§6.3：
 * 手机只给 只读 + 写 + 审批，**绝不含** `operator.admin` / `operator.pairing`
 * —— 前者能改配置、装插件、读密钥、开终端；后者能让手机给自己或别的设备加权限。
 *
 * ⚠️ 这个常量是手机端的权限天花板，任何调用点都不许再往数组里追加 scope。
 *    需要更多权限时，改的是这份文件（并同步改方案 §6.3 与网关侧策略），
 *    不是在某个 client 里就地拼一个数组。
 */
export const PWA_OPERATOR_SCOPES: readonly string[] = [
  'operator.read',
  'operator.write',
  'operator.approvals',
  /**
   * 结构化提问（`ask_user`）**必须有这一条**，否则网关连事件都不发。
   *
   * 引擎 2026.9.3 的判据（运行时源码，非推断）：
   *   - `server-start`：`EVENT_SCOPE_GUARDS['question.requested' | 'question.resolved'] = [QUESTIONS_SCOPE]`
   *     —— `QUESTIONS_SCOPE = 'operator.questions'`，广播前先 `hasEventScope()` 过滤，
   *     不带这条 scope 的连接**根本收不到** `question.requested`（不是"收到但没渲染"）。
   *   - `method-scopes`：`question.request / waitAnswer / resolve / get / list` 同样要求
   *     `operator.questions` —— 少了它连作答都会被拒。
   *
   * 见 2026-10-21 的真机证据：同一条手机型连接（read/write/approvals）让 agent 调
   * `ask_user`，150 秒内 `question.requested` 一帧都没有；补上 `operator.questions`
   * 后同一脚本 15 秒就收到完整 payload（id / questions / options / sessionKey 都对得上）。
   *
   * ⚠️ 它不是 admin/pairing 那类越权项：只覆盖"向用户提问 + 收回作答"，
   * 与 `operator.approvals` 同级（详见方案 v1.1 §6.3 的分级表，本文件是权限天花板的唯一出口）。
   * ⚠️ 已配对的手机首次带这条 scope 连接时，网关会判 `scope upgrade` 并要求在电脑端
   * 待批列表里再批一次 —— 这是引擎的升级闸门，不是 bug。
   */
  'operator.questions',
];

/**
 * 协议协商区间。下限 3 是为了兼容老网关（连得上、但会提示更新），
 * 上限 4 是当前随包引擎（openclaw 2026.9.3）的能力。
 */
export const PWA_MIN_PROTOCOL = 3;
export const PWA_MAX_PROTOCOL = 4;

/** 认为"手机端功能完整体"的协议版本，低于它要提示更新电脑端。 */
export const PWA_REQUIRED_PROTOCOL = 4;
