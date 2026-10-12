import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * ⚠️ DOCX-205 合同（2026-10-10）B 块：主进程「一轮在跑」软状态 + 有界释放。
 *
 * 信号 = 网关 `agent` 流的 lifecycle 相位与 `chat` 终态（gateway-client 处转发给
 * `noteGatewayTurnLifecycle`）。这里直接驱动同一入口，钉住三条语义：
 *  - start ⇒ `isArtifactTurnInFlight` 为真（单飞门拦住普通新请求）；
 *  - end ⇒ 15 秒**有界宽限**后释放没被终态消息 claim 的 active run（bare final 僵尸）；
 *  - error ⇒ 立即释放（自动重发只等 ~1.5 秒）；
 *  - 释放前又有 start（重发轮已开跑）⇒ 宽限作废，绝不误杀进行中的轮次。
 */

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send: mocks.send } }] },
}));

vi.mock('../src/main/db/index.js', () => {
  const db = {
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ run: () => undefined }) }) }),
    select: () => ({ from: () => ({ where: () => ({ get: () => undefined }) }) }),
  };
  return { getDb: () => db, getSqlite: () => null, isDbReady: () => true };
});

vi.mock('../src/main/workspace/config.js', () => ({ getWorkspacePath: () => 'C:\\workspace' }));
vi.mock('../src/main/ws/index.js', () => ({ getGatewayClient: () => undefined }));

const SESSION = 'agent:main:clawwork:task-turn-release';

async function setupRuns() {
  const { beginArtifactRun, isArtifactTurnInFlight } = await import('../src/main/ipc/data-handlers.js');
  const { noteGatewayTurnLifecycle, resetTurnLifecycleForTests } =
    await import('../src/main/artifact/turn-lifecycle.js');
  resetTurnLifecycleForTests();
  return { beginArtifactRun, isArtifactTurnInFlight, noteGatewayTurnLifecycle, resetTurnLifecycleForTests };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.send.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

it('start marks the session in flight and end releases an unclaimed run after the bounded grace', async () => {
  const { beginArtifactRun, isArtifactTurnInFlight, noteGatewayTurnLifecycle } = await setupRuns();
  beginArtifactRun('C:\\workspace', 'task-turn-release', SESSION);
  noteGatewayTurnLifecycle('start', SESSION);
  expect(isArtifactTurnInFlight('task-turn-release', SESSION)).toBe(true);

  // end 之后宽限期内（终态消息本来该在这几十毫秒里 claim）不释放。
  noteGatewayTurnLifecycle('end', SESSION);
  await vi.advanceTimersByTimeAsync(14_000);
  expect(isArtifactTurnInFlight('task-turn-release', SESSION)).toBe(true);

  // 超过宽限 ⇒ 僵尸 run 被取消，门放行。
  await vi.advanceTimersByTimeAsync(2_000);
  expect(isArtifactTurnInFlight('task-turn-release', SESSION)).toBe(false);
});

it('error releases immediately so the ~1.5s auto retry can dispatch', async () => {
  const { beginArtifactRun, isArtifactTurnInFlight, noteGatewayTurnLifecycle } = await setupRuns();
  beginArtifactRun('C:\\workspace', 'task-turn-release', SESSION);
  noteGatewayTurnLifecycle('start', SESSION);
  expect(isArtifactTurnInFlight('task-turn-release', SESSION)).toBe(true);
  noteGatewayTurnLifecycle('error', SESSION);
  expect(isArtifactTurnInFlight('task-turn-release', SESSION)).toBe(false);
});

it('a retry that starts within the grace window is never released by the stale timer', async () => {
  const { beginArtifactRun, isArtifactTurnInFlight, noteGatewayTurnLifecycle } = await setupRuns();
  const { cancelArtifactRun } = await import('../src/main/ipc/data-handlers.js');
  const first = beginArtifactRun('C:\\workspace', 'task-turn-release', SESSION);
  noteGatewayTurnLifecycle('start', SESSION);
  noteGatewayTurnLifecycle('end', SESSION);
  // 重发轮在宽限期内开跑：start 清掉旧计时器，新 run 正常在飞。
  const second = beginArtifactRun('C:\\workspace', 'task-turn-release', SESSION);
  noteGatewayTurnLifecycle('start', SESSION);
  await vi.advanceTimersByTimeAsync(20_000);
  // 先落软状态（end）再看队列：若旧计时器在 20 秒里误杀过，队列里已没有 active run，
  // 门会是 false；正确行为下两个 run 都在，门仍为 true。
  noteGatewayTurnLifecycle('end', SESSION);
  expect(isArtifactTurnInFlight('task-turn-release', SESSION)).toBe(true);
  // 逐个取消才把门放下来（两个 run 一个都没被宽限误杀）。
  cancelArtifactRun('task-turn-release', SESSION, second);
  expect(isArtifactTurnInFlight('task-turn-release', SESSION)).toBe(true);
  cancelArtifactRun('task-turn-release', SESSION, first);
  expect(isArtifactTurnInFlight('task-turn-release', SESSION)).toBe(false);
});

it('settle (terminal claim) lands the soft state without waiting for any timer', async () => {
  const { beginArtifactRun, isArtifactTurnInFlight, noteGatewayTurnLifecycle } = await setupRuns();
  const { settleLiveTurn } = await import('../src/main/artifact/turn-lifecycle.js');
  beginArtifactRun('C:\\workspace', 'task-turn-release', SESSION);
  noteGatewayTurnLifecycle('start', SESSION);
  settleLiveTurn(SESSION);
  // 软状态落地；但 run 还没被 claim —— 队列判据仍然在飞（交付锁直到 claim/settle）。
  expect(isArtifactTurnInFlight('task-turn-release', SESSION)).toBe(true);
});
