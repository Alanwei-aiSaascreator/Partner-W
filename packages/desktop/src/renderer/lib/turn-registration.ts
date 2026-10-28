/**
 * ⭐ 第二轮（R5 P1 收口）：**轮次登记回执登记表**（渲染侧）—— main 广播
 * `artifact:turn-registration` 的落地处，完成资格消费的唯一来源。
 *
 * 背景（复审实跑反例）：`session-sync` 的 promote 在 create-message 持久化之前
 * 清掉 activeTurn ⇒ 通知出口若只凭"模型结束 + activeTurn 空 + 投影里没有
 * operation"就判 complete，会在 main 登记（finalizeAssistantArtifacts/交付捕获）
 * 尚未返回时误弹"任务完成"。本表按 `sessionKey|runId` 保存 main 的登记回执：
 *
 *  - 无回执（'unknown'）⇒ 完成资格不得判 complete（等登记证据）；
 *  - `registered` ⇒ 需求 = 投影中已到达的 operations，全部结算前不得 complete；
 *  - `needs-review` ⇒ 已知需求登记失败/未确认（需求保留）；
 *  - `none-expected` ⇒ 可信确认零需求（普通聊天）。
 *
 * 有界（超限逐出最旧）；版本号驱动订阅（通知 hook 用 useSyncExternalStore 消费）。
 */
export type TurnRegistrationFactStatus = 'registered' | 'needs-review' | 'none-expected';

export interface TurnRegistrationFact {
  taskId: string;
  sessionKey: string;
  runId: string;
  status: TurnRegistrationFactStatus;
  expectedKinds: readonly string[];
  at: number;
}

const MAX_FACTS = 512;
const facts = new Map<string, TurnRegistrationFact>();
const listeners = new Set<() => void>();
let version = 0;

function factKeyOf(sessionKey: string, runId: string): string {
  return `${sessionKey}|${runId}`;
}

export function noteTurnRegistration(fact: Omit<TurnRegistrationFact, 'at'>): void {
  if (!fact.sessionKey || !fact.runId) return;
  const key = factKeyOf(fact.sessionKey, fact.runId);
  // 重新插入保持 LRU 序（同一 run 的迟到回执覆盖旧值：run 级幂等由调用方纪律保证）。
  facts.delete(key);
  facts.set(key, { ...fact, expectedKinds: [...fact.expectedKinds], at: Date.now() });
  while (facts.size > MAX_FACTS) {
    const oldest = facts.keys().next().value;
    if (oldest === undefined) break;
    facts.delete(oldest);
  }
  version += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // 订阅方异常不打断广播链（与模块级登记表同纪律）。
    }
  }
}

export function getTurnRegistration(sessionKey: string, runId: string): TurnRegistrationFact | undefined {
  return facts.get(factKeyOf(sessionKey, runId));
}

export function subscribeTurnRegistration(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTurnRegistrationVersion(): number {
  return version;
}

/** 只给测试：清空登记表与订阅（模块级状态）。 */
export function resetTurnRegistrationForTests(): void {
  facts.clear();
  listeners.clear();
  version = 0;
}
