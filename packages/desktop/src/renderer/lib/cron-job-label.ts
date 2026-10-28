/**
 * 网关自动建的定时任务在界面上是**英文名**（T-a4）：
 * `heartbeat-main`、`Memory Dreaming Promotion`、`skill-collection-review-<agentId>`。
 * 用户在「定时任务」页看到的就是这几串，中文界面上一片英文。
 *
 * ## ⚠️ 为什么只能做**展示层**映射
 *
 * `job.name` 在网关侧是数据的一部分，而且**用户能改**（`CronJobDialog` 里有名字输入框）。
 * 所以：
 * - 映射只发生在**显示**的那一步，`job.name` 本身一个字节都不动；
 * - **认不出来的一律原样显示** —— 用户改过名的、将来网关改名了，都走这条，
 *   绝不会出现"被我们张冠李戴成别的任务"。
 * - 认不出来的代价只是"又是英文"（**良性降级**），不是显示错的任务（恶性）。
 *
 * ⚠️ 反过来也成立：**网关将来改了任务名的前缀，这里就静默不匹配了** ——
 *    表现是那几行又变回英文，不会报错。所以 `parseSystemJobName` 的判据要**窄**
 *   （精确前缀 + 非空尾巴），宁可不认，不要错认。
 */

export type SystemJobKind = 'heartbeat' | 'memoryDreaming' | 'skillReview';

export interface ParsedSystemJobName {
  kind: SystemJobKind;
  /** 只有 heartbeat 与 skillReview 带（`main` / 各种 agent id）。 */
  agentId?: string;
}

const HEARTBEAT_PREFIX = 'heartbeat-';
const SKILL_REVIEW_PREFIX = 'skill-collection-review-';
const MEMORY_DREAMING = 'Memory Dreaming Promotion';

/**
 * 「记忆整理」那个任务的载荷正文 —— **实测值**（2026-09-20 直连网关读的 `cron.list`）。
 * 它是一个**内部标记串**，不是给人看的句子。认它才换描述，认不出就显示原文。
 */
const MEMORY_DREAMING_SENTINEL = '__openclaw_memory_core_short_term_promotion_dream__';

export function parseSystemJobName(name: string): ParsedSystemJobName | null {
  if (typeof name !== 'string') return null;
  if (name === MEMORY_DREAMING) return { kind: 'memoryDreaming' };

  for (const [prefix, kind] of [
    [HEARTBEAT_PREFIX, 'heartbeat'],
    [SKILL_REVIEW_PREFIX, 'skillReview'],
  ] as const) {
    if (!name.startsWith(prefix)) continue;
    const agentId = name.slice(prefix.length);
    // ⚠️ 尾巴为空 ⇒ **不认**。认了会显示成「技能库巡检（）」这种空括号。
    return agentId ? { kind, agentId } : null;
  }
  return null;
}

/**
 * 系统任务的**显示名**；认不出来返回 `null`（调用方原样显示 `job.name`）。
 *
 * ⚠️ `t` 的键必须写成**带引号的字面量**：本仓库的 `check:i18n` 只认字面量键，
 *    拼串（`cron.systemJob.${kind}`）会让整组键被当成"未使用"从而**静默漏掉**。
 */
export function systemJobLabel(
  name: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
  agentLabelOf?: (agentId: string) => string | undefined,
): string | null {
  const parsed = parseSystemJobName(name);
  if (!parsed) return null;
  if (parsed.kind === 'memoryDreaming') return t('cron.systemJob.memoryDreaming');
  if (parsed.kind === 'heartbeat') return t('cron.systemJob.heartbeat');
  return t('cron.systemJob.skillReview', {
    agent: (parsed.agentId && agentLabelOf?.(parsed.agentId)) ?? parsed.agentId ?? '',
  });
}

/**
 * 系统任务的**载荷描述**（中文）；认不出来返回 `null`（调用方照常显示原文）。
 *
 * ## 为什么系统任务的载荷要**换掉**而不是照原样显示
 *
 * 2026-09-20 实测网关里那三个任务的 payload：
 * - `heartbeat-main` → `{kind:'heartbeat'}` —— **没有正文**，预览是空
 * - `Memory Dreaming Promotion` → `message: "__openclaw_memory_core_short_term_promotion_dream__"`
 *   —— 一个**内部标记串**，给用户看等于什么都没说
 * - `skill-collection-review-*` → 一整段**英文指令**（几百字），截断后只剩
 *   `Review this agent's Skill Workshop as a collection, not a...`
 *
 * 三种对用户都是噪声。这里改说**它干什么**。
 * ⚠️ 这只是**改显示**：`job.payload` 一个字节都不动，编辑对话框里看到的仍是原文。
 * ⚠️ 描述是**转述**，所以刻意写得短而保守（不写"每周"这种从 schedule 推的细节，
 *    那个角标上已经有了）。
 */
export function systemJobDescription(
  name: string,
  payload: { kind?: string; message?: string; text?: string } | undefined | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string | null {
  const parsed = parseSystemJobName(name);
  if (!parsed) return null;
  const kind = payload?.kind;

  // ⚠️ 名字对上了**还不够**：载荷也得是那一种。名字与载荷是两样东西，
  //    只认名字会出现"任务被改过载荷了，界面还按老样子描述"—— 那正是我们要避免的
  //    **张冠李戴**。不认识的一律返回 null，调用方照常显示原文（良性降级）。
  if (parsed.kind === 'heartbeat') return kind === 'heartbeat' ? t('cron.systemJob.descHeartbeat') : null;
  // 这两个都是 `agentTurn`：内部标记串（记忆整理）与整段英文指令（技能库巡检）。
  if (kind !== 'agentTurn') return null;
  if (parsed.kind === 'memoryDreaming') {
    return payload?.message === MEMORY_DREAMING_SENTINEL ? t('cron.systemJob.descMemoryDreaming') : null;
  }
  return t('cron.systemJob.descSkillReview');
}
