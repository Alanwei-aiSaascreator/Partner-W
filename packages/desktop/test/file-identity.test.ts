import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { hasStrongIdentity, identityKey, identityOf, sameIdentity } from '../src/main/util/file-identity.js';

/**
 * 文件身份（`dev` + `ino`）—— 全仓**唯一**一份实现。
 *
 * ## 为什么值得单独一层
 *
 * 2026-09-19 查出：`ino` 是 **64 位**文件索引，而 Node 默认用 **JS Number** 暴露它。
 * 本机（NTFS）实测真实值在 ~1.1e16，**超过 2^53**（9.007e15）⇒ Number 的间距是 **2**
 * ⇒ **相邻的两个 ino 舍入成同一个值**。实测连开 200 个文件撞了 **5 次**。
 *
 * ⚠️ 更要紧的是：NTFS **顺序分配** inode ⇒ 两个**连续创建**的文件 ino 必然相邻
 * ⇒ **必然**落在同一个舍入桶里 ⇒ **必被判成"同一个文件"**。这不是小概率。
 *
 * ⚠️ 丢精度只会让**不同**的值相等，**不会**让**相同**的值不等（舍入是确定的函数）
 * ⇒ 硬链接那类"本该判相同"的逻辑不受影响；出错方向是"把不同的当成相同的"。
 *
 * 各调用方拿它做**变更检测 / 去重 / 防换文件**，所以"误判为同一个"是 **fail-open**：
 * 把变了的文件当成没变 ⇒ 陈旧数据、认错内容，**不报错**。
 */
describe('文件身份', () => {
  /** 只造身份用得上的字段。 */
  const statsWith = (dev: bigint, ino: bigint): Parameters<typeof identityOf>[0] => ({ dev, ino });

  it('⭐ 两个不同的 64 位 ino 转成 number 后相等 ⇒ 仍必须判为**不同**', () => {
    // 前提先钉死：这两个数在 Number 下**确实**相等（否则这条用例是空的）
    expect(Number(10977524094393692n) === Number(10977524094393693n), '前提：舍入后相等').toBe(true);

    const a = identityOf(statsWith(1n, 10977524094393692n));
    const b = identityOf(statsWith(1n, 10977524094393693n));

    expect(sameIdentity(a, b), '丢精度会把两个不同的文件判成同一个').toBe(false);
  });

  it('同一个文件（两处读到相同的 64 位值）必须判为相同', () => {
    const ino = 39125021765459235n;
    expect(sameIdentity(identityOf(statsWith(1n, ino)), identityOf(statsWith(1n, ino)))).toBe(true);
  });

  it('换卷：dev 不同即使 ino 一样也要判为不同', () => {
    expect(sameIdentity(identityOf(statsWith(1n, 7n)), identityOf(statsWith(2n, 7n)))).toBe(false);
  });

  it('`hasStrongIdentity`：dev 或 ino 为 0 都算"这个文件系统没给可用身份"', () => {
    expect(hasStrongIdentity(identityOf(statsWith(1n, 1n)))).toBe(true);
    expect(hasStrongIdentity(identityOf(statsWith(0n, 1n)))).toBe(false);
    expect(hasStrongIdentity(identityOf(statsWith(1n, 0n)))).toBe(false);
  });

  it('`identityKey` 把两个数拍成一个稳定字符串（用于拼签名/来源键）', () => {
    expect(identityKey(identityOf(statsWith(1n, 2n)))).toBe('1:2');
    expect(identityKey(identityOf(statsWith(1n, 10977524094393692n)))).not.toBe(
      identityKey(identityOf(statsWith(1n, 10977524094393693n))),
    );
  });

  /**
   * ⭐ 这一条把"丢精度"钉在**真文件**上，不靠人造夹具。
   *
   * 从真文件读到的身份必须与 `lstat(..., {bigint:true})` **逐位一致**。
   * 反面（旧的 Number 写法）在 ino > 2^53 的机器上会得到另一个值 ——
   * 断言里把这一点也测了，免得将来有人"优化"回去。
   */
  it('⭐ 从真文件读到的身份与 bigint lstat 逐位一致（不许经过 Number）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawwork-identity-'));
    try {
      const target = join(root, 'x.txt');
      await writeFile(target, 'x');
      const exact = lstatSync(target, { bigint: true });

      // 真·被测路径：调用方自己 `lstat(p, { bigint: true })` 再交给 identityOf
      const fromCaller = identityOf(await lstat(target, { bigint: true }));

      expect(fromCaller.ino).toBe(exact.ino);
      expect(fromCaller.dev).toBe(exact.dev);
      expect(identityKey(fromCaller)).toBe(`${exact.dev}:${exact.ino}`);

      // 反面样板：经过 Number 会得到什么。
      // ⚠️ 判据必须写成"**转过去再转回来**是否还一样"：`Number(bigint) !== bigint` 是
      //    **跨类型比较、恒为真**，那样这个 if 永远进得去，而断言只在真的丢了精度时才成立
      //    ⇒ 用例会随机的 ino 大小忽红忽绿（我第一版就是这么写的，全量跑时抓到了）。
      const inoRoundTrips = BigInt(Number(exact.ino)) === exact.ino;
      if (!inoRoundTrips) {
        expect(
          identityKey(identityOf({ dev: exact.dev, ino: BigInt(Number(exact.ino)) })),
          '这条机器上 ino 超过 2^53 ⇒ 走 Number 会得到**另一个**身份',
        ).not.toBe(identityKey(fromCaller));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    // 这个文件不建长驻资源，留个空钩子只为和仓库其它真文件用例保持一致的结构
  });
});
