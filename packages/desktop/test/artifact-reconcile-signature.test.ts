import type { BigIntStats } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { __testing } from '../src/main/artifact/reconcile.js';

/**
 * 产物扫描用的两条「身份字符串」：基线签名 与 落库来源键。
 *
 * ## 为什么单独一个文件、而且不用真文件
 *
 * 这两条字符串里都有 `dev:ino`。`ino` 是 **64 位**，Node 默认用 JS Number 暴露 ⇒ 超过 2^53
 * 后**相邻的两个值会舍入成同一个**（实测 200 个文件撞 5 次），而 NTFS **顺序分配** inode
 * ⇒ 连续创建的两个文件 ino 必然相邻 ⇒ **必然**撞。
 *
 * 撞了会怎样：`signature` 一样 ⇒ `baseline[relativePath] === signature(stats)` 成立
 * ⇒ **该重建的产物被跳过** ⇒ 用户看到的是**陈旧内容**；`sourceKey` 一样 ⇒
 * `artifacts` 表把两个不同文件当成同一个来源 ⇒ **去重认错**。两条都**不报错**。
 *
 * ⚠️ **真文件测不出来**：要构造"只有 dev/ino 不同"的形态，size/mtime 可以 `utimes` 对齐，
 *    但 **ctime 改不了**，它总会在签名里兜住 —— 所以已有的那条
 *    `replaced-same-metadata`（Electron 探针）验的其实是 ctime，不是身份。
 *    身份这一层只能在函数层面用**合成的 bigint stats** 钉。
 */
describe('产物扫描的身份字符串', () => {
  /** 只造这两条字符串用得到的字段。 */
  const statsWith = (ino: bigint, size = 10n, mtimeMs = 1000n, ctimeMs = 2000n): BigIntStats =>
    ({ dev: 1n, ino, size, mtimeMs, ctimeMs }) as BigIntStats;

  /**
   * 按**应用根**的前缀取来源键。
   *
   * ⚠️ 前缀本身与"身份精度"这件事无关（下面几条钉的是 dev/ino），之所以从
   *    `__testing` 里取而不是写死字面量，是为了**跟生产用同一个来源** ——
   *    前缀写死了，生产改了它这条用例也不会红。
   */
  const sourceKey = (stats: BigIntStats, relativePath = 'task-1/x.txt'): string =>
    __testing.sourceKeyFor(__testing.WORKSPACE_SOURCE_PREFIX, relativePath, stats);

  it('⭐ 三个根的来源键前缀必须**两两不同** —— 否则后跑的那趟会改写先跑那趟的行', () => {
    // `reconcileTaskArtifacts` 用"前缀是不是我的"判「这行归不归我改」。
    // 共用前缀 ⇒ 助手根那趟把应用根的行当成自己的 ⇒ 改写别人的行。
    // 第三个根（应用工作区根层，2026-10-07）同样：它收的是**裸文件名**，
    // 与应用根的 `<taskId>/…` 混在一起时，前缀就是唯一的归属判据。
    const prefixes = [
      __testing.WORKSPACE_SOURCE_PREFIX,
      __testing.AGENT_SOURCE_PREFIX,
      __testing.WORKSPACE_ROOT_SOURCE_PREFIX,
    ];
    // ⚠️ 先钉"第三个前缀**存在**且是字符串"：`undefined` 与任何字符串都"不相等"，
    //    只写 pairwise 不等的话，漏掉导出这条用例会**假绿**。
    expect(typeof __testing.WORKSPACE_ROOT_SOURCE_PREFIX).toBe('string');
    expect(new Set(prefixes).size, `前缀撞了：${prefixes.join(' / ')}`).toBe(3);
  });

  it('⭐ 两个 64 位 ino 不同、但转 Number 后相同 ⇒ 签名与来源键都必须不同', () => {
    // 前提先钉死：这两个数在 Number 下**确实**相等（否则这条用例是空的）
    expect(Number(10977524094393692n) === Number(10977524094393693n), '前提：舍入后相等').toBe(true);

    const a = statsWith(10977524094393692n);
    const b = statsWith(10977524094393693n);

    expect(__testing.signature(a), '签名相同 ⇒ 该重建的被跳过 ⇒ 陈旧数据').not.toBe(__testing.signature(b));
    expect(sourceKey(a), '来源键相同 ⇒ 两个文件被认成同一个来源').not.toBe(sourceKey(b));
  });

  it('同一个文件（两处读到相同的 64 位值）⇒ 两条字符串都必须相同', () => {
    const ino = 39125021765459235n;
    expect(__testing.signature(statsWith(ino))).toBe(__testing.signature(statsWith(ino)));
    expect(sourceKey(statsWith(ino))).toBe(sourceKey(statsWith(ino)));
  });

  it('换卷（dev 不同）即使 ino 一样也要不同', () => {
    const left = { ...statsWith(7n), dev: 1n } as BigIntStats;
    const right = { ...statsWith(7n), dev: 2n } as BigIntStats;
    expect(__testing.signature(left)).not.toBe(__testing.signature(right));
  });

  it('size / mtime / ctime 变了，签名就要变（这几项是它本来就在管的事）', () => {
    const base = statsWith(7n);
    expect(__testing.signature(statsWith(7n, 11n))).not.toBe(__testing.signature(base));
    expect(__testing.signature(statsWith(7n, 10n, 1001n))).not.toBe(__testing.signature(base));
    expect(__testing.signature(statsWith(7n, 10n, 1000n, 2001n))).not.toBe(__testing.signature(base));
  });

  it('来源键里带着相对路径（不同文件本来就不该撞到一起去）', () => {
    expect(sourceKey(statsWith(7n), 'task-1/a.txt')).not.toBe(sourceKey(statsWith(7n), 'task-1/b.txt'));
  });
});
