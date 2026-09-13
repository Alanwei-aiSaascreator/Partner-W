import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { freshProfile, safeRemoveTree } from '../helpers/temp-root.js';
import { watchSessionStore } from './session-store-watch.js';

/**
 * `session-store-watch` 的**自测** —— 秒级、合成数据、不起 app。
 *
 * 为什么值得单独钉：6b 的结论会**直接建立在它的输出上**
 * （「写了几次」决定 P2/P3/P4 的分支）。一个会漏记或误报的观察器
 * 会把整轮结论带偏 —— 这正是 2026-09-13 `auth-fault-proxy` 那次教训
 * （诊断工具自己有 bug）。
 *
 * 所以这里钉四件事：
 *   ① 负对照：**没有写就一笔都不记**（防"误报"）
 *   ② 有序：间隔 50ms 的两次写能被**分别**观察到、且顺序正确
 *      （⚠️ 只证明到这个时间尺度；观察器不声称"绝不丢事件"，见模块头注释）
 *   ③ 删除也算一次变化（`removeItem` 也是写入语义）
 *   ④ 观察器**只读**：跑完文件内容逐字节不变；`stop()` 之后不再记
 */
const FILE = 'commercial-session.json';

/** echo -n 的等价物：不加换行，便于逐字节比对。 */
function writeSync(file: string, body: string): void {
  fs.writeFileSync(file, body, 'utf8');
}

test('合成写入：负对照不误报、连续的写可分别观察且有序、删除记一笔、stop 后不再记', async () => {
  const dir = freshProfile('storewatch');
  const file = path.join(dir, FILE);
  try {
    // 基线 = "种子"状态（相当于 provisionProfile 刚铺完）
    writeSync(file, 'enc:SEED');
    const seedBytes = fs.readFileSync(file);

    const w = watchSessionStore(dir, { pollMs: 100 });
    try {
      expect(w.baseline.exists, '基线应当看到种子文件').toBe(true);
      expect(w.changes().length, '刚启动时不该有任何变化').toBe(0);

      // ---- ① 负对照：只等不写 ⇒ 一笔都不许记
      await new Promise((r) => setTimeout(r, 400));
      expect(w.changes().length, '负对照失败：没写却记了变化（误报）').toBe(0);
      expect(w.samples().length, '没有变化时不该产生新采样').toBe(1);

      // ---- ② 有序：两次快速连续写
      writeSync(file, 'enc:TOKEN_B');
      await new Promise((r) => setTimeout(r, 50));
      writeSync(file, 'enc:TOKEN_A');
      // 给 fs.watch / 轮询留出送达时间
      await expect.poll(() => w.changes().length, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);

      const ch = w.changes();
      expect(ch[0]!.tMs, '第一次变化的时间戳应当早于第二次').toBeLessThanOrEqual(ch[1]!.tMs);
      expect(ch[0]!.sha256, '两次不同内容必须给出不同指纹').not.toBe(ch[1]!.sha256);

      // ---- ④ 观察器只读：跑完文件仍是最后写进去的那份
      expect(fs.readFileSync(file).toString('utf8'), '观察器改了文件？').toBe('enc:TOKEN_A');

      // ---- ③ 删除（= removeItem）
      const before = w.changes().length;
      fs.unlinkSync(file);
      await expect.poll(() => w.changes().length, { timeout: 5_000 }).toBeGreaterThan(before);
      expect(w.changes().at(-1)!.exists, '删除必须记成 exists=false').toBe(false);

      // ---- stop() 之后不再记
      w.stop();
      const frozen = w.changes().length;
      writeSync(file, 'enc:AFTER_STOP');
      await new Promise((r) => setTimeout(r, 500));
      expect(w.changes().length, 'stop() 之后还在记').toBe(frozen);

      // 报告是给人读的，至少要包含"写了多少次"
      const report = w.report();
      expect(report).toContain('写入次数');
      console.log(`\n[session-store-watch] 自测通过：\n${report}`);
    } finally {
      w.stop();
    }

    // 种子的字节没有被观察器动过（只读性）
    expect(seedBytes.length, '种子字节数是我们写进去的那个').toBe(Buffer.byteLength('enc:SEED'));
  } finally {
    safeRemoveTree(dir);
  }
});
