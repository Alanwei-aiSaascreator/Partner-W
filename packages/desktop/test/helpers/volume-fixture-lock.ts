/**
 * 「真实卷」夹具的跨文件互斥（Owner C / T15 · T17 · T18）。
 *
 * ## 为什么需要
 *
 * `owner-c-portable-volumes` / `owner-c-token-state-continuity` /
 * `owner-c-update-transaction-volumes` 三个档都把**真的** `T:\`（前两者还用 `M:\`）
 * 卷根当夹具，且各自在 `beforeEach`/`afterEach` 里 `rmSync` 掉卷根上的
 * `荣盈魔方工作区` / `荣盈魔方-运行数据` —— **三者路径互相重叠**。
 *
 * Vitest 默认**按文件并行**（见 `vitest.config.ts` 的 `maxWorkers: 4`），于是 A 档
 * 正写到一半，B 档的清理就把刚落的标记删了。2026-10-16 实测到的形状：
 * `ensureWorkspaceId(dir)` 刚返回 id，紧接着相邻一行的 `readWorkspaceId(dir)`
 * 却返回 `null` —— 同一函数、同一路径、两次调用之间文件被兄弟档删掉。
 *
 * | 跑法 | 结果 |
 * |---|---|
 * | 单档跑 | 10/10 绿 |
 * | 与兄弟档同跑（默认并行） | 1 红 / 21 绿 |
 * | 三档同跑 + `--no-file-parallelism` | 22/22 绿 |
 *
 * 夹具是**独占**的，档之间必须串行。不能用全局 `fileParallelism: false` 一刀切 ——
 * 那会把其余 690+ 档一起拖慢。
 *
 * ## 用法
 *
 * ```ts
 * const releaseVolumeFixture = await acquireVolumeFixture();
 * afterAll(() => releaseVolumeFixture());
 * ```
 *
 * 卷没映射时整组 skip，不必取锁（但取了也无害）。
 *
 * ## 健壮性
 *
 * `mkdirSync` 在 NTFS 上是**原子**的（已存在即抛 `EEXIST`），拿它当锁。
 * 持锁进程被强杀会留下陈旧锁 —— 超过 {@link STALE_MS} 视为可接管、自动清掉重试，
 * 因此**不会**因一次崩溃把整套件卡死。
 */
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 锁目录（放系统临时目录，不污染被测的真实卷根）。 */
const LOCK_DIR = join(tmpdir(), 'mofang-real-volume-fixture.lock');

/** 超过这个时长仍未释放 ⇒ 认为持锁者已死，允许接管。 */
const STALE_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 取到「真实卷夹具」的独占权；返回**幂等**的释放函数。
 *
 * @param timeoutMs 等锁上限。超时直接抛 —— 宁可红，也不并发去踩夹具。
 */
export async function acquireVolumeFixture(timeoutMs = 60_000): Promise<() => void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(join(LOCK_DIR, 'holder.txt'), `pid=${process.pid} at=${new Date().toISOString()}\n`, 'utf8');

      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          rmSync(LOCK_DIR, { recursive: true, force: true });
        } catch {
          // 已被判定陈旧并被别的档接管 —— 释放失败无害。
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      // 陈旧锁自愈：持锁者被杀/超时，不留永久死锁。
      try {
        if (Date.now() - statSync(LOCK_DIR).mtimeMs > STALE_MS) {
          rmSync(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // 刚被释放 —— 立刻重试
      }

      if (Date.now() > deadline) {
        throw new Error(`等待「真实卷夹具」锁超时（${timeoutMs}ms）：${LOCK_DIR}`);
      }
      await sleep(20 + Math.floor(Math.random() * 40));
    }
  }
}
