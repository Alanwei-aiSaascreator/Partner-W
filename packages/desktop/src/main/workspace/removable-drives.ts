/**
 * 可移动盘列表 —— **进程内记忆一次**。
 *
 * ⚠️ 底层 `listRemovableDrives()` 是 PowerShell 枚举（秒级；Win11 24H2 已没有 wmic），
 *    而这份列表在启动判定、换工作区、自愈里都要用。每次现算等于每次开一个进程。
 *
 * ⚠️ 枚举失败会返回空数组（`locate.ts` 的刻意设计：启动路径上的探测器不该让启动失败），
 *    空数组同样被记下 —— "没有可移动盘"与"没枚举出来"在这里的行为一致：
 *    自愈退回到"同盘符"那一条，盘上判定退回到盘根 marker 那一条。
 */

import { listRemovableDrives } from '../runtime/locate.js';

let cached: readonly string[] | null = null;

/** 可移动盘盘符（`['E:','F:']`，Z→A）。 */
export function removableDrives(): readonly string[] {
  if (cached === null) cached = listRemovableDrives();
  return cached;
}

/**
 * 灌入一份快照。
 *
 * 生产用途：启动时判定用的那份列表，就是整个进程后续一直用的那份
 * （免得判定用一套、写配置用另一套）。测试用途：不跑 PowerShell。
 */
export function setRemovableDrives(drives: readonly string[]): void {
  cached = drives;
}

/**
 * **重新枚举**一次并刷新缓存 —— 用户显式动作（设/换工作区）走这条。
 *
 * ⚠️ 为什么必须有这条入口：缓存是"进程内记忆一次"，而 U 盘是**插进来的**。
 *    用户在应用启动**之后**才插上盘、再把工作区设到那个盘上 —— 若这里用缓存，
 *    那一刻的列表里根本没有这个盘，`workspaceRelPath`/`volumeMarker` 就**永远不记**，
 *    下次换盘符时这份工作区彻底失去静默自愈的线索（只剩弹框）。
 *    页面上的动作本来就要等用户点，多花一次枚举换"线索一定记对"是划算的。
 */
export function refreshRemovableDrives(): readonly string[] {
  cached = listRemovableDrives();
  return cached;
}
