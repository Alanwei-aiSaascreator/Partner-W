/**
 * 开机随包技能自装（渲染层入口）——把主进程 `skills:our-ensure` 的答复规整成
 * 一个**可判定、可展示**的结果（2026-10-11 升级补齐）。
 *
 * ⭐ 这一层最重要的一件事：**failed 与 conflicts 是两回事**。
 *
 *   · `failed`   —— 装/升失败（网关没热、写盘出错…）：**可重试**，重试有封顶；
 *   · `conflicts`—— 我们在装的那份被用户改过（`user-modified`）或来源存疑
 *                  （`unverified-origin`）：**终态**。主进程**保留用户文件**，
 *                  开机绝不替用户做"替换"这个决定 —— 重试一百次也是同一个冲突，
 *                  所以这里**不重试**；出路是用户在技能市场走「修复随包版本」
 *                  （显式安装 = confirmed-repair，会先留备份）。
 *
 * ⚠️ 直接后果：`failed.length === 0` **不等于**"新技能全生效"。有冲突时技能同样
 *    没升上去（只是原因在用户那一边）—— 判定必须走 {@link BundledSkillsOutcome.allEffective}。
 *
 * 尽力而为：这个函数从不抛（异常收成 `completed:false`），调用方（启动流程）
 * 不该因为技能装不上卡住用户。
 */

export interface BundledSkillConflict {
  slug: string;
  /** `user-modified`（用户改过）｜`unverified-origin`（无账/旧账，来源存疑）。 */
  reason: string;
  /** 冲突涉及的具体文件（相对技能目录）。 */
  paths: string[];
}

export interface BundledSkillFailure {
  slug: string;
  error: string;
}

export interface BundledSkillsOutcome {
  /** 至少有一次拿到了结构完整的答复（`ok:true` + `result`）。 */
  completed: boolean;
  installed: string[];
  upgraded: string[];
  adopted: string[];
  conflicts: BundledSkillConflict[];
  failed: BundledSkillFailure[];
  /** 随包技能是否**全部生效**：拿到了答复、没有失败、**也没有冲突**。 */
  allEffective: boolean;
}

interface EnsureSkillsResult {
  ok: boolean;
  result?: {
    installed?: string[];
    upgraded?: string[];
    adopted?: string[];
    conflicts?: Array<{ slug?: unknown; reason?: unknown; paths?: unknown }>;
    failed?: Array<{ slug?: unknown; error?: unknown }>;
  };
  error?: string;
}

interface EnsureBundledSkillsDeps {
  ensure: (gatewayId: string) => Promise<EnsureSkillsResult>;
  sleep: (ms: number) => Promise<void>;
  delaysMs: readonly number[];
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function normalizeConflicts(value: unknown): BundledSkillConflict[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is { slug: string; reason: unknown; paths: unknown } => {
      return Boolean(entry) && typeof (entry as { slug?: unknown }).slug === 'string';
    })
    .map((entry) => ({
      slug: entry.slug,
      reason: typeof entry.reason === 'string' ? entry.reason : 'unknown',
      paths: toStringArray(entry.paths),
    }));
}

function normalizeFailures(value: unknown): BundledSkillFailure[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is { slug: string; error: unknown } => {
      return Boolean(entry) && typeof (entry as { slug?: unknown }).slug === 'string';
    })
    .map((entry) => ({
      slug: entry.slug,
      error: typeof entry.error === 'string' ? entry.error : 'unknown',
    }));
}

function emptyOutcome(completed: boolean): BundledSkillsOutcome {
  return { completed, installed: [], upgraded: [], adopted: [], conflicts: [], failed: [], allEffective: false };
}

function normalizeResult(result: NonNullable<EnsureSkillsResult['result']>): BundledSkillsOutcome {
  const installed = toStringArray(result.installed);
  const upgraded = toStringArray(result.upgraded);
  const adopted = toStringArray(result.adopted);
  const conflicts = normalizeConflicts(result.conflicts);
  const failed = normalizeFailures(result.failed);
  return {
    completed: true,
    installed,
    upgraded,
    adopted,
    conflicts,
    failed,
    allEffective: failed.length === 0 && conflicts.length === 0,
  };
}

export async function ensureBundledSkillsWithRetry(
  gatewayId: string,
  deps: EnsureBundledSkillsDeps,
): Promise<BundledSkillsOutcome> {
  let outcome: BundledSkillsOutcome | null = null;
  for (let attempt = 0; attempt <= deps.delaysMs.length; attempt += 1) {
    try {
      const result = await deps.ensure(gatewayId);
      if (result.ok && result.result) {
        outcome = normalizeResult(result.result);
        // ⚠️ **冲突不算失败**：重试一次还是同一个冲突（用户改过的文件不会自己变回去），
        //    算失败只会让启动流程白重试两次、还把用户的问题说成"我们没装上"。
        if (outcome.failed.length === 0) return outcome;
      }
    } catch {}
    const delay = deps.delaysMs[attempt];
    if (delay === undefined) break;
    await deps.sleep(delay);
  }
  return outcome ?? emptyOutcome(false);
}

// ─────────────────────────── 报告（供界面消费） ───────────────────────────

/**
 * 最近一次开机自装里**需要用户知道**的部分。
 *
 * 为什么要有它：冲突不是"启动失败"，不能挡启动；但它也不能被静默吞掉 ——
 * 用户改过的技能没升级成功，得有人告诉他，并把既有修复入口指给他
 * （设置 → 技能 里显示受影响技能 → 技能市场「修复随包版本」）。
 */
export interface BundledSkillsReport {
  gatewayId: string;
  conflicts: BundledSkillConflict[];
  failed: BundledSkillFailure[];
  /** slug → 人类可读名（解析不到就是空表：界面退回显示 slug）。 */
  names: Record<string, string>;
  updatedAt: number;
  /**
   * ⭐ B3（2026-10-11 整改 · 复审二轮）：发布这份报告的**工作区代次**（发布方已知时）。
   * 手动操作（修复/安装）成功后的收敛要复核作用域时用它（见
   * {@link reconcileBundledSkillsAfterResolvedSkill}）；旧格式/测试构造的报告没有它，
   * 那时代次判据自动退化为"代次未知"（不参与拦截，轮次仍然拦着）。
   */
  workspaceEpoch?: number;
}

/**
 * 受影响技能的展示串（「幻灯版面（自己排）、商务演示（模板版）」）。
 *
 * 名字解析不到就用 slug —— 提示可以技术一点，但**不能没有**。
 */
export function formatBundledSkillNames(
  entries: ReadonlyArray<{ slug: string }>,
  names: Readonly<Record<string, string>>,
): string {
  return entries.map((entry) => names[entry.slug] || entry.slug).join('、');
}

let report: BundledSkillsReport | null = null;
const reportListeners = new Set<() => void>();
let conflictsNotified = false;

/**
 * ⭐ B3（复审二轮）：**报告轮次**（单调，只增）。
 *
 * ⚠️ 四轮（2026-10-11）起角色收窄为**旧格式兼容**：真实报告始终带 `workspaceEpoch`，
 * 作用域归属由 (gatewayId, workspaceEpoch) + 成功序号账本判定（见
 * {@link reconcileBundledSkillsAfterResolvedSkill} /
 * {@link mergeBundledSkillsSuccessfulOperations}）。"报告被写过"本身**不再是**操作结论
 * 作废的理由 —— 那会卡死"名称先返回、成功后到"的合法收敛（复审 P2 #1）。轮次整表判据
 * 只留给缺 `workspaceEpoch` 的旧格式/测试报告（迁移兼容分支）。
 */
let reportRevision = 0;

/** 当前报告轮次（调用方在流程开始/收口时捕获、对比）。 */
export function currentBundledSkillsReportRevision(): number {
  return reportRevision;
}

/**
 * ⭐ B3：推进一次报告轮次（即便报告内容没变化）。四轮（2026-10-11）起只服务
 * **缺 `workspaceEpoch` 的旧格式报告**的兼容护栏（当前唯一调用点 = reconcile 的
 * 旧格式"已被更晚结论写过"分支）；真实路径的操作结论不再靠轮次围栏 —— 成功记入
 * 成功账本、由在飞 ensure 合并（见 {@link mergeBundledSkillsSuccessfulOperations}）。
 */
export function markBundledSkillsReportOperation(): void {
  reportRevision += 1;
}

export function publishBundledSkillsReport(next: BundledSkillsReport): void {
  report = next;
  reportRevision += 1;
  for (const listener of reportListeners) listener();
}

export function getBundledSkillsReport(): BundledSkillsReport | null {
  return report;
}

export function subscribeBundledSkillsReport(listener: () => void): () => void {
  reportListeners.add(listener);
  return () => {
    reportListeners.delete(listener);
  };
}

export function clearBundledSkillsReport(): void {
  if (report === null) return;
  report = null;
  reportRevision += 1;
  for (const listener of reportListeners) listener();
}

/**
 * ⭐ B3：手动技能操作的**作用域捕获**（在操作发起那一刻取，成功回来后交给
 * {@link reconcileBundledSkillsAfterResolvedSkill} 复核；在飞 ensure 侧用
 * {@link mergeBundledSkillsSuccessfulOperations} 合并）。
 *
 * 判据两件（四轮 2026-10-11 起）：**真实网关 + 真实工作区代次** —— 由调用方从 store 读
 * 当下值（`useUiStore.defaultGatewayId` / `useTaskStore.workspaceEpoch`），**绝不从现有
 * 报告反推**（首份报告可以是 `null`）；成功按 (gateway, epoch) 记入一个**只增的成功序号**
 * 账本。"报告被写过"本身不再是判据（复审 P2 #1：名称先返回会卡死后到的成功收敛）。
 *
 * `revision` 仅为**兼容缺 `workspaceEpoch` 的旧格式/测试报告**保留的轮次护栏。
 */
export interface BundledSkillsOperationScope {
  gatewayId: string;
  /** 旧格式（无 epoch）报告沿用的轮次护栏；真实路径不再消费。 */
  revision: number;
  workspaceEpoch: number;
  /** 捕获时的全局成功序号：只有**大于**它的成功才算"本次操作期间新解决"（见 merge）。 */
  successSequence: number;
}

export function captureBundledSkillsOperationScope(
  gatewayId: string,
  workspaceEpoch = report?.workspaceEpoch ?? 0,
): BundledSkillsOperationScope {
  return { gatewayId, workspaceEpoch, revision: reportRevision, successSequence };
}

/**
 * ⭐ B3（2026-10-11 整改）：操作成功（「修复随包版本」的 confirmed-repair / 缺装技能
 * 的手动安装）后，把报告里**这一个网关、这一个 slug** 的条目收敛掉。
 *
 * 为什么必须收敛：报告（设置 → 技能 的常驻提示）的下一次全量重算是下一次开机 ensure；
 * 用户在这里修好了、提示却还挂着，读起来就是"修了没用"。操作成功**本身就是重验结论**
 * （主进程的 confirmed-repair 会重写厂商文件并逐字节核验，失败会以 `ok:false` 回来；
 * 安装同理），所以 `ok:true` ⇒ 这个 slug 的冲突/失败已经解决。
 *
 * 边界（四轮 2026-10-11 口径："只清本次确实解决的项 + 旧完成不许回写新状态 +
 * **报告发布不冻结操作结论**"）：
 *  - 复核作用域 = **发起时捕获的 (网关, 代次)** vs **当下 store 的 (网关, 代次)**；
 *    不一致（旧网关/旧工作区回调）⇒ 直接退出 —— 报告与成功账本一个副作用都不留
 *    （旧实现会顺手推进轮次，把当前 ensure 的整份结论围栏掉，复审 P2 #2b）；
 *  - 一致 ⇒ 先把这次成功记入 (gateway, epoch) 的成功账本（序号只增）：在飞的旧 ensure
 *    靠它把已修 slug 从结论里滤掉（复审 P2 #1：名称先返回不再卡死后到的成功收敛）；
 *  - 只动 `gatewayId`+代次相符的那份报告（别的网关/工作区的报告一个字节都不许碰）；
 *  - 只清 `slug` 相符的项，其他冲突/失败原样保留；两项都清空 ⇒ 整份报告撤下。
 */
export function reconcileBundledSkillsAfterResolvedSkill(
  scope: BundledSkillsOperationScope,
  slug: string,
  currentScope: { gatewayId: string | null; workspaceEpoch: number },
): void {
  // 旧网关/旧工作区的完成回调：不许改任何当前账本或报告（含全局轮次）。
  if (scope.gatewayId !== currentScope.gatewayId || scope.workspaceEpoch !== currentScope.workspaceEpoch) return;
  const key = bundledSkillsScopeKey(scope);
  const successes = successesByScope.get(key) ?? new Map<string, number>();
  successes.set(slug, ++successSequence);
  successesByScope.set(key, successes);
  const current = getBundledSkillsReport();
  if (!current || current.gatewayId !== scope.gatewayId) return;
  if (current.workspaceEpoch !== undefined && current.workspaceEpoch !== scope.workspaceEpoch) return;
  // 兼容分支（仅限缺 workspaceEpoch 的旧格式报告；真实 ensure 报告始终带代次）：
  // 旧协议下"已被更晚结论写过"的报告沿用"推进轮次 + 内容不动"（新协议路径不消费轮次）。
  if (current.workspaceEpoch === undefined && reportRevision !== scope.revision) {
    markBundledSkillsReportOperation();
    return;
  }
  const conflicts = current.conflicts.filter((entry) => entry.slug !== slug);
  const failed = current.failed.filter((entry) => entry.slug !== slug);
  if (conflicts.length === current.conflicts.length && failed.length === current.failed.length) return;
  if (conflicts.length === 0 && failed.length === 0) {
    clearBundledSkillsReport();
    return;
  }
  publishBundledSkillsReport({ ...current, conflicts, failed, updatedAt: Date.now() });
}

/** 「本次应用生命周期里冲突提示弹过了吗」：第一次 true，之后 false。 */
export function claimBundledSkillConflictNotification(): boolean {
  if (conflictsNotified) return false;
  conflictsNotified = true;
  return true;
}

/** 测试用：整表复位（模块级状态）。 */
export function resetBundledSkillsReportForTests(): void {
  report = null;
  conflictsNotified = false;
  reportListeners.clear();
  reportRevision = 0;
  successSequence = 0;
  successesByScope.clear();
}

// ───────────── 成功账本（四轮 2026-10-11）：每个 (网关, 代次) 下每个 slug 的最近成功序号 ─────────────

let successSequence = 0;
const successesByScope = new Map<string, Map<string, number>>();

function bundledSkillsScopeKey(scope: { gatewayId: string; workspaceEpoch: number }): string {
  return JSON.stringify([scope.gatewayId, scope.workspaceEpoch]);
}

/**
 * ⭐ B3 四轮（2026-10-11）：把**本次 ensure 开始之后**已确认成功的 slug 从这次结论里滤掉。
 *
 * 为什么需要它：ensure 是异步的（重试 + 名称解析）。开始时的报告快照与成功账本都会变；
 * 旧实现用"报告轮次"做整表围栏 —— 一旦期间有成功回调/报告发布就把**整份结论**丢掉，
 * 导致其余未解决项一起消失（复审 P2 #2a/#2b）。
 *
 * 语义（两个时序都正确）：
 *  - 成功先、报告后：成功账本记住 slug；本次 ensure 的结论里滤掉它，**其余未解决项照常
 *    首次发布**（此前报告可以是 `null`）；
 *  - 报告先、成功后：成功回调按结果收敛报告（见 reconcile…），发布报告不再冻结结论。
 *
 * 只滤"序号 **大于**本次开始序号"的成功：更早的成功不会掩盖**重新出现**的冲突 ——
 * 下一轮 ensure 照常报告它（成功不写回、冲突不消失）。
 */
export function mergeBundledSkillsSuccessfulOperations(
  scope: BundledSkillsOperationScope,
  outcome: BundledSkillsOutcome,
): BundledSkillsOutcome {
  const successes = successesByScope.get(bundledSkillsScopeKey(scope));
  const unresolved = (item: { slug: string }): boolean => (successes?.get(item.slug) ?? 0) <= scope.successSequence;
  const conflicts = outcome.conflicts.filter(unresolved);
  const failed = outcome.failed.filter(unresolved);
  return {
    ...outcome,
    conflicts,
    failed,
    allEffective: outcome.completed && conflicts.length === 0 && failed.length === 0,
  };
}
