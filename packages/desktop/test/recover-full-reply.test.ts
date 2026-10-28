import { describe, expect, it, vi } from 'vitest';

import {
  assistantHistoryText,
  DISPLAY_TRUNCATION_MARKER,
  HISTORY_MAX_CHARS,
  historyFetcherFrom,
  recoverFullReply,
  type ChatHistoryResult,
  type FetchChatHistory,
} from '../src/main/artifact/recover-full-reply';

/**
 * **恢复"被显示层截断的那一条助手回复"的完整原文。**
 *
 * ## 为什么需要它
 *
 * 随包运行时（`openclaw@2026.9.3`）把**单条消息**在投影时截到 8,000 字符，
 * 末尾追加字面标记 `...(truncated)...`。于是"把整份 PPT 源码写进回复"这条路
 * 在真机上**连续四次**死在 8,000：围栏没有结尾 ⇒ 整份丢掉。
 *
 * 这**不是**模型上下文问题，是显示/投影的问题 —— 完整原文还在网关的会话记录里。
 *
 * ## 全部结论都是**真发请求量到的**（不是读代码猜的）
 *
 * | 事实 | 量到的结果 |
 * | --- | --- |
 * | `maxChars` 能不能顶开 8,000 | **能**：同一条消息 8,018 → **12,414（完整）**，`truncated` 标记消失 |
 * | 预算 N 与返回长度 | N 给回 **N+18** 字符（那 18 是追加的标记） |
 * | `maxChars` 合法范围 | 1 … **500,000** |
 * | 身份藏在哪 | ⚠️ **不在 item 顶层**，在 `message.__openclaw.{id,runId}` |
 * | 截断状态藏在哪 | ⚠️ 同上：`__openclaw.truncated` + `__openclaw.reason`，文本完整时两个字段**整体消失** |
 * | `inputRunIds` 会过滤吗 | **不会** —— 传真 runId 与假 UUID 返回**逐字节相同** |
 * | `maxBytes` 会抬文本上限吗 | **不会** —— 只减消息条数 |
 *
 * ⇒ 所以：**用 `maxChars` 取，在客户端按 `__openclaw.runId` 精确比对**。
 *    `inputRunIds` 那条路是死的，别去用它。
 *
 * ## 这份测试钉的边界（每一条都对应真机上会发生的事）
 *
 * 规格里明令禁止的四种取法，逐条钉死：
 *   ① 按"最长消息"选；② 按"最近闭合 fence"猜；③ 跨 task/session 兜底；④ 静默退回旧消息。
 */

/** 造一条运行时形状的助手消息（身份与截断状态都在 `__openclaw` 里）。 */
function assistantMessage(input: {
  runId: string;
  text: string;
  id?: string;
  truncated?: boolean;
  reason?: string;
}): ChatHistoryResult['messages'][number] {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: input.text }],
    timestamp: '2026-09-28T10:00:00.000Z',
    __openclaw: {
      id: input.id ?? `id-${input.runId}`,
      runId: input.runId,
      ...(input.truncated ? { truncated: true } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    },
  };
}

const RUN = 'run-current-0001';

/** 一次就命中、且内容完整。 */
function historyWith(text: string, runId = RUN): FetchChatHistory {
  return () => Promise.resolve({ messages: [assistantMessage({ runId, text })] });
}

describe('正常路径：显示被截断，但历史里有完整原文', () => {
  it('⭐ A. 显示 8,001 字符被截断 + 历史里同 runId 有完整 13K ⇒ 拿到完整的那份', async () => {
    const display = `${'甲'.repeat(7_983)}\n${DISPLAY_TRUNCATION_MARKER}`;
    const full = `\`\`\`slidegen\n// title: 完整\n${'乙'.repeat(13_000)}\n\`\`\`\n`;
    const result = await recoverFullReply({
      sessionKey: 's',
      currentRunId: RUN,
      displayContent: display,
      artifactKind: 'slidegen',
      deps: { fetchHistory: historyWith(full) },
    });
    expect(result.status, '必须拿到完整的那份').toBe('complete');
    expect(result.status === 'complete' && result.content).toBe(full);
  });

  it('⭐ 显示**没有**截断标记 ⇒ 直接用显示内容，**一次请求都不发**（普通短回复零成本）', async () => {
    const fetchHistory = vi.fn<FetchChatHistory>();
    const result = await recoverFullReply({
      sessionKey: 's',
      currentRunId: RUN,
      displayContent: '一份很短的回复，没有任何截断标记',
      artifactKind: 'docgen',
      deps: { fetchHistory },
    });
    expect(result.status).toBe('complete');
    expect(fetchHistory, '没截断就别去打扰网关').not.toHaveBeenCalled();
  });

  it('⭐ F. 这个模块**不许改动**显示内容（普通聊天的显示截断行为保持不变）', async () => {
    const display = `${'甲'.repeat(100)}\n${DISPLAY_TRUNCATION_MARKER}`;
    await recoverFullReply({
      sessionKey: 's',
      currentRunId: RUN,
      displayContent: display,
      artifactKind: 'slidegen',
      deps: { fetchHistory: historyWith('短文') },
    });
    expect(display, '显示内容是入参，不该被就地改写').toContain(DISPLAY_TRUNCATION_MARKER);
  });
});

describe('⭐ 规格明令禁止的四种取法 —— 逐条钉死', () => {
  it('⭐ B1. 历史里有一条**更长**的旧 deck（runId 不同）⇒ 绝不许选它', async () => {
    const display = `短\n${DISPLAY_TRUNCATION_MARKER}`;
    const oldLong = `\`\`\`slidegen\n// title: 上个月的旧 deck\n${'丙'.repeat(30_000)}\n\`\`\`\n`;
    const result = await recoverFullReply({
      sessionKey: 's',
      currentRunId: RUN,
      displayContent: display,
      artifactKind: 'slidegen',
      deps: {
        fetchHistory: () => {
          // 旧的那条更长，排在前面（"最长"和"最新"两种偷懒取法都会挑中它）
          return Promise.resolve({
            messages: [assistantMessage({ runId: 'run-OLD', text: oldLong })],
          });
        },
      },
    });
    expect(result.status, '没有本轮的完整原文 ⇒ 必须 unavailable，而不是拿旧 deck 顶替').toBe('unavailable');
  });

  it('⭐ B2. 本轮与旧 deck 同时在 ⇒ 只取本轮那条', async () => {
    const display = `${'甲'.repeat(50)}\n${DISPLAY_TRUNCATION_MARKER}`;
    const mine = '本轮的内容' + '丁'.repeat(200);
    const older = '旧'.repeat(5_000);
    const result = await recoverFullReply({
      sessionKey: 's',
      currentRunId: RUN,
      displayContent: display,
      artifactKind: 'slidegen',
      deps: {
        fetchHistory: () =>
          Promise.resolve({
            messages: [
              assistantMessage({ runId: 'run-OLD', text: older }),
              assistantMessage({ runId: RUN, text: mine }),
            ],
          }),
      },
    });
    expect(result.status).toBe('complete');
    expect(result.status === 'complete' && result.content).toBe(mine);
  });

  it('⭐ B3. 只有 user 角色带这个 runId ⇒ 不算命中（别把用户自己说的话当助手产物）', async () => {
    const result = await recoverFullReply({
      sessionKey: 's',
      currentRunId: RUN,
      displayContent: `x\n${DISPLAY_TRUNCATION_MARKER}`,
      artifactKind: 'slidegen',
      deps: {
        fetchHistory: () =>
          Promise.resolve({
            messages: [
              { role: 'user', content: [{ type: 'text', text: '很长'.repeat(500) }], __openclaw: { runId: RUN } },
            ],
          }),
      },
    });
    expect(result.status).toBe('unavailable');
  });
});

describe('⭐ 落盘竞态：有限重试', () => {
  it('⭐ C. 第一次查不到、第二次查到 ⇒ 重试后成功', async () => {
    const full = `\`\`\`slidegen\n// title: 迟到\n${'戊'.repeat(13_000)}\n\`\`\`\n`;
    let calls = 0;
    const fetchHistory: FetchChatHistory = () => {
      calls += 1;
      if (calls === 1) return Promise.resolve({ messages: [] });
      return Promise.resolve({ messages: [assistantMessage({ runId: RUN, text: full })] });
    };
    const sleep = vi.fn(() => Promise.resolve());
    const result = await recoverFullReply({
      sessionKey: 's',
      currentRunId: RUN,
      displayContent: `x\n${DISPLAY_TRUNCATION_MARKER}`,
      artifactKind: 'slidegen',
      deps: { fetchHistory, sleep },
    });
    expect(result.status).toBe('complete');
    expect(calls, '应当重试过').toBeGreaterThan(1);
    expect(sleep).toHaveBeenCalled();
  });

  it('⭐ D. 永远查不到 ⇒ `unavailable`，**不给内容**（绝不拿截断文本生成半份 PPT）', async () => {
    const result = await recoverFullReply({
      sessionKey: 's',
      currentRunId: RUN,
      displayContent: `x\n${DISPLAY_TRUNCATION_MARKER}`,
      artifactKind: 'slidegen',
      deps: { fetchHistory: () => Promise.resolve({ messages: [] }), sleep: () => Promise.resolve() },
    });
    expect(result.status).toBe('unavailable');
    expect(result, '失败态里不许带任何内容').not.toHaveProperty('content');
  });

  it('⭐ 重试次数有上限（不能无限等）', async () => {
    let calls = 0;
    await recoverFullReply({
      sessionKey: 's',
      currentRunId: RUN,
      displayContent: `x\n${DISPLAY_TRUNCATION_MARKER}`,
      artifactKind: 'docgen',
      deps: {
        fetchHistory: () => {
          calls += 1;
          return Promise.resolve({ messages: [] });
        },
        sleep: () => Promise.resolve(),
      },
    });
    expect(calls).toBeGreaterThan(1);
    expect(calls, '重试次数必须有限且可测').toBeLessThanOrEqual(5);
  });

  it('⭐ 没有 runId ⇒ 立刻 `unavailable`，**一次请求都不发**（没有身份就别去猜）', async () => {
    const fetchHistory = vi.fn<FetchChatHistory>(() => Promise.resolve({ messages: [] }));
    const result = await recoverFullReply({
      sessionKey: 's',
      currentRunId: '',
      displayContent: `x\n${DISPLAY_TRUNCATION_MARKER}`,
      artifactKind: 'slidegen',
      deps: { fetchHistory, sleep: () => Promise.resolve() },
    });
    expect(result).toEqual({ status: 'unavailable', reason: 'no-run-id' });
    expect(fetchHistory, '没有身份时不该白跑网关').not.toHaveBeenCalled();
  });

  it('网关抛错 ⇒ `unavailable`（不抛给调用方，收尾链不能被它掀翻）', async () => {
    const result = await recoverFullReply({
      sessionKey: 's',
      currentRunId: RUN,
      displayContent: `x\n${DISPLAY_TRUNCATION_MARKER}`,
      artifactKind: 'html',
      deps: {
        fetchHistory: () => Promise.reject(new Error('gateway not connected')),
        sleep: () => Promise.resolve(),
      },
    });
    expect(result.status).toBe('unavailable');
  });
});

describe('⭐ 截断状态的区分（H：显示层截断 ≠ 真实输出被截断）', () => {
  it('取回来的那份**仍然**带 display-cap ⇒ 连 maxChars 都不够 ⇒ incomplete', async () => {
    const result = await recoverFullReply({
      sessionKey: 's',
      currentRunId: RUN,
      displayContent: `x\n${DISPLAY_TRUNCATION_MARKER}`,
      artifactKind: 'slidegen',
      deps: {
        fetchHistory: () =>
          Promise.resolve({
            messages: [
              assistantMessage({ runId: RUN, text: '很长'.repeat(2_000), truncated: true, reason: 'display-cap' }),
            ],
          }),
      },
    });
    expect(result.status).toBe('incomplete');
    expect(result.status === 'incomplete' && result.reason).toBe('display-cap');
  });

  it('⭐ H. 截断原因是**模型输出上限**（不是 display-cap）⇒ 与"显示层可恢复"区分开', async () => {
    const result = await recoverFullReply({
      sessionKey: 's',
      currentRunId: RUN,
      displayContent: `x\n${DISPLAY_TRUNCATION_MARKER}`,
      artifactKind: 'slidegen',
      deps: {
        fetchHistory: () =>
          Promise.resolve({
            messages: [
              assistantMessage({ runId: RUN, text: '模型就写了这么多', truncated: true, reason: 'output-limit' }),
            ],
          }),
      },
    });
    expect(result.status, '再取也是这么多 ⇒ 不能当成"可恢复"').toBe('incomplete');
    expect(result.status === 'incomplete' && result.reason, '两种原因必须能分开').not.toBe('display-cap');
  });

  it('⭐ 历史那条**没有任何截断标记** ⇒ 就是完整原文（运行时在完整时会去掉这两个字段）', async () => {
    const full = `\`\`\`slidegen\n// title: 完整\n${'己'.repeat(13_000)}\n\`\`\`\n`;
    const result = await recoverFullReply({
      sessionKey: 's',
      currentRunId: RUN,
      displayContent: `x\n${DISPLAY_TRUNCATION_MARKER}`,
      artifactKind: 'slidegen',
      deps: { fetchHistory: historyWith(full) },
    });
    expect(result.status).toBe('complete');
  });
});

describe('assistantHistoryText —— 多态 content 收成文本（从旧模块搬来的断言）', () => {
  it('块数组时把 text 拼回来；字符串原样；认不出的当空串', () => {
    expect(
      assistantHistoryText([
        { type: 'text', text: '```slidegen' },
        { type: 'text', text: '// title: 完整演示' },
      ]),
    ).toBe('```slidegen\n// title: 完整演示');
    expect(assistantHistoryText('plain')).toBe('plain');
    expect(assistantHistoryText(null)).toBe('');
  });
});

describe('historyFetcherFrom —— 把网关客户端的原始响应收成我们的形状', () => {
  it('⭐ 原样保留 `__openclaw`（身份与截断状态都在里面，收丢了就全瞎）', async () => {
    const raw = {
      sessionKey: 's',
      sessionId: 'sess',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }], __openclaw: { runId: 'r1', id: 'm1' } }],
    };
    const fetcher = historyFetcherFrom({ getChatHistory: () => Promise.resolve(raw) });
    const result = await fetcher({ sessionKey: 's', limit: 3, maxChars: 1_000 });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.__openclaw, '`__openclaw` 必须原样带出来').toEqual({ runId: 'r1', id: 'm1' });
  });

  it('把 maxChars 透传给网关（这是顶开 8,000 的唯一旋钮）', async () => {
    const calls: { limit?: number; maxChars?: number }[] = [];
    const fetcher = historyFetcherFrom({
      getChatHistory: (_sessionKey, limit, maxChars) => {
        calls.push({ limit, maxChars });
        return Promise.resolve({ messages: [] });
      },
    });
    await fetcher({ sessionKey: 's', limit: 7, maxChars: 500_000 });
    expect(calls).toEqual([{ limit: 7, maxChars: 500_000 }]);
  });

  it('响应畸形（没有 messages 数组）⇒ 回空数组，不抛（收尾链不能被它掀翻）', async () => {
    const fetcher = historyFetcherFrom({ getChatHistory: () => Promise.resolve({}) });
    await expect(fetcher({ sessionKey: 's', limit: 3, maxChars: 1_000 })).resolves.toEqual({ messages: [] });
  });
});

describe('⭐ G. 中文按 UTF-8 **字节**算，不是按字符数', () => {
  it('请求用的是运行时的合法上限 500,000 字符', () => {
    expect(HISTORY_MAX_CHARS).toBe(500_000);
  });

  it('⭐ 20,000 个汉字（≈60KB 字节）在字节预算内 ⇒ 收下，不误判为超限', async () => {
    const full = '汉'.repeat(20_000);
    expect(Buffer.byteLength(full, 'utf8'), '先确认夹具真的是 3 字节/字').toBe(60_000);
    const result = await recoverFullReply({
      sessionKey: 's',
      currentRunId: RUN,
      displayContent: `x\n${DISPLAY_TRUNCATION_MARKER}`,
      artifactKind: 'docgen',
      deps: { fetchHistory: historyWith(full) },
    });
    expect(result.status).toBe('complete');
  });

  it('⭐ 超过字节预算的原文 ⇒ `incomplete`（明确、可测、有限），不硬塞给解析器', async () => {
    // 安全字节上限见常量；这里造一份明显超出的（400,000 个汉字 ≈ 1.2 MB）
    const tooBig = '超'.repeat(400_000);
    const result = await recoverFullReply({
      sessionKey: 's',
      currentRunId: RUN,
      displayContent: `x\n${DISPLAY_TRUNCATION_MARKER}`,
      artifactKind: 'slidegen',
      deps: { fetchHistory: historyWith(tooBig) },
    });
    expect(result.status).toBe('incomplete');
  });
});
