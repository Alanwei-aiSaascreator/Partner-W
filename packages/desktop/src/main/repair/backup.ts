/**
 * 备份 + 修复记录（FEAT-03 · SPEC 三·1）。
 *
 * 「任何被修改的文件先复制到 `<运行数据>/logs/repair-<时间戳>/`；修复记录写入 `repair.log`。」
 *
 * 三条纪律：
 * 1. **懒建目录** —— 没东西要改就一个字节都不落盘。SPEC 四的对照试验
 *    （无故障盘全检 = 全绿且**零修改**）靠的就是这条：跑了修复模式，
 *    `logs/` 下不该多出任何东西。
 * 2. **备份名不取原路径** —— 原路径里有盘符与分隔符，直接镜像会撞 Windows 路径预算，
 *    也可能撞两个不同盘上的同名目录。用 `sha256(原路径)` 前 12 位 + 原名，
 *    并把「备份文件 → 原文件」的对照写进 `index.json`（用户要能自己找回来）。
 * 3. **永不抛** —— 备份失败必须让调用方**放弃那一条修改**，而不是把修到一半的现场留在盘上。
 *    所以这里返回 `null` 表示"没备份成"，由 `apply` 决定不写。
 *
 * 回滚出口是 `restoreRepairBackup()`（下面）：读回同一份 `index.json`，把备份写回原路径。
 * 之前这里只**写**不**读**，于是"回滚"只能靠人工翻目录 —— 索引没有消费者等于没有索引。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../util/json-file.js';
import { isRegularFileNoFollow } from './safe-fs.js';

/** 备份目录名的时间戳（本地时间、文件名安全；与 `-` / `:` 无关）。 */
export function repairRunStamp(now: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    'T',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

export function repairBackupDirFor(logsRoot: string, stamp: string): string {
  return path.join(logsRoot, `repair-${stamp}`);
}

/** 备份文件名：稳定（同一原路径永远同一名字）+ 唯一（不同原路径不会撞）。 */
export function backupFileNameFor(originalPath: string): string {
  const digest = createHash('sha256').update(path.resolve(originalPath).toLowerCase()).digest('hex').slice(0, 12);
  const base = path.basename(originalPath) || 'item';
  return `${digest}-${base}`;
}

/**
 * 一轮修复现场的形状。
 *
 * ⚠️ **不导出**（2026-10-16，`knip` 报的未使用导出）：它没有外部消费者 —— 真正的载体是
 *    下面的 `RepairBackup` 类（字段即本形状）。留着它是为了把"一轮现场包含哪三样"写在一处。
 */
interface RepairBackupJournal {
  /** 主进程启动时刻那一轮备份的目录。 */
  dir: string;
  /** 追加写的修复记录。 */
  logPath: string;
  /** 备份文件 → 原文件（写进 `index.json`）。 */
  entries: Record<string, string>;
}

/** 一轮修复的现场：目录**惰性**建。 */
export class RepairBackup {
  readonly dir: string;
  readonly logPath: string;
  private readonly entries: Record<string, string> = {};
  private created = false;

  constructor(
    private readonly logsRoot: string,
    stamp: string,
  ) {
    this.dir = repairBackupDirFor(logsRoot, stamp);
    this.logPath = path.join(this.dir, 'repair.log');
  }

  /** 这一轮磁盘上到底有没有留下东西（一个字节都没写 ⇒ `apply` 报告 null，不谎报一个空目录）。 */
  get dirExists(): boolean {
    return this.created;
  }

  ensureDir(): boolean {
    if (this.created) return true;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.created = true;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 备份一个文件。返回备份副本的绝对路径；**备份不成返回 null**（调用方必须放弃修改）。
   *
   * 目录（极少数情况）不走这条：本批所有写动作都对**文件**，目录只被"重命名隔离"。
   */
  backupFile(originalPath: string): string | null {
    const target = path.join(this.dir, backupFileNameFor(originalPath));
    try {
      if (!this.ensureDir()) return null;
      fs.copyFileSync(originalPath, target);
      this.entries[path.basename(target)] = originalPath;
      this.writeIndex();
      return target;
    } catch {
      return null;
    }
  }

  /** 一个字节都没改过的文件不该留下备份副本（幂等重跑时会把上一轮的备份变脏）。 */
  private writeIndex(): void {
    try {
      writeJsonAtomic(path.join(this.dir, 'index.json'), this.entries);
    } catch {
      // 索引写不出不影响"备份本身存在"这件事；不抛
    }
  }

  /** 追加一条修复记录（`repair.log`）。**永不抛**。 */
  log(line: string): void {
    try {
      if (!this.ensureDir()) return;
      fs.appendFileSync(this.logPath, `${new Date().toISOString()} ${line}\n`, 'utf8');
    } catch {
      // 记录写不进去不能把修复本身掀翻
    }
  }
}

/**
 * 读一轮修复的**备份索引**（`index.json`：备份文件名 → 原文件绝对路径）。
 *
 * 不存在 / 坏 JSON / 不是对象 ⇒ `null`（调用方如实报"这一轮没有可回滚的东西"）。
 * 值按**盘上的不可信输入**校验：只收非空绝对路径，其余条目当场丢掉
 * （索引是纯文本文件，谁都能改；拿它去 copyFile 等于用别人的输入当目标路径）。
 */
export function readRepairBackupIndex(backupDir: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(backupDir, 'index.json'), 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const out: Record<string, string> = {};
  for (const [name, original] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof name !== 'string' || name.length === 0 || name.includes('/') || name.includes('\\')) continue;
    if (typeof original !== 'string' || original.length === 0 || !path.isAbsolute(original)) continue;
    out[name] = original;
  }
  return out;
}

/** 一轮还原的结果（**永不抛**；每一项都如实计数）。 */
export interface RepairRestoreReport {
  dir: string;
  /** 索引里的条目数（可还原的候选）。 */
  total: number;
  /** 备份副本已不在（索引在、字节没了）—— 还原不了。 */
  missing: string[];
  /** 原路径现在不是普通文件（目录 / 链接）⇒ 拒绝覆盖（同 `safe-fs` 的红线）。 */
  refused: string[];
  /** 真正写回去的原路径。 */
  restored: string[];
  failed: Array<{ path: string; error: string }>;
  /** 这一轮没有可用的索引（`index.json` 不存在 / 读不出来）。 */
  indexMissing: boolean;
}

/** 还原的可选/必填输入面。 */
export interface RepairRestoreOptions {
  /**
   * ⚠️ **必填**：这条**目标**路径允不允许被写回。
   *
   * 索引是盘上的**不可信输入**（谁都能改修复备份目录里的 `index.json`）——不过这一道，
   * "点一下撤销"就变成"把任意文件覆写成我准备的字节"的**任意文件覆写**原语。
   * 调用方用 `targets.ts` 的 `appOwnedRoots()` 构造它（与打开目录同一份判据）。
   */
  isAllowedTarget: (absolutePath: string) => boolean;
}

/**
 * ⭐ 把一轮修复的**备份写回原路径**（FEAT-03 · SPEC 三·1 的"回滚"出口）。
 *
 * 语义（与备份那三条纪律一一对应）：
 *  · **只还原索引里登记过的**（备份文件 → 原文件）。索引里没有的字节一律不碰。
 *  · **目标不在应用自己的目录里 ⇒ 拒绝**（`isAllowedTarget`；见上面的安全说明）。
 *  · **原路径现在是链接 / 目录 ⇒ 拒绝**（`isRegularFileNoFollow` 同一条红线：
 *    顺着链接写会写到链接指向的真身上）。拒绝的进 `refused`，不当成功。
 *  · **原路径不存在**是合法状态（隔离把文件改名走了）⇒ 重新创建父目录并写回。
 *  · 单条失败不中断其余条目：逐条计数，整体结果由调用方**如实**决定怎么说。
 *
 * ⚠️ 不做"删掉备份目录"这种收尾：回滚本身不产生新的破坏性动作，备份留着用户还能再来一次。
 */
export function restoreRepairBackup(backupDir: string, options: RepairRestoreOptions): RepairRestoreReport {
  const report: RepairRestoreReport = {
    dir: backupDir,
    total: 0,
    missing: [],
    refused: [],
    restored: [],
    failed: [],
    indexMissing: false,
  };
  const index = readRepairBackupIndex(backupDir);
  if (!index) {
    report.indexMissing = true;
    return report;
  }
  const names = Object.keys(index);
  report.total = names.length;

  for (const name of names) {
    const original = index[name]!;
    // ① **先判目标**：不在应用自己的目录里 ⇒ 拒绝（不 lstat、不 mkdir、不写）。
    if (!options.isAllowedTarget(original)) {
      report.refused.push(original);
      continue;
    }
    const copy = path.join(backupDir, name);
    // ② 备份副本**本身**必须是普通文件（同样是"不顺链接走"那条红线）。
    if (!isRegularFileNoFollow(copy)) {
      report.missing.push(original);
      continue;
    }
    // ③ 原路径现在的东西必须也是普通文件（不存在 ⇒ 允许重建；目录 / 链接 ⇒ 拒绝）。
    const existing = fs.lstatSync(original, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) {
      report.refused.push(original);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(original), { recursive: true });
      fs.copyFileSync(copy, original);
      report.restored.push(original);
    } catch (error) {
      report.failed.push({ path: original, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}
