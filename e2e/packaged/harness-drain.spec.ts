import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { drainAndKeepTail } from './harness.js';

/**
 * 回归：**harness 必须持续 drain 子进程的 stdout/stderr**。
 *
 * ## 这条测试盯着的真实事故（2026-09-13）
 *
 * 打包态 E2E 起 Electron 应用时用 `stdio: 'pipe'` 却**不读**它的 stdout，
 * 而应用会把调试日志打到 stdout。管道缓冲区（Windows ~64KB）一满，
 * 子进程的 `console.log` 就**同步阻塞** ⇒ 整个主进程事件循环停住 ⇒
 * 所有 IPC（含 `page.evaluate` 走的那些）再也不回。
 *
 * 症状极具迷惑性：应用"活着"、`/startupz` 200、网关进程也在、独立 CLI 也能 RPC，
 * 唯独界面侧的调用全部超时；而且**只有真的发消息**（日志量暴涨）才触发 ——
 * 看起来像"发请求把网关/RPC 打挂了"，害我往产品方向白查了好几轮。
 *
 * 所以这里**必须有负对照**：不 drain 就要卡住。否则这条测试是恒真的，
 * 将来有人把 drain 去掉它也不会响。
 */

/** 往 stdout/stderr 各写 `mb` 兆，然后退出。远超管道缓冲区。 */
const NOISY_CHILD = `
const chunk = 'x'.repeat(64 * 1024);
const target = Number(process.argv[1]);
for (let i = 0; i < target; i++) {
  process.stdout.write(chunk + '\\n');
  process.stderr.write(chunk + '\\n');
}
process.exit(0);
`;

function spawnNoisy(): ChildProcess {
  return spawn(process.execPath, ['-e', NOISY_CHILD, '16'], { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 等退出；到点还没退就返回 null（= 卡住）。 */
function waitExit(child: ChildProcess, ms: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

test('harness 会持续 drain 子进程 stdout/stderr（不 drain 会把子进程堵死）', async () => {
  test.setTimeout(60_000);

  // ---- 正对照：走 harness 的 drain，必须能跑完 ----
  const drained = spawnNoisy();
  // 立刻挂上消费者 —— 这正是 launchApp 里做的事。
  const tail = drainAndKeepTail(drained);
  const drainedExit = await waitExit(drained, 30_000);
  expect(drainedExit, '挂了 drain 子进程仍然没退出来（drain 没生效）').toBe(0);
  // 尾巴是有上限的：写进去 2MB，只留最后 keepBytes。
  expect(tail().length, '没留到任何输出，drain 可能没真的读').toBeGreaterThan(0);
  expect(tail().length, 'tail 没有上限，会无界吃内存').toBeLessThanOrEqual(8000);

  // ---- 负对照：**不**挂消费者，同一个子进程必然卡在写管道上 ----
  const blocked = spawnNoisy();
  const blockedExit = await waitExit(blocked, 5_000);
  expect(blockedExit, '没人读 stdout 居然也退出来了 —— 那这条回归就盯不住任何东西了（环境行为变了要重看）').toBeNull();
  blocked.kill('SIGKILL');
});
