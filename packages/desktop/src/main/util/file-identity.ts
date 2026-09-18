/**
 * 文件身份（`dev` + `ino`）—— 全仓**唯一**一份正确实现。
 *
 * ## 🔴 为什么必须用 bigint，而不是 Node 默认的 `Stats`
 *
 * `ino` 是 **64 位**文件索引，而 Node 默认用 **JS Number** 暴露它。本机（NTFS）实测真实值
 * 在 ~1.1e16，**超过 2^53**（9.007e15）⇒ Number 的间距是 **2** ⇒ **相邻的两个 ino 会舍入成
 * 同一个值**。实测：连开 200 个文件撞了 **5 次**（`f9`/`f10`/`f11` 三个不同文件同一个 ino）；
 * 换成 `{ bigint: true }` 后同样 200 个文件 **0 次**。
 *
 * ⚠️ 更要紧的是：NTFS **顺序分配** inode ⇒ 两个**连续创建**的文件 ino 必然相邻 ⇒
 *    **必然**落进同一个舍入桶 ⇒ **必被判成"同一个文件"**。这不是小概率事件。
 *
 * ⚠️ 丢精度只会让**不同**的值相等，**不会**让**相同**的值不等（舍入是确定的函数）
 *    ⇒ 硬链接那类"本该判相同"的逻辑**不受影响**；出错方向永远是"把不同的当成相同的"。
 *
 * ⚠️ 而调用方（变更检测 / 去重 / 防换文件 / 防目录被换）里，"误判为同一个"是 **fail-open**：
 *    把变了的文件当成没变 ⇒ 陈旧数据、认错内容，**不报错、只出错**。
 *    所以这些地方**不能**用 Number 版的身份。
 *
 * ⚠️ 也别用 `Number.isFinite(ino) && ino > 0` 之类的"强身份"守卫来兜——**它挡不住丢精度**：
 *    舍入后的值照样是有限正数。（`376d167` 之前五处代码就是这么写的。）
 *
 * ## 用法
 *
 * ```ts
 * const stats = await handle.stat({ bigint: true });   // 或 lstat(p, { bigint: true })
 * const id = identityOf(stats);
 * if (!sameIdentity(id, expected)) throw new Error('文件被换过');
 * ```
 *
 * ⚠️ `artifact/access.ts` 有一份**等价但独立**的实现（`snapshotOf` 把 `dev`/`ino` 存成字符串）：
 *    那是 `376d167` 修那个模块时的最小改动，刻意没有连带重构它 —— 两边语义一致
 *    （都走 bigint、都比精确值），只是形状不同。将来若统一，以本模块为准。
 */

import type { BigIntStats } from 'node:fs';

/**
 * 一个文件/目录的身份。**两个字段都是 bigint**：
 * 超过 2^53 之后 `Number` 会丢精度，而丢掉的位永远回不来。
 *
 * ⚠️ 刻意**不导出**：调用方一律用下面四个函数，不需要按名引用这个类型。
 *    （导出它只会让 `check:dead-code` 多一条"没人用的导出"。）
 */
interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

/** 从 `stat`/`lstat`/`handle.stat` 的 **bigint** 结果取身份。 */
export function identityOf(stats: Pick<BigIntStats, 'dev' | 'ino'>): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

/**
 * 拍成一个稳定字符串，用于拼签名 / 来源键（`signature()` / `sourceKey()` 那种）。
 * ⚠️ 它**不**等同于"可读的文件标识"——只保证"相同身份 ⇒ 相同字符串，不同身份 ⇒ 不同字符串"。
 */
export function identityKey(identity: FileIdentity): string {
  return `${identity.dev}:${identity.ino}`;
}

/**
 * "这个文件系统给了可用身份" —— `dev` 或 `ino` 为 0 表示没给（个别文件系统/网络盘）。
 *
 * ⚠️ 与原来那些 `Number.isFinite(ino) && ino > 0` 的守卫**语义相同**，但**不会**被丢精度骗过：
 *    bigint 没有"非有限"这种状态，`> 0n` 就是真的大于 0。
 */
export function hasStrongIdentity(identity: FileIdentity): boolean {
  return identity.dev > 0n && identity.ino > 0n;
}

/**
 * 两边**都**有可用身份、且**逐位**相等 ⇒ 同一个文件。
 *
 * ⚠️ 任一边身份不可用就返回 `false`：**宁可判成"不是同一个"**。
 *    调用方一律把 `false` 当"出事了"（抛错 / 拒绝），方向是保守的；
 *    反过来（身份不可用时判 true）才是危险的。
 */
export function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return hasStrongIdentity(left) && hasStrongIdentity(right) && left.dev === right.dev && left.ino === right.ino;
}
