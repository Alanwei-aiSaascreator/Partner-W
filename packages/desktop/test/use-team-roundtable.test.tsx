// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTeamRoundtable, type TeamRoundtableApi } from '../src/renderer/hooks/useTeamRoundtable';
import { useMessageStore } from '../src/renderer/stores/messageStore';
import type { Speaker } from '../src/renderer/lib/team-roundtable';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEVICE = 'dev-1';
const GW = 'gw-1';
const TASK = 'task-1';
const sk = (agentId: string) => `agent:${agentId}:clawwork:${DEVICE}:task:${TASK}`;

const speakers: Speaker[] = [
  { agentId: 'm', name: '主持人', position: 'moderator' },
  { agentId: 'e', name: '领域专家', position: 'expert' },
  { agentId: 's', name: '记录员', position: 'scribe' },
];

type SendArgs = [string, string, string];

let sent: SendArgs[];
let abortChat: ReturnType<typeof vi.fn>;
/** 让每个用例自己决定"网关怎么回应"。 */
let respond: (sessionKey: string) => void;

/** 模拟网关：置忙 → （等一会）→ 置闲 + finalize。 */
function makeGateway() {
  return {
    getDeviceId: vi.fn(async () => DEVICE),
    abortChat: vi.fn(async () => ({ ok: true })),
    sendMessage: vi.fn(async (gw: string, sessionKey: string, content: string) => {
      sent.push([gw, sessionKey, content]);
      useMessageStore.setState((s) => ({
        processingBySession: new Set([...s.processingBySession, sessionKey]),
      }));
      respond(sessionKey);
      return { ok: true };
    }),
  };
}

function setBusy(sessionKey: string, busy: boolean) {
  useMessageStore.setState((s) => {
    const next = new Set(s.processingBySession);
    if (busy) next.add(sessionKey);
    else next.delete(sessionKey);
    return { processingBySession: next };
  });
}

/**
 * 模拟"这一轮答完了、正文落进任务消息列表"。
 *
 * ⚠️ 真实链路里正文**不在** `activeTurnBySession` —— 2026-09-20 实机实测：
 *    那一轮 active turn 是 `finalized:false / content 空 / toolCalls:2`，
 *    真正的答案是从 `chat.history` 回来、由 sync 落进消息列表的。
 *    所以夹具也必须落在消息列表上，否则测的是个不存在的形态。
 */
function answer(sessionKey: string, content: string) {
  setBusy(sessionKey, false);
  useMessageStore.setState((s) => ({
    messagesByTask: {
      ...s.messagesByTask,
      [TASK]: [
        ...(s.messagesByTask[TASK] ?? []),
        {
          id: `m-${content}`,
          taskId: TASK,
          role: 'assistant',
          sessionKey,
          content,
          timestamp: new Date().toISOString(),
        } as never,
      ],
    },
  }));
}

let api: TeamRoundtableApi;
function Probe(): ReactElement {
  api = useTeamRoundtable();
  return <span />;
}

function render(ui: ReactElement): { unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const startArgs = { taskId: TASK, gatewayId: GW, question: '该不该涨价？', speakers };

beforeEach(() => {
  sent = [];
  abortChat = vi.fn(async () => ({ ok: true }));
  const gw = makeGateway();
  abortChat = gw.abortChat;
  (window as unknown as { clawwork: unknown }).clawwork = gw;
  useMessageStore.setState({ processingBySession: new Set(), activeTurnBySession: {}, messagesByTask: {} });
});

/**
 * `useTeamRoundtable`（2026-09-20）—— 把运行器接到真实网关。
 *
 * 这里钉的是三条**实测得来**的接线细节，每一条少了都会出错：
 *  ① 会话键 = `agent:<agentId>:clawwork:<deviceId>:task:<taskId>`
 *  ② **先订阅、后发送**（反过来会永远等不到"忙"）
 *  ③ `lifecycle.end` 比 `chat.final` **早 22–36ms**，而 finalize 才切掉 `</think>` 推理
 *     ⇒ 必须再等一次 finalize，否则把模型的思考过程喂给下一位
 */
describe('useTeamRoundtable', () => {
  it('⭐ 按顺序给每位发到**他自己的会话**，会话键形状正确', async () => {
    respond = (key) => answer(key, `答复-${key}`);
    const { unmount } = render(<Probe />);

    await act(async () => {
      await api.start(startArgs);
    });

    expect(sent.map(([, key]) => key)).toEqual([sk('m'), sk('e'), sk('s')]);
    expect(sent.every(([gw]) => gw === GW)).toBe(true);
    expect(api.turns.map((t) => t.text)).toEqual([`答复-${sk('m')}`, `答复-${sk('e')}`, `答复-${sk('s')}`]);
    expect(api.doneCount).toBe(3);
    unmount();
    // ⚠️ 超时不是凑数：如果"先订阅后发送"写反了，这个用例会**挂住**（永远等不到"忙"），
    //    这里靠超时把那种写法变成一次干净的失败，而不是挂十分钟。
  }, 8000);

  it('⭐ 第 2 位拿到的输入里带着第 1 位的正文（这就是"讨论"）', async () => {
    respond = (key) => answer(key, `答复-${key}`);
    const { unmount } = render(<Probe />);

    await act(async () => {
      await api.start(startArgs);
    });

    expect(sent[0]![2]).not.toContain('【前序发言】');
    expect(sent[1]![2]).toContain(`答复-${sk('m')}`);
    expect(sent[2]![2]).toContain(`答复-${sk('m')}`);
    expect(sent[2]![2]).toContain(`答复-${sk('e')}`);
    unmount();
  });

  it('⭐ 正文比"不忙"晚到（实测差 22–36ms + 一次 chat.history 往返）⇒ 仍拿得到', async () => {
    // 只置闲、**不** finalize，隔一会儿再 finalize —— 复刻真实时序
    respond = (key) => {
      setBusy(key, false);
      setTimeout(() => answer(key, `干净正文-${key}`), 30);
    };
    const { unmount } = render(<Probe />);

    await act(async () => {
      await api.start(startArgs);
    });

    expect(api.turns.map((t) => t.text)).toEqual([`干净正文-${sk('m')}`, `干净正文-${sk('e')}`, `干净正文-${sk('s')}`]);
    unmount();
  });

  it('⚠️ 这一位始终拿不到正文 ⇒ 停在他那里（不退回流式缓冲，那里面混着推理）', async () => {
    respond = (key) => {
      if (key === sk('e')) {
        setBusy(key, false); // 闲了，但正文始终没落到消息列表
        return;
      }
      answer(key, `答复-${key}`);
    };
    const { unmount } = render(<Probe />);

    await act(async () => {
      await api.start(startArgs);
    });

    expect(sent.map(([, key]) => key)).toEqual([sk('m'), sk('e')]);
    expect(api.stoppedAt).toBe('e');
    expect(api.turns.map((t) => t.text)).toEqual([`答复-${sk('m')}`]);
    unmount();
  }, 20_000);

  it('⚠️ 用户点停止 ⇒ 不再往下发，且**中断当前那一位**', async () => {
    respond = (key) => {
      if (key === sk('m')) api.stop(); // 主持人说完的瞬间点停止
      answer(key, `答复-${key}`);
    };
    const { unmount } = render(<Probe />);

    await act(async () => {
      await api.start(startArgs);
    });

    expect(sent.map(([, key]) => key)).toEqual([sk('m')]);
    expect(api.stoppedByUser).toBe(true);
    // 只置"别再往下发"是不够的：当前这一位会一直说到完。用户点停止就是要它现在停。
    expect(abortChat).toHaveBeenCalledWith(GW, sk('m'));
    unmount();
  });

  it('人数超限在**发之前**就拒绝（不能先替用户花钱再报错）', async () => {
    respond = (key) => answer(key, `答复-${key}`);
    const many: Speaker[] = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ agentId: id, name: id, position: 'expert' }));
    const { unmount } = render(<Probe />);

    await act(async () => {
      await api.start({ ...startArgs, speakers: many });
    });

    expect(sent).toEqual([]);
    expect(api.running).toBe(false);
    unmount();
  });
});
