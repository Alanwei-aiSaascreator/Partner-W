import type { BigIntStats } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { __testing } from '../src/main/context/file-import.js';

/**
 * 导入路径上的身份判定。
 *
 * ## 为什么单独一个文件、而且不用真文件
 *
 * `sameStrongIdentity` 比的是 `dev:ino`。`ino` 是 **64 位**，Node 默认用 JS Number 暴露
 * ⇒ 超过 2^53 后**相邻的两个值会舍入成同一个**（实测 200 个文件撞 5 次），
 * 而 NTFS **顺序分配** inode ⇒ 连续创建的两个文件 ino 必然相邻 ⇒ **必然**撞。
 *
 * 撞了会怎样：这里是**导入**路径，判定管的是"我打开的这个文件，还是用户选的那份吗"。
 * 答错 = 把**别的内容**当成用户选的那份导进来，**不报错**（fail-open）。
 *
 * ⚠️ **真文件测不出来**：要构造"只有 dev/ino 不同"的形态，size/mtime 能用 `utimes` 对齐，
 *    但 **ctime 改不了** —— 它总会在 `sameSourceSnapshot` 里兜住。
 *    ⇒ 身份这一层只能在函数层面用**合成的 bigint stats** 钉。
 */
describe('导入路径的文件身份', () => {
  /** 只造身份判定用得到的字段。 */
  const statsWith = (ino: bigint, size = 10n, mtimeMs = 1000n, ctimeMs = 2000n): BigIntStats =>
    ({ dev: 1n, ino, size, mtimeMs, ctimeMs }) as BigIntStats;

  it('⭐ 两个 64 位 ino 不同、但转 Number 后相同 ⇒ 必须判为**不同**文件', () => {
    // 前提先钉死：这两个数在 Number 下**确实**相等（否则这条用例是空的）
    expect(Number(10977524094393692n) === Number(10977524094393693n), '前提：舍入后相等').toBe(true);

    const a = statsWith(10977524094393692n);
    const b = statsWith(10977524094393693n);

    expect(__testing.sameStrongIdentity(a, b), '丢精度会把两个不同的文件判成同一个').toBe(false);
    expect(__testing.sameSourceSnapshot(a, b), '连快照也会跟着说"没变"').toBe(false);
  });

  it('同一个文件（两处读到相同的 64 位值）必须判为相同', () => {
    const ino = 39125021765459235n;
    expect(__testing.sameStrongIdentity(statsWith(ino), statsWith(ino))).toBe(true);
    expect(__testing.sameSourceSnapshot(statsWith(ino), statsWith(ino))).toBe(true);
  });

  it('换卷（dev 不同）即使 ino 一样也要判为不同', () => {
    const left = { ...statsWith(7n), dev: 1n } as BigIntStats;
    const right = { ...statsWith(7n), dev: 2n } as BigIntStats;
    expect(__testing.sameStrongIdentity(left, right)).toBe(false);
  });

  it('身份为 0（文件系统没给）⇒ 一律判为"不是同一个"（保守）', () => {
    const zeroDev = { ...statsWith(7n), dev: 0n } as BigIntStats;
    const zeroIno = statsWith(0n);

    expect(__testing.sameStrongIdentity(zeroDev, zeroDev), 'dev=0 不算强身份，连自己都不认').toBe(false);
    expect(__testing.sameStrongIdentity(zeroIno, zeroIno)).toBe(false);
  });

  it('同一身份但 size / mtime / ctime 变了 ⇒ 快照必须判为不同（这几项它本来就在管）', () => {
    const base = statsWith(7n);
    expect(__testing.sameSourceSnapshot(base, statsWith(7n, 11n))).toBe(false);
    expect(__testing.sameSourceSnapshot(base, statsWith(7n, 10n, 9999n))).toBe(false);
    expect(__testing.sameSourceSnapshot(base, statsWith(7n, 10n, 1000n, 9999n))).toBe(false);
  });

  /**
   * ⚠️ 我第一版把这条写成"容差内算没变（差 5ms 也算）"，**是错的**：
   *    `TIMESTAMP_TOLERANCE_MS = 0` —— 这里是**精确比对**，差 1ms 就算变了。
   *    产品是对的、而且比我以为的更严；错的是我的假设。
   */
  it('时间戳是**精确**比对（差 1ms 就算变了，不是"差不多"）', () => {
    const base = statsWith(7n, 10n, 1000n);

    expect(__testing.sameSourceSnapshot(base, statsWith(7n, 10n, 1000n))).toBe(true);
    expect(__testing.sameSourceSnapshot(base, statsWith(7n, 10n, 1001n))).toBe(false);
    expect(__testing.sameSourceSnapshot(base, statsWith(7n, 10n, 999n))).toBe(false);
  });
});
