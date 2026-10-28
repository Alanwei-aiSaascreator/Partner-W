import { create } from 'zustand';
import { parseTaskIdFromSessionKey } from '@clawwork/shared';
import type { ApprovalDecision, ExecApprovalRequest } from '@clawwork/shared';
import { getClient } from '../gateway/client-registry';
import { toast } from 'sonner';
import i18next from 'i18next';

type PendingApproval = ExecApprovalRequest & { gatewayId: string; taskId: string | null };

/**
 * 任务反查 / 未读标记由 `stores/index.ts` 注入（与 questionStore 同款，
 * 防 `hooks.ts` ↔ `index.ts` ↔ 本模块三方循环 → 启动即黑屏，2026-10-21 真机踩到）。
 */
let lookupTaskId: (sessionKey: string) => string | null = () => null;

interface ApprovalUi {
  activeTaskId: () => string | null;
  markUnread: (taskId: string) => void;
  clearUnread: (taskId: string) => void;
}

let approvalUi: ApprovalUi = {
  activeTaskId: () => null,
  markUnread: () => undefined,
  clearUnread: () => undefined,
};

export function bindApprovalTaskLookup(fn: (sessionKey: string) => string | null): void {
  lookupTaskId = fn;
}

export function bindApprovalUi(ui: ApprovalUi): void {
  approvalUi = ui;
}

function resolveTaskId(sessionKey?: string | null): string | null {
  if (!sessionKey) return null;
  const taskId = parseTaskIdFromSessionKey(sessionKey);
  if (!taskId) return null;
  // 认不出任务就不挂 unread（面板照常显示——审批不能因为反查失败被静默丢掉）。
  return lookupTaskId(sessionKey);
}

const expireTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useApprovalStore = create<{
  pendingApprovals: PendingApproval[];
  addApproval: (gatewayId: string, req: ExecApprovalRequest) => void;
  /** 按 **gateway + id** 匹配（相同 approvalId 来自不同 gateway 不串）。 */
  removeApproval: (gatewayId: string, id: string) => void;
  resolveApproval: (id: string, decision: ApprovalDecision) => Promise<void>;
  clear: () => void;
}>((set, get) => ({
  pendingApprovals: [],

  addApproval(gatewayId, req) {
    if (get().pendingApprovals.some((a) => a.id === req.id && a.gatewayId === gatewayId)) return;
    const taskId = resolveTaskId(req.request.sessionKey);
    if (taskId && taskId !== approvalUi.activeTaskId()) {
      approvalUi.markUnread(taskId);
    }
    set((s) => ({ pendingApprovals: [...s.pendingApprovals, { ...req, gatewayId, taskId }] }));
    const ttl = req.expiresAtMs - Date.now();
    if (ttl > 0) {
      const timerKey = `${gatewayId}:${req.id}`;
      expireTimers.set(
        timerKey,
        setTimeout(() => {
          expireTimers.delete(timerKey);
          get().removeApproval(gatewayId, req.id);
        }, ttl),
      );
    }
  },

  removeApproval(gatewayId, id) {
    const sameApproval = (a: PendingApproval): boolean => a.id === id && a.gatewayId === gatewayId;
    const approval = get().pendingApprovals.find(sameApproval);
    if (approval?.taskId && !get().pendingApprovals.some((a) => !sameApproval(a) && a.taskId === approval.taskId)) {
      approvalUi.clearUnread(approval.taskId);
    }
    const timerKey = `${gatewayId}:${id}`;
    clearTimeout(expireTimers.get(timerKey));
    expireTimers.delete(timerKey);
    set((s) => ({ pendingApprovals: s.pendingApprovals.filter((a) => !sameApproval(a)) }));
  },

  async resolveApproval(id, decision) {
    const approval = get().pendingApprovals.find((a) => a.id === id);
    if (!approval) return;
    const client = getClient(approval.gatewayId);
    if (!client?.isConnected) {
      toast.error(i18next.t('approval.resolveFailed', { defaultValue: '提交失败，请检查连接后重试。' }));
      return;
    }
    try {
      // 与桌面端同参数（ws-handlers.ts 的 ws:exec-approval-resolve 同款）：
      // 方法只需 operator.approvals scope（主连接已有），副连接只负责**收**事件。
      await client.sendReq('exec.approval.resolve', {
        id,
        decision,
      });
      get().removeApproval(approval.gatewayId, id);
    } catch {
      toast.error(i18next.t('approval.resolveFailed', { defaultValue: '提交失败，请重试。' }));
    }
  },

  clear() {
    for (const timer of expireTimers.values()) {
      clearTimeout(timer);
    }
    expireTimers.clear();
    set({ pendingApprovals: [] });
  },
}));
