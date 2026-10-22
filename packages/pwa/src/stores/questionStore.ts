import { create } from 'zustand';
import {
  buildQuestionCancelParams,
  buildQuestionResolveParams,
  isQuestionExpired,
  parseQuestionRequest,
  resolveQuestionSelection,
  type QuestionRequest,
  type QuestionSelection,
} from '@clawwork/core';
import { getClient } from '../gateway/client-registry';

type PendingQuestion = QuestionRequest & { gatewayId: string; taskId: string | null };

/**
 * 任务反查由 `stores/index.ts` 在 taskStore 就绪后注入。
 *
 * ⚠️ 不能在这里 `import { useTaskStore } from './hooks'`：`hooks.ts` 反过来 import
 * `./index.js`，而 `index.ts` 又 import 本模块 —— 三方成环，模块初始化顺序一变就是
 * **启动即黑屏**（`Cannot access 'xxx' before initialization`，2026-10-21 真机踩到）。
 * 环里只留一条方向：本模块不认识 hooks，索引侧把能力塞进来。
 */
let lookupTaskId: (sessionKey: string) => string | null = () => null;

export function bindQuestionTaskLookup(fn: (sessionKey: string) => string | null): void {
  lookupTaskId = fn;
}

function resolveTaskId(sessionKey?: string | null): string | null {
  if (!sessionKey) return null;
  // 手机端任务的 sessionKey 形态与桌面端一致（agent:main:...:task:<uuid>），
  // 找不到对应任务就不挂卡片（宁可少显示，不干扰其他会话）。
  return lookupTaskId(sessionKey);
}

export const useQuestionStore = create<{
  pendingQuestions: PendingQuestion[];
  addQuestion: (gatewayId: string, payload: unknown) => void;
  removeQuestion: (id: string) => void;
  resolveQuestion: (id: string, selection: QuestionSelection) => Promise<boolean>;
  cancelQuestion: (id: string) => void;
  clear: () => void;
}>((set, get) => ({
  pendingQuestions: [],

  addQuestion(gatewayId, payload) {
    const request = parseQuestionRequest(payload);
    if (!request) return;
    if (isQuestionExpired(request, Date.now())) return;
    if (get().pendingQuestions.some((question) => question.id === request.id)) return;
    const taskId = resolveTaskId(request.sessionKey);
    set((s) => ({ pendingQuestions: [...s.pendingQuestions, { ...request, gatewayId, taskId }] }));
  },

  removeQuestion(id) {
    set((s) => ({ pendingQuestions: s.pendingQuestions.filter((item) => item.id !== id) }));
  },

  async resolveQuestion(id, selection) {
    const question = get().pendingQuestions.find((item) => item.id === id);
    if (!question) return false;

    const checked = resolveQuestionSelection(question.questions, selection);
    if (!checked.ok) return false;

    const client = getClient(question.gatewayId);
    if (!client?.isConnected) return false;

    try {
      await client.sendReq(
        'question.resolve',
        buildQuestionResolveParams(question, selection, 'user'),
        client.sessionMeta(question.sessionKey),
      );
      get().removeQuestion(id);
      return true;
    } catch {
      return false;
    }
  },

  cancelQuestion(id) {
    const question = get().pendingQuestions.find((item) => item.id === id);
    if (!question) return;
    const client = getClient(question.gatewayId);
    if (!client?.isConnected) return;
    client
      .sendReq('question.resolve', buildQuestionCancelParams(id, 'user'), client.sessionMeta(question.sessionKey))
      .then(() => get().removeQuestion(id))
      .catch(() => undefined);
  },

  clear() {
    set({ pendingQuestions: [] });
  },
}));
