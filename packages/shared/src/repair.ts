/**
 * 修复工具（FEAT-03）的**跨层形状** —— 主进程引擎 → IPC → preload → 渲染层。
 *
 * 为什么定义在 shared：形状要跨四层，每层各写一遍就会漂（同 `RuntimeDeployProgress`）。
 *
 * ## 一条硬纪律：主进程不上屏**人话**
 *
 * 引擎只回**机器码 + 参数**，界面用 `t('settings.repair.code.<code>', params)` 出一句话。
 * 理由与 `runtime/bootstrap-status.ts` 同源：这条通道要跨三道边界、进得了截图，而且
 * 九语言要能各自说清楚 —— 主进程拼好的中文句子在 de/en/ja 里就是一句天书。
 * 参数只准放**路径 / 计数 / 版本号**这类本身不翻译的东西。
 *
 * ⚠️ 与 `RuntimeBootstrapStatus` 的差别：这里**必须**带路径。修复工具的全部意义就是
 *    "改哪个文件、备份在哪儿"，把路径摘了界面就没法让人确认（SPEC 三·3「每项可预览」）。
 */

/**
 * 修复项白名单，**共六项**。顺序即界面顺序。
 *
 * - 前五项 = SPEC 二·MVP 五项（盘上坏锁 / 失效插件路径 / 提示词区块 / 运行环境自查 / 诊断包）。
 * - 第六项 `skill-records` = **2026-10-16 T31 的 SPEC 扩展**（待 Codex 复核）：
 *   随包技能的账按 `managedSkillsDir` 做键，换网关/换盘后旧键成孤儿 ⇒ 健康盘上冒
 *   "未知来源"的虚假冲突；而那正是"网关连不上"、ensure 那条自愈通路跑不到的时刻 ——
 *   只有 `--repair` 够得着它。它是**只迁账**的保守修复（目录已不在盘上的旧键才算孤儿）。
 */
export const REPAIR_ITEM_IDS = [
  'gateway-locks',
  'plugin-paths',
  'capability-block',
  'environment',
  'diagnostics-pack',
  'skill-records',
] as const;

export type RepairItemId = (typeof REPAIR_ITEM_IDS)[number];

/**
 * 单项健康度。
 *
 * - `ok`      没问题（也不会有待办动作）
 * - `attention` 有可修的东西，但用户不点就什么都不改
 * - `broken`  有坏东西且**修不了**（只报告；例如悬空链接的目标在新盘上不存在）
 * - `blocked` 探测本身做不了（目录不存在、读不出来）—— 如实说，不当成"没问题"
 */
export const REPAIR_SEVERITIES = ['ok', 'attention', 'broken', 'blocked'] as const;
export type RepairSeverity = (typeof REPAIR_SEVERITIES)[number];

/** 参数只放路径 / 计数 / 版本号（不翻译的东西）。 */
export type RepairMessageParams = Record<string, string | number>;

/** 一条可上屏的消息 = 机器码 + 参数。 */
export interface RepairMessage {
  code: string;
  params?: RepairMessageParams;
}

/** 一个"我准备改这个文件"的动作（SPEC 三·3 的干跑视图）。 */
export interface RepairAction {
  /** 稳定 id（勾选框用它）—— 同一份扫描结果里唯一。 */
  actionId: string;
  /** 这个动作会做什么（机器码）。 */
  code: string;
  params?: RepairMessageParams;
  /** SPEC 三·4：杀进程 / 熔断重置必须显式确认，默认不勾。 */
  requiresConfirmation: boolean;
  /** 会不会先备份（本批所有写动作都是 true；留着是为了把"不备份的动作"显式说出来）。 */
  backup: boolean;
  /** 会被改到的文件（预览列表直接用）。 */
  targets: string[];
}

export interface RepairItemReport {
  id: RepairItemId;
  severity: RepairSeverity;
  /** 探测到的事实（每条一句话，机器码）。 */
  findings: RepairMessage[];
  /** 待办动作；用户不勾就不执行。 */
  actions: RepairAction[];
  /** SPEC 三·6：修不了的，如实列出来 —— 绝不伪造"已修复"。 */
  blocked: RepairMessage[];
  /** 这套环境下不适用（例如不是盘上运行）—— 与"没问题"分开说。 */
  skipped: RepairMessage[];
}

export interface RepairScanReport {
  items: RepairItemReport[];
  /**
   * SPEC 四「修复模式下与正常实例可共存——或至少安全提示」。
   *
   * 非 null = 本机有一份Partner-W（或本机网关）正在跑 ⇒ **所有写动作一律不执行**，
   * 界面只给"请先完全退出"的指引。只读的全检与诊断包导出不受影响。
   */
  liveInstance: RepairMessage | null;
  /** 扫描时刻（epoch ms）—— 界面显示"什么时候看的"。 */
  scannedAt: number;
  /** 这次扫描到底看了哪些目录（没有它，"全绿"是不可证的）。 */
  scannedRoots: string[];
}

export interface RepairApplyRequest {
  /** 只允许来自**同一份**扫描结果里的 actionId（引擎自己再核一遍）。 */
  actionIds: string[];
}

export const REPAIR_OUTCOME_STATUSES = ['applied', 'skipped', 'failed'] as const;
export type RepairOutcomeStatus = (typeof REPAIR_OUTCOME_STATUSES)[number];

export interface RepairOutcome {
  actionId: string;
  status: RepairOutcomeStatus;
  /** 为什么是这个结果（机器码）。 */
  message: RepairMessage;
  /** 这一条动作备份出来的副本（没备份就是 null）。 */
  backupPath: string | null;
}

export interface RepairApplyResult {
  outcomes: RepairOutcome[];
  /** 这一轮的备份目录（SPEC 三·1：`<运行数据>/logs/repair-<时间戳>/`）。 */
  backupDir: string | null;
  /** 追加写的修复记录文件。 */
  logPath: string | null;
}

export interface RepairDiagnosticsResult {
  ok: boolean;
  /** 诊断包落盘的位置（盘根）。失败时为 null。 */
  path: string | null;
  message: RepairMessage;
}

/**
 * 还原一轮修复的结果（T31 · 缺口 1）。
 *
 * `reason` 是**机器码**（界面按 `settings.repair.restore.<reason>` 出句子）：
 * - `restored`  全部写回
 * - `partial`   写回了一部分（有备份丢失 / 原路径现在是链接或目录 / 写入失败）
 * - `nothing`   索引为空或这一轮压根没备份过
 * - `no-index`  这个目录不是一轮修复的备份目录（没有 `index.json`）
 * - `blocked-live-instance` 本机有一份在跑 ⇒ 拒绝写（与 apply 同一条纪律）
 */
export const REPAIR_RESTORE_REASONS = ['restored', 'partial', 'nothing', 'no-index', 'blocked-live-instance'] as const;
export type RepairRestoreReason = (typeof REPAIR_RESTORE_REASONS)[number];

export interface RepairRestoreResult {
  ok: boolean;
  reason: RepairRestoreReason;
  /** 被还原的那一轮备份目录（原样回传，界面放路径）。 */
  dir: string;
  /** 索引里的条目数。 */
  total: number;
  restored: number;
  /** 备份副本已不在。 */
  missing: number;
  /** 原路径现在不是普通文件（目录 / 链接）⇒ 拒绝覆盖。 */
  refused: number;
  /** 写回失败。 */
  failed: number;
}

/** 修复窗口/设置页挂上来时**一次拿全**的初始状态。 */
export interface RepairBootstrap {
  appVersion: string;
  /** 是不是盘上运行（决定界面说"盘"还是"这台电脑"）。 */
  portable: boolean;
  volumeRoot: string | null;
  dataRoot: string;
  logsRoot: string;
  stateDirs: string[];
  /** 这次扫描到底看了哪些目录（没有它，"全绿"不可证）。 */
  scannedRoots: string[];
  language: string | null;
}
