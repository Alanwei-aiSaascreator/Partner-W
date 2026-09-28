import type { OurSkillEntry, SkillStatusEntry, SkillStatusReport } from '@clawwork/shared';
import { getSkillReason } from '@/lib/skill-utils';

type TFn = (key: string, opts?: Record<string, unknown>) => string;

/**
 * 「**这个助手现在能不能用它**」的判据（2026-09-29）。
 *
 * ## 两个真相、两个主人，谁也不许替对方说话
 *
 * | 问题 | 来源 | 谁在用 |
 * |---|---|---|
 * | 盘上装没装 | 主进程 `fs.existsSync`（**没动过**） | 装/卸按钮、"已装 M 个"、`data-installed` |
 * | 助手甲能不能用 | 网关 `skills.status`（**按助手**问） | 这个模块产出的那一个标签 |
 *
 * ⚠️ 这一页原来有一条**写死的**反对意见：「别把'已装'改成读 `skills.status`，网关有约 0.7 秒
 * 延迟会造成闪烁」（`SkillMarket/index.tsx` 里那段注释）。**那条意见仍然有效** ——
 * 所以这里**不覆盖**磁盘判据，而是**另立一个**状态。两边永远各说各的，
 * 于是"装上按钮旁边挂着一个绿标签"这种自相矛盾在结构上不可能出现。
 *
 * 纯函数、无 React、无 IPC —— 组件只负责把它画出来。
 */

/** 一个技能的「助手侧能不能用」。 */
export type SkillVerdict =
  | { kind: 'checking' }
  | { kind: 'usable' }
  /** 用不了，且**说得出原因**（原因文案复用设置页那套，9 个语种早就齐了）。 */
  | { kind: 'blocked'; reason: string }
  /**
   * ⭐ **问不到**。这一态的存在就是这条设计的重点：
   * 问不到既不是"能用"也不是"不能用"，界面必须如实说"不知道"。
   */
  | { kind: 'unknown'; why: 'absent' | 'rpc-failed' | 'timeout' | 'no-agent' }
  /** 没装 ⇒ 什么都不说（也不去探测）。 */
  | { kind: 'none' };

/**
 * 和网关那份清单按什么对上。
 *
 * 内容闸钉住了 `skillKey == slug`，但类型允许 `skillKey` 缺失（frontmatter 坏了）——
 * 能用 frontmatter 里的键就用它（更准），拿不到才退回目录名。
 */
export function skillJoinKey(our: OurSkillEntry): string {
  return our.skillKey ?? our.slug;
}

/**
 * ⭐ 校验线上下来的那份报告，而不是 `as` 一下就用。
 *
 * 这条不是洁癖：本项目栽过一模一样的形状 —— `skills:our-list` 的 IPC handler 返回扁平对象、
 * 渲染层却按 `res.result.…` 读，整页报"读取失败"，而**单测全绿**（因为桩是按渲染层的假设手写的）。
 * 返回 `null` = 形状不对 = 当"问不到"处理，由调用方降级成 `unknown`。
 */
export function readSkillStatusReport(raw: unknown): SkillStatusReport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const report = raw as Partial<SkillStatusReport>;
  if (!Array.isArray(report.skills)) return null;
  if (typeof report.managedSkillsDir !== 'string') return null;
  return raw as SkillStatusReport;
}

/** 判据的输入。`report` 为 `null` = 这一轮没问出来（失败/超时）。 */
export interface SkillVerdictInput {
  skill: OurSkillEntry;
  report: SkillStatusReport | null;
  /** 知不知道该问哪个助手。不知道就**不要问** —— 不带 agentId 会落到环境属主，那是假绿。 */
  agentKnown: boolean;
  t: TFn;
  /** `report` 为 `null` 时**为什么**没问出来（只是如实记账，两者在界面上同一句话）。 */
  failure?: 'rpc-failed' | 'timeout';
}

export function resolveSkillVerdict({
  skill,
  report,
  agentKnown,
  t,
  failure = 'rpc-failed',
}: SkillVerdictInput): SkillVerdict {
  // ① 没装 ⇒ 不说、也不探测。**这一条是地基**：卸载之后网关的按助手缓存还会报"在"
  //    ≥3 分钟（实测），不挡住的话就会出现"点上"按钮旁边挂着一个绿标签。
  if (!skill.installed) return { kind: 'none' };

  // ② 不知道该问哪个助手 ⇒ 问不到（不带 agentId 会落到环境属主 `main`，那是假绿）。
  if (!agentKnown) return { kind: 'unknown', why: 'no-agent' };

  // ③ 这一轮没问出来。
  if (!report) return { kind: 'unknown', why: failure };

  // ④ ⭐ 报告里没有这一条 ⇒ **不知道**，不是"不能用"。
  //    安装后网关要 ~0.7 秒才认得；缓存还是**按助手**各算各的 —— "我没看到"≠"它不能用"。
  const key = skillJoinKey(skill);
  const entry = report.skills.find((candidate) => candidate.skillKey === key);
  if (!entry) return { kind: 'unknown', why: 'absent' };

  return verdictFromEntry(entry, t);
}

/**
 * 条目 → 能用 / 用不了（带原因）。
 *
 * ⭐ 判据**和原因同源**：`eligible` 为真**且说不出一条原因** ⇒ 能用。
 *
 * ⚠️ 我第一版写的是 `eligible && !disabled && !blockedByAllowlist`，**漏了
 * `configChecks` / `missing` 两路** —— 于是"网关说 eligible、但有一条配置没满足"的技能
 * 会被标绿，而同一屏上还能读出它为什么不能用。**那正是这个模块声称要杜绝的自相矛盾**，
 * 是测试（`configChecks 没过 ⇒ blocked`）把它抓出来的。别改回去。
 *
 * 两个方向的取舍：宁可**误红**（让人去查一查）也不能**误绿** ——
 * 这条功能存在的理由就是"装完到底能不能用"，误绿等于又骗用户一次。
 */
function verdictFromEntry(entry: SkillStatusEntry, t: TFn): SkillVerdict {
  const reason = getSkillReason(entry, t, 'skill');
  if (entry.eligible && reason === null) return { kind: 'usable' };
  // 说不出一条具体原因时也要给一句话 —— 空标签比红标签更让人摸不着头脑。
  return { kind: 'blocked', reason: reason ?? t('skillMarket.verdictBlocked') };
}
