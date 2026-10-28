/**
 * 修复工具的 IPC 面（FEAT-03）。
 *
 * 两条入口（`--repair` 独立窗口 / 设置页嵌入）**共用这一组通道** —— 通道里没有
 * "这个动作只有那个入口能用"这种分支，判据全在引擎里（引擎也只有一份）。
 *
 * ## 通道少而闭（五条）
 *
 * - `repair:bootstrap` 一次拿全初始状态（版本 / 形态 / 目标目录 / 语言）
 * - `repair:scan` 只读全检
 * - `repair:apply` 执行**同一次扫描里勾中的** actionId
 * - `repair:reveal` 在文件管理器里打开备份目录（白名单：只许应用自己的目录）
 * - `repair:restore` 把某一轮修复的**备份写回原路径**（T31；同一份目录白名单，活锁下拒绝）
 *
 * ⚠️ **零外联**：这一组通道里没有任何网络调用（诊断包只落盘、不上传）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { ipcMain, shell } from 'electron';
import type { LanguageCode, RepairApplyRequest, RepairBootstrap, RepairRestoreResult } from '@clawwork/shared';
import type { RepairSession } from '../repair/engine.js';
import type { RepairHost } from '../repair/host.js';
import { appOwnedRoots, isPathWithinAnyRoot } from '../repair/targets.js';

export const REPAIR_CHANNELS = {
  bootstrap: 'repair:bootstrap',
  scan: 'repair:scan',
  apply: 'repair:apply',
  reveal: 'repair:reveal',
  restore: 'repair:restore',
} as const;

export interface RepairHandlerDeps {
  session: RepairSession;
  host: RepairHost;
  language: LanguageCode | null;
}

/** `apply` 只接受字符串数组（渲染层永远不该在这一层被信）。 */
export function normalizeApplyRequest(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const ids = (payload as RepairApplyRequest).actionIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 200);
}

/**
 * 允许被"在文件管理器里打开"的目录 —— **只许应用自己的**。
 *
 * 渲染层送来一个路径就 `shell.openPath`，等于给页面开了一个任意目录打开器；
 * 而修复窗口加载的虽然是自家页面，也没有理由把它当成可信输入。
 *
 * ⚠️ 判据本体在 `repair/targets.ts` 的 `isPathWithinAnyRoot()` + `appOwnedRoots()` ——
 *    **不要在这里写第二份**：`repair:restore` 的还原目标走的是同一对函数，两处漂了，
 *    漂的那一侧就是一个**任意路径写入 / 打开**原语。
 *
 * ⚠️ **为什么打开与还原继续共用同一份根**（T31 复审收敛，2026-10-17）：`appOwnedRoots()`
 *    已收窄到"真实会被备份的那些根"（见 `targets.ts` 的详注）。打开这一侧唯一的调用者
 *    是渲染层的 `window.clawwork.repairReveal(result.backupDir)`，而 `backupDir` =
 *    `<logsRoot>/repair-<时间戳>` —— `logsRoot` **本身就在这份清单里** ⇒ 打开的合法目标
 *    落在同一份根内，**不需要更宽的根**。既然两侧需要的是同一集合，就**保持共用**而不
 *    拆成两份（拆开只会多一个漂移点，正是当年收敛成一份的理由）。
 */
export function isRevealablePath(candidate: string, host: RepairHost): boolean {
  return isPathWithinAnyRoot(candidate, appOwnedRoots(host.targets));
}

export function registerRepairHandlers(deps: RepairHandlerDeps): void {
  const { session, host } = deps;

  ipcMain.handle(REPAIR_CHANNELS.bootstrap, (): RepairBootstrap => {
    const report = session.scan();
    return {
      appVersion: host.appVersion,
      portable: host.targets.portable,
      volumeRoot: host.targets.volumeRoot,
      dataRoot: host.targets.dataRoot,
      logsRoot: host.targets.logsRoot,
      stateDirs: host.targets.stateDirs,
      scannedRoots: report.scannedRoots,
      language: deps.language,
    };
  });

  // ⚠️ 每次 `repair:scan` 都**重新扫**并替换引擎里那份计划：界面点"全检"拿到的
  //    一定是最新盘面，随后 `apply` 也只认这一份（旧 actionId 会被引擎丢掉）。
  ipcMain.handle(REPAIR_CHANNELS.scan, () => session.scan());

  ipcMain.handle(REPAIR_CHANNELS.apply, (_event, payload: unknown) => session.apply(normalizeApplyRequest(payload)));

  ipcMain.handle(REPAIR_CHANNELS.reveal, async (_event, payload: unknown) => {
    if (typeof payload !== 'string' || !isRevealablePath(payload, host)) return { ok: false };
    const target = fs.existsSync(payload) && fs.statSync(payload).isFile() ? path.dirname(payload) : payload;
    const error = await shell.openPath(target);
    return { ok: error.length === 0 };
  });

  /**
   * 还原一轮修复：`apply` 回给界面的 `backupDir` 原样送回来。
   *
   * 两条输入校验（与 `reveal` 同源）：① 必须是字符串；② 必须落在**应用自己的目录**
   * （`appOwnedRoots()`：`logsRoot` / `dataRoot` / `workspaceRoot` / 各 state 目录）里 ——
   * 否则等于给页面一个"把任意目录里的东西写回任意位置"的入口。活锁判定在引擎里（还原也是写动作）。
   * 还原**目标**（`index.json` 里的原路径）另在引擎里逐条过同一份 `appOwnedRoots()`。
   */
  ipcMain.handle(REPAIR_CHANNELS.restore, (_event, payload: unknown): RepairRestoreResult | { ok: false } => {
    if (typeof payload !== 'string' || !isRevealablePath(payload, host)) return { ok: false };
    return session.restore(payload);
  });
}
