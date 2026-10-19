/**
 * 「动手之前先确认这是**文件本身**」—— junction / symlink 红线在**实现里**的落点。
 *
 * ## 为什么这条必须有代码，不能只有注释
 *
 * OpenClaw 的 state 目录在 Windows 上可能含 junction 指向真实 `node_modules`
 * （仓库历史事故：递归删除沿着链接进了真实目录，删掉的是真身）。修复工具的答案分两层：
 *
 * ① **全流程没有一次递归删除** —— 唯一的破坏性动作是 `renameSync` 一个
 *    `gateway.*.lock`（改名，不删；现场原样保留在 `.corrupt-<时间戳>`）。
 * ② **连"顺着链接写/改名"都不做** —— 就是本模块。改名一个链接会把链接本身挪走
 *    （目标不动），写一个链接会写到链接指向的真实文件上：两者都是"动了不属于我们的东西"。
 *
 * 所以三处写动作（锁隔离 / 插件配置回写 / 提示词区块重写）在动盘之前一律先过
 * `isRegularFileNoFollow()`；不是普通文件就**如实拒绝**（`unsafe-target`），不当成功。
 *
 * ⚠️ `lstatSync` 而不是 `statSync`：后者会跟随链接，正好把我们要拦的情况看丢。
 */

import fs from 'node:fs';

/** 目标的**文件名本身**是不是普通文件（不跟随链接）。读不到 / 是目录 / 是链接 ⇒ false。 */
export function isRegularFileNoFollow(target: string): boolean {
  try {
    return fs.lstatSync(target).isFile();
  } catch {
    return false;
  }
}

/** 拒绝时统一用这个理由码（引擎会拼成 `apply.<reason>` 上屏）。 */
export const UNSAFE_TARGET_REASON = 'unsafe-target-link';
