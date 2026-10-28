/**
 * 修复项 · 技能安装记录（FEAT-03 扩展；T31 缺口 2/3）。
 *
 * ## 为什么需要这一项
 *
 * 随包技能的"这是谁装的、装的是哪一版"记在配置的 `bundledSkillRecords` 里，而**键是
 * 安装目录**（网关报的 `managedSkillsDir`，实测 = `<stateDir>/skills`）。键一旦变了
 * （换网关 / 换盘 / 目录布局变过），旧键就成了**孤儿**：
 *
 *  · 新键下没有账 ⇒ 开机 ensure 把"我们自己装的旧版"判成**未知来源** ⇒ 健康盘上冒
 *    一屏"需要你处理"的**虚假冲突**（其实一个字节都不该动）。
 *  · 而"换网关"恰恰是**应用可能起不来**的时刻（网关连不上 ⇒ `skills:our-ensure`
 *    那条自愈通路根本跑不到）—— 那正是 `--repair` 存在的意义。
 *
 * 所以这一项要做的事只有一件：**把孤儿键的技能账迁移到当前托管目录键**。
 *
 * ## 三条与整支工具一致的纪律
 *
 * 1. **只读扫描**：`planSkillRecords()` 不写盘，产出"发现了什么 + 打算改哪个文件"。
 * 2. **保守**：只有"旧键的目录**已经不在盘上**"才认它是孤儿。目录还在的键一律不动
 *    （那可能只是这次没扫到的另一块盘/另一套 state，动它就是**猜**）。
 * 3. **幂等**：迁完之后旧键没了 ⇒ 下一次扫描零动作、零写盘。
 */

import path from 'node:path';
import type { RepairMessage } from '@clawwork/shared';

/**
 * 盘上**真实存在**的技能安装目录（`<stateDir>/skills`）。
 *
 * ⚠️ 与网关实测口径一致：openclaw 的 `managedSkillsDir = path.join(stateDir, 'skills')`
 *   （运行时 `status-*.mjs`），`state-config.ts` 的技能账迁移也用同一个式子。
 *   这是**读**出来的约定，不是猜的。
 */
export function managedSkillsDirFor(stateDir: string): string {
  return path.join(stateDir, 'skills');
}

/** 一条账（slug → `pkg2:` 编码字符串）。键 = 托管目录绝对路径。 */
export type SkillRecords = Record<string, Record<string, string>>;

export interface SkillRecordsMigration {
  /** 迁入的当前托管目录（`<stateDir>/skills`）。 */
  target: string;
  /** 被迁走的旧键（目录已不在盘上）。 */
  sources: string[];
  /** 迁移后的整份账（`sources` 已剔除；`target` 的既有条目优先保留）。 */
  next: SkillRecords;
  /** 真正搬过去的技能条数（`target` 已有的同名条目不计）。 */
  count: number;
}

export interface SkillRecordsPlan {
  findings: RepairMessage[];
  actions: import('@clawwork/shared').RepairAction[];
  blocked: RepairMessage[];
  skipped: RepairMessage[];
  /** `apply` 用的迁移决定（`null` = 无事可做）。 */
  migration: SkillRecordsMigration | null;
}

/** 规范化成可比的键（Windows 大小写不敏感、去尾分隔符；同 `targets.ts` 的手法）。 */
function normalized(value: string): string {
  return path
    .resolve(value)
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

export interface SkillRecordsInput {
  /** 盘上发现的 state 目录。 */
  stateDirs: readonly string[];
  /** 配置里那份账（键 = 托管目录）。 */
  records: Readonly<SkillRecords>;
  /** 一个绝对路径在盘上存不存在（目录也算存在）。测试可注入。 */
  pathExists: (absolutePath: string) => boolean;
}

/**
 * 纯函数：算出"要不要迁、迁到哪、迁完是什么样"。
 *
 * 判据（按顺序）：
 *  · 没有任何账 ⇒ `ok`，无动作（`skill.none`）。
 *  · 一个 state 目录都没扫到 ⇒ `skipped`（`skill.no-state`）—— 不知道当前托管目录在哪，
 *    **绝不猜**。
 *  · 有孤儿可迁、但当前托管目录不唯一（多个 state 且其中一个已经带账 ⇒ 用带账的那个；
 *    否则无从判定）⇒ `blocked`（`skill.ambiguous`），保持原样。
 */
export function planSkillRecords(input: SkillRecordsInput): SkillRecordsPlan {
  const records = input.records;
  const keys = Object.keys(records);

  if (keys.length === 0) {
    return { findings: [{ code: 'skill.none' }], actions: [], blocked: [], skipped: [], migration: null };
  }

  const liveDirs = input.stateDirs.map(managedSkillsDirFor);
  if (liveDirs.length === 0) {
    return {
      findings: [],
      actions: [],
      blocked: [],
      skipped: [{ code: 'skill.no-state' }],
      migration: null,
    };
  }

  const liveNormalized = new Set(liveDirs.map(normalized));
  // 孤儿 = 不在当前 state 集合里、**且目录已经不在盘上**的键。目录还在的一律不动。
  const sources = keys.filter((key) => !liveNormalized.has(normalized(key)) && !input.pathExists(key));

  if (sources.length === 0) {
    return { findings: [{ code: 'skill.matched' }], actions: [], blocked: [], skipped: [], migration: null };
  }

  const recordedTargets = liveDirs.filter((dir) => Object.prototype.hasOwnProperty.call(records, dir));
  const target = recordedTargets[0] ?? (liveDirs.length === 1 ? liveDirs[0]! : null);
  if (!target) {
    return {
      findings: [{ code: 'skill.orphan', params: { count: sources.length } }],
      actions: [],
      blocked: [{ code: 'skill.ambiguous' }],
      skipped: [],
      migration: null,
    };
  }

  const next: SkillRecords = {};
  for (const [key, value] of Object.entries(records)) {
    if (!sources.includes(key)) next[key] = { ...value };
  }
  const merged: Record<string, string> = { ...(next[target] ?? {}) };
  let count = 0;
  for (const source of sources) {
    for (const [slug, value] of Object.entries(records[source] ?? {})) {
      // 当前键已经记过同一个 slug ⇒ 保留当前键那份（它才是"这一版"的账）。
      if (Object.prototype.hasOwnProperty.call(merged, slug)) continue;
      merged[slug] = value;
      count += 1;
    }
  }
  next[target] = merged;

  const migration: SkillRecordsMigration = { target, sources, next, count };
  const action: import('@clawwork/shared').RepairAction = {
    actionId: 'skill-records:migrate',
    code: 'skill.migrate',
    params: { path: target, count },
    requiresConfirmation: false,
    backup: true,
    targets: [target],
  };
  return {
    findings: [{ code: 'skill.orphan', params: { count: sources.length } }],
    actions: [action],
    blocked: [],
    skipped: [],
    migration,
  };
}
