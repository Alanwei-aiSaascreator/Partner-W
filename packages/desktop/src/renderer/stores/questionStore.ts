import { create } from 'zustand';
import { parseTaskIdFromSessionKey } from '@clawwork/shared';
import {
  buildAppError,
  buildQuestionCancelParams,
  buildQuestionResolveParams,
  describeQuestionFailure,
  formatErrorForToast,
  isQuestionExpired,
  parseQuestionRequest,
  resolveQuestionSelection,
  type QuestionRequest,
  type QuestionSelection,
} from '@clawwork/core';
import { toast } from '@/lib/toast';
import i18n from '../i18n';
import { useTaskStore } from './taskStore';
import { useUiStore } from './uiStore';

/**
 * 网关结构化提问（openclaw `ask_user`）的客户端状态。
 *
 * 背景：**这条链路以前整个不存在**。网关把问题挂起后，同一 session 里用户发的
 * 任何消息都会被网关当作「答案」吞掉，15 分钟内会话对用户静默——就是 2026-09-17
 * 那次「Word 任务锁死」。所以这里的职责不只是展示，还包括：
 * - 收齐**全部**必答项才允许提交（少一个是网关直接拒）；
 * - 用户没答完时给中文提示，且**不能出现 `doc_type` 这类内部字段名**；
 * - 失败/超时/换会话后不留下点不开的残留卡片。
 */

type PendingQuestion = QuestionRequest & { gatewayId: string; taskId: string | null };

const expireTimers = new Map<string, ReturnType<typeof setTimeout>>();

function resolveTaskId(sessionKey?: string | null): string | null {
  if (!sessionKey) return null;
  const taskId = parseTaskIdFromSessionKey(sessionKey);
  if (!taskId) return null;
  const tasks = useTaskStore.getState().tasks;
  return tasks.some((task) => task.id === taskId) ? taskId : null;
}

export const useQuestionStore = create<{
  pendingQuestions: PendingQuestion[];
  addQuestion: (gatewayId: string, payload: unknown) => void;
  removeQuestion: (id: string) => void;
  reconcileQuestions: (gatewayId: string, payloads: unknown[]) => void;
  resolveQuestion: (id: string, selection: QuestionSelection) => Promise<boolean>;
  cancelQuestion: (id: string) => void;
  clear: () => void;
}>((set, get) => ({
  pendingQuestions: [],

  addQuestion(gatewayId, payload) {
    const request = parseQuestionRequest(payload);
    if (!request) return;
    // 网关到点会自己把它置成 expired；已经过期的事件（例如重连后才补发的）不要渲染
    if (isQuestionExpired(request, Date.now())) return;
    if (get().pendingQuestions.some((question) => question.id === request.id)) return;

    const taskId = resolveTaskId(request.sessionKey);
    if (taskId && taskId !== useTaskStore.getState().activeTaskId) {
      useUiStore.getState().markUnread(taskId);
    }
    set((s) => ({ pendingQuestions: [...s.pendingQuestions, { ...request, gatewayId, taskId }] }));

    const ttl = request.expiresAtMs - Date.now();
    if (ttl > 0) {
      expireTimers.set(
        request.id,
        setTimeout(() => {
          expireTimers.delete(request.id);
          get().removeQuestion(request.id);
        }, ttl),
      );
    }
  },

  removeQuestion(id) {
    const question = get().pendingQuestions.find((item) => item.id === id);
    if (question?.taskId && !get().pendingQuestions.some((item) => item.id !== id && item.taskId === question.taskId)) {
      useUiStore.getState().clearUnread(question.taskId);
    }
    clearTimeout(expireTimers.get(id));
    expireTimers.delete(id);
    set((s) => ({ pendingQuestions: s.pendingQuestions.filter((item) => item.id !== id) }));
  },

  /**
   * 重连 / 重启后与网关对账：**以网关的列表为准**。
   * 本地有、网关没有的（已答 / 已取消 / 已过期）→ 收掉；网关有、本地没有的 → 补上。
   * 不做这一步，进程重启期间挂起的问题在界面里是隐形的，而用户下一条消息照样被吞。
   */
  reconcileQuestions(gatewayId, payloads) {
    const live = new Map<string, QuestionRequest>();
    for (const payload of payloads) {
      const request = parseQuestionRequest(payload);
      if (!request || isQuestionExpired(request, Date.now())) continue;
      live.set(request.id, request);
    }
    for (const question of get().pendingQuestions) {
      if (question.gatewayId === gatewayId && !live.has(question.id)) get().removeQuestion(question.id);
    }
    for (const request of live.values()) {
      if (get().pendingQuestions.some((question) => question.id === request.id)) continue;
      get().addQuestion(gatewayId, request);
    }
  },

  async resolveQuestion(id, selection) {
    const question = get().pendingQuestions.find((item) => item.id === id);
    if (!question) return false;

    const checked = resolveQuestionSelection(question.questions, selection);
    if (!checked.ok) {
      // 拦在本地：交给网关也是一样的拒绝，但用户会看到内部字段名
      toast.error(i18n.t('question.incompleteTitle'), {
        description:
          checked.reason === 'single-select'
            ? i18n.t('question.singleSelectOnly', { header: checked.errorHeader ?? '' })
            : i18n.t('question.answerAllRequired', { headers: checked.missing.join('、') }),
      });
      return false;
    }

    let result: { ok: boolean; error?: string };
    try {
      result = await window.clawwork.resolveQuestion(
        question.gatewayId,
        buildQuestionResolveParams(question, selection, 'user'),
      );
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (!result.ok) {
      const message = describeQuestionFailure(result.error, question.questions, i18n.t('question.resolveFailed'));
      const appError = buildAppError({
        source: 'gateway',
        stage: 'send',
        rawMessage: result.error ?? 'question resolve failed',
      });
      const { title } = formatErrorForToast(appError, i18n.t);
      toast.error(title, { description: message ?? undefined });
      return false;
    }

    get().removeQuestion(id);
    return true;
  },

  cancelQuestion(id) {
    const question = get().pendingQuestions.find((item) => item.id === id);
    if (!question) return;
    window.clawwork
      .resolveQuestion(question.gatewayId, buildQuestionCancelParams(id, 'user'))
      .then((result) => {
        if (!result.ok) {
          toast.error(i18n.t('question.cancelFailed'));
          return;
        }
        get().removeQuestion(id);
      })
      .catch(() => {
        toast.error(i18n.t('question.cancelFailed'));
      });
  },

  clear() {
    for (const timer of expireTimers.values()) {
      clearTimeout(timer);
    }
    expireTimers.clear();
    for (const question of get().pendingQuestions) {
      if (question.taskId) useUiStore.getState().clearUnread(question.taskId);
    }
    set({ pendingQuestions: [] });
  },
}));
