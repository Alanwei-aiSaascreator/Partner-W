import { BrowserWindow } from 'electron';
import { getWorkspaceScope } from '../workspace/scope.js';

/**
 * ⭐ 第二轮（R5 P1 收口）：**轮次登记回执** —— 主进程把"这一轮交付登记结束"的
 * 可信事实广播给渲染层。
 *
 * 背景（复审实跑反例）：`session-sync` 的 promote 在 create-message 持久化**之前**
 * 清掉 activeTurn；渲染层通知出口只凭"模型结束 + activeTurn 空 + 投影里恰好没有
 * operation"就判 complete 并弹"任务完成" —— 而此时 main 的登记
 * （`finalizeAssistantArtifacts` / 交付捕获）根本还没跑。空 operations 只代表
 * "登记证据未到"，不代表"这一轮不需要交付"。
 *
 * 本通道给渲染层提供不可推错的登记事实（与执行事件同款纪律）：
 *  - 载荷身份 = taskId/sessionKey/**runId** + **捕获时 workspace scope/revision**；
 *  - 无 runId / 无有效 scope（无库、无工作区）⇒ **拒发**（fail-closed，接收侧对
 *    无 scope 帧一律拒——发它只会制造注定被丢的帧）；
 *  - 渲染层只按它把完成资格从 'unknown' 推进到 registered/needs-review/none-expected。
 *
 * 语义分档：
 *  - `registered`：登记流程完成（operationId 已定号/作业已入交付通道）——需求集合 =
 *    投影中已到达的 operations（全部结算前不得判 complete）；
 *  - `needs-review`：已知文件需求存在但登记失败/交付上下文未确认（需求保留，
 *    不得回退成"明确零需求"）；
 *  - `none-expected`：可信请求事实确认零需求（普通聊天）。
 */
export const TURN_REGISTRATION_CHANNEL = 'artifact:turn-registration';

export type MainTurnRegistrationStatus = 'registered' | 'needs-review' | 'none-expected';

export interface MainTurnRegistrationPayload {
  taskId: string;
  sessionKey: string;
  runId: string;
  status: MainTurnRegistrationStatus;
  /** 登记时已核对的期望产物类型（诊断/测试用；判定仍以 projected operations 为准）。 */
  expectedKinds: string[];
  workspaceScope: string | null;
  workspaceRevision: number;
}

/**
 * 广播一条登记回执。返回是否真正送出（false = 身份不足被拒发）。
 * `runId` 为空一律拒发：回执的消费方按 `session|run` 归属，无归属的回执只会污染别的轮次。
 */
export function emitTurnRegistration(input: {
  taskId: string;
  sessionKey: string;
  runId?: string;
  status: MainTurnRegistrationStatus;
  expectedKinds?: readonly string[];
}): boolean {
  const runId = input.runId?.trim();
  if (!input.taskId || !input.sessionKey || !runId) return false;
  const owner = getWorkspaceScope();
  if (!owner.scope || !Number.isSafeInteger(owner.revision) || owner.revision < 0) return false;
  const payload: MainTurnRegistrationPayload = {
    taskId: input.taskId,
    sessionKey: input.sessionKey,
    runId,
    status: input.status,
    expectedKinds: [...(input.expectedKinds ?? [])],
    workspaceScope: owner.scope,
    workspaceRevision: owner.revision,
  };
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.webContents.isDestroyed()) window.webContents.send(TURN_REGISTRATION_CHANNEL, payload);
    } catch (error) {
      console.warn('[turn-registration] renderer unavailable:', error);
    }
  }
  return true;
}
