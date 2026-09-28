import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { OurSkillEntry, SkillStatusReport } from '@clawwork/shared';
import { readSkillStatusReport, resolveSkillVerdict, type SkillVerdict } from './verdict';

/**
 * 「助手现在能不能用它」的**探测**（2026-09-29）。
 *
 * 判据全在 `verdict.ts`（纯函数、有测试）；这里只管**什么时候去问、问不到怎么办**。
 *
 * ## 为什么要重试
 *
 * 实测：装完之后网关要 **~0.7 秒**才认得那个技能；通知网关重扫的那一下（`skills.update`）
 * 本身要 1.4–2.0 秒，而且**是不等的**（fire-and-forget）。所以"装完立刻问一次"必然问不到，
 * 而那会把一个已经装好的技能说成不能用 —— 这条功能存在的意义正好相反。
 *
 * ⭐ 重试时间表 **0 / 500 / 1500 ms**，并且**集齐就早停**：
 * 常见情形（早就装好、或本来就用不了）第一遍就出结果、不拖延；
 * 延迟只落在**否定答案**上，而那正是该等一等的。
 *
 * ⚠️ 三次都问不到**不是"不能用"**，是"不知道"（见 `verdict.ts` 的三个不许）。
 */
const RETRY_DELAYS_MS = [0, 500, 1500] as const;
/** 整体上限：网关客户端自己的超时是 15 秒，不能让这一行挂那么久。 */
const OVERALL_TIMEOUT_MS = 2500;

export interface UseSkillVerdictsInput {
  gatewayId: string | null;
  /** 要问哪个助手。`''` = 不知道 ⇒ **压根不问了**（不带 agentId 会落到环境属主，那是假绿）。 */
  agentId: string;
  /** 网关通不通、`managedSkillsDir` 认不认得（沿用这一页既有的门槛）。 */
  enabled: boolean;
  /** 这一页当前这份清单（判据要逐条算，包括"没装 ⇒ 什么都不说"）。 */
  skills: readonly OurSkillEntry[];
  /** 刷新/装卸之后 +1，用来强制重问一遍。 */
  nonce: number;
}

export function useSkillVerdicts({
  gatewayId,
  agentId,
  enabled,
  skills,
  nonce,
}: UseSkillVerdictsInput): Record<string, SkillVerdict> {
  const { t } = useTranslation();
  /**
   * `settled` = 这一轮**问完了**（集齐了 / 重试次数用完 / 整体超时）。
   *
   * ⭐ 为什么要有它：0.7 秒窗口里问到的第一份报告**可能还没有那个技能**。
   * 如果那时候就下结论，卡片会先闪一下"不知道"再变绿 ——
   * 所以没问完之前一律是"正在确认…"，**不许把过程中的中间态当成结论**。
   */
  const [snapshot, setSnapshot] = useState<{
    report: SkillStatusReport | null;
    settled: boolean;
    failure: 'rpc-failed' | 'timeout';
  }>({ report: null, settled: false, failure: 'rpc-failed' });
  const epochRef = useRef(0);

  /**
   * 探测的**键**：只由"装了哪些"决定，而且是**字符串**。
   * ⚠️ 依赖里放数组会让 effect 每渲染都重跑（数组每次都是新的）——
   * 那会把 0.7 秒的重试变成每个渲染一轮 RPC。
   */
  const probeKey = skills
    .filter((skill) => skill.installed)
    .map((skill) => skill.skillKey ?? skill.slug)
    .join('|');
  const entityKey = `${gatewayId ?? ''}::${agentId}::${nonce}`;
  const shouldProbe = enabled && Boolean(gatewayId) && agentId !== '' && probeKey !== '';

  useEffect(() => {
    // 不该问的三种情形都落到这里：没网关、不知道该问谁、一个都没装。
    if (!shouldProbe) {
      setSnapshot({ report: null, settled: false, failure: 'rpc-failed' });
      return;
    }

    const epoch = (epochRef.current += 1);
    const wanted = probeKey.split('|');
    const lastIndex = RETRY_DELAYS_MS.length - 1;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    /**
     * 这一轮里**已经落地过的最新一次尝试**，以及**是否已经收工**。
     *
     * ⚠️ 这两个变量是 2026-09-29 独立复核抓出来的**两个真 bug** 的修复：
     *
     * (1) 三次尝试是一次性排好的，而慢的那次（网关冷启动，实测 0.7~2 秒）可能**最后才回来**：
     *     它拿着"还没有这个技能"的**旧**结果，把已经变绿的界面**重新打回"正在确认…"**，
     *     而那时定时器已经用完 ⇒ **永远卡在"正在确认…"**。
     *     ⇒ 收工之后一律不许再改状态；更早的 index 也不许覆盖更晚的。
     *
     * (2) 最后一次**失败**时原来写的是 `report: null` —— 把前面已经问到的好报告**扔了**，
     *     界面上刚看到的绿/红会变成"没问出来"。总超时那条路本来就写着"只降级不覆盖"，
     *     这两条路却反着来。
     */
    let appliedIndex = -1;
    let settled = false;
    setSnapshot({ report: null, settled: false, failure: 'rpc-failed' });

    const finish = (failure: 'rpc-failed' | 'timeout'): void => {
      settled = true;
      setSnapshot((prev) => (prev.report ? { ...prev, settled: true } : { report: null, settled: true, failure }));
    };

    const overall = setTimeout(() => {
      if (cancelled || epochRef.current !== epoch || settled) return;
      // 到点就收工，但**只降级不覆盖**：已经问到的报告比"超时"这个事实更有用。
      finish('timeout');
    }, OVERALL_TIMEOUT_MS);

    const attempt = async (index: number): Promise<void> => {
      try {
        const res = await window.clawwork.getSkillsStatus(gatewayId as string, agentId);
        if (cancelled || epochRef.current !== epoch) return;
        // ⚠️ 收工之后、或比已经落地的那次更早 ⇒ **丢弃**（上面那个"卡死"就是这么来的）。
        if (settled || index < appliedIndex) return;
        const parsed = res.ok ? readSkillStatusReport(res.result) : null;
        if (!parsed) {
          if (index === lastIndex) finish('rpc-failed');
          return;
        }
        appliedIndex = index;
        // 集齐就早停：**连还没跑的重试一起取消**（原来只取消了总超时 ⇒ 每轮仍然打满 3 次 RPC）。
        const allSeen = wanted.every((key) => parsed.skills.some((entry) => entry.skillKey === key));
        if (allSeen) {
          clearTimeout(overall);
          for (const timer of timers) clearTimeout(timer);
          settled = true;
        } else if (index === lastIndex) {
          settled = true;
        }
        setSnapshot({ report: parsed, settled, failure: 'rpc-failed' });
      } catch {
        if (!cancelled && epochRef.current === epoch && index === lastIndex && !settled && index >= appliedIndex) {
          finish('rpc-failed');
        }
      }
    };

    RETRY_DELAYS_MS.forEach((delay, index) => timers.push(setTimeout(() => void attempt(index), delay)));

    return () => {
      // 取消：换助手/换网关/装卸/卸载组件之后，旧那一轮的响应一律作废（epoch 也兜一层）。
      cancelled = true;
      clearTimeout(overall);
      for (const timer of timers) clearTimeout(timer);
    };
    // ⚠️ 依赖只有这几个字符串：`skills` 的构成已经压进 `probeKey` 了。
  }, [agentId, entityKey, gatewayId, probeKey, shouldProbe]);

  return useMemo(() => {
    const out: Record<string, SkillVerdict> = {};
    for (const skill of skills) {
      // 还没问完 ⇒ 「正在确认…」。**不许把过程中的中间态当成结论**（否则先闪"不知道"再变绿）。
      if (shouldProbe && !snapshot.settled && skill.installed) {
        out[skill.slug] = { kind: 'checking' };
        continue;
      }
      out[skill.slug] = resolveSkillVerdict({
        skill,
        report: snapshot.report,
        agentKnown: agentId !== '',
        t,
        failure: snapshot.failure,
      });
    }
    return out;
  }, [agentId, shouldProbe, skills, snapshot, t]);
}
