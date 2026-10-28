import { buildSpeakerPrompt, orderSpeakers, type Speaker, type Turn } from './team-roundtable';

/**
 * 圆桌讨论的**运行器**（2026-09-20）—— 纯编排，不碰 React、不碰网关。
 *
 * `send` 是注入的："把话发出去、并**等到这一轮真的结束**、再把这轮的正文拿回来"。
 * 怎么等由调用方决定（真身见 `hooks/useTeamRoundtable.ts`：等 `lifecycle.end`）。
 * 这样这一段最容易写错的顺序逻辑可以被直接测掉，不用起网关。
 *
 * ## ⚠️ 刻意串行
 *
 * 1. 并行的话，"后一位看到前一位的发言"根本不成立 —— 那就不叫讨论了；
 * 2. 额度是 **org 级共享池**、relay **没有并发闸门** ⇒ 并行 N 位会把超支上界抬到
 *    N 倍，而且余额耗尽时整账号一起被拒（先烧的饿死后面的）。
 */

/**
 * 一次讨论最多几位。
 *
 * 不是技术限制，是**成本**限制：每位各算一份积分（每次模型调用各记一笔账），
 * 而额度是共享池。WorkBuddy 的专家团能上 7 人，那是企业场景且他们自己公开承认
 * 积分消耗是主要抱怨点；我们按积分算，4 位是能承受的上限。
 */
export const MAX_ROUNDTABLE_SPEAKERS = 4;

export interface RoundtableResult {
  turns: Turn[];
  /** 因为某位发言人失败而中断时，停在他的 agentId 上。 */
  stoppedAt?: string;
  /**
   * 中断的**原因**。
   *
   * ⚠️ 不带这句的话，失败在界面上表现为"悄悄停住了" —— 用户只看到讨论没继续，
   *    不知道为什么，我们排查也只能靠猜（2026-09-20 实机踩到：第一次跑就是
   *    只出了一位然后没声了，而这行原因当时被我吞掉了）。
   */
  errorMessage?: string;
  /** 用户点了停止。 */
  stoppedByUser?: boolean;
}

export async function runRoundtable(args: {
  question: string;
  speakers: readonly Speaker[];
  /** 发出去并等到这一轮结束，返回这一轮的正文。抛错 = 这一位失败。 */
  send: (agentId: string, prompt: string) => Promise<string>;
  shouldStop?: () => boolean;
  onTurn?: (turn: Turn, index: number) => void;
}): Promise<RoundtableResult> {
  const { question, speakers, send, shouldStop, onTurn } = args;

  const ordered = orderSpeakers(speakers);

  // ⚠️ 在**发任何一条之前**就拒绝：超限了还发出去再报错，等于已经替用户花了钱。
  if (ordered.length > MAX_ROUNDTABLE_SPEAKERS) {
    throw new Error(
      `runRoundtable: 一次最多 ${MAX_ROUNDTABLE_SPEAKERS} 位发言（收到 ${ordered.length} 位）—— 每位各算一份积分`,
    );
  }

  const turns: Turn[] = [];

  for (let i = 0; i < ordered.length; i++) {
    if (shouldStop?.()) return { turns, stoppedByUser: true };

    const speaker = ordered[i]!;
    const prompt = buildSpeakerPrompt({
      question,
      speakers: ordered,
      speakerAgentId: speaker.agentId,
      priorTurns: turns,
    });

    let text: string;
    try {
      text = await send(speaker.agentId, prompt);
    } catch (error) {
      // 停在这一位：拿半截讨论去汇总，用户会以为这就是全部结论。
      // ⚠️ 把原因**带出去**，别吞（吞掉之后界面上就是"悄悄停了"）。
      return {
        turns,
        stoppedAt: speaker.agentId,
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }

    const turn: Turn = { agentId: speaker.agentId, name: speaker.name, text };
    turns.push(turn);
    onTurn?.(turn, i);
  }

  return { turns };
}
