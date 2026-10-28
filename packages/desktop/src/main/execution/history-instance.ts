/**
 * ⭐ V4（I 接线）：执行历史 writer 的**实例登记** —— 按当前工作区隔离。
 *
 * - `workspaceKey` = 当前工作区路径的 sha256 前 16 位（稳定键；换盘/换 userData/换工作区
 *   即换目录 ⇒ 跨 workspace 读不到 —— 与 writer 的隔离判据对齐）；
 * - 工作区在运行期变化（getWorkspacePath 换值）⇒ 旧实例 stop/close、新键开新实例。
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { app } from 'electron';
import { getWorkspacePath } from '../workspace/config.js';
import { getDebugLogger } from '../debug/index.js';
import { createExecutionHistory, type ExecutionHistoryDiagnostic, type ExecutionHistoryStore } from './history.js';

let cached: { key: string; store: ExecutionHistoryStore } | null = null;

function workspaceKeyNow(): string {
  const workspace = getWorkspacePath();
  const material = workspace && workspace.trim() ? workspace : '(default)';
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * R1（2026-10-14 集中修复）：writer 的诊断必须接到**已有脱敏诊断出口** ——
 * 此前实例没接 `onDiagnostic`，拒写/预算/磁盘异常全静默（真实 sessionKey 被拒写时
 * 界面上"什么都不发生"）。`getDebugLogger()` 的事件先过 `sanitizeForLog` 再落盘/广播。
 * 诊断出口本身不许弄崩应用：整体 try/catch 吞掉。
 */
function reportDiagnostic(diagnostic: ExecutionHistoryDiagnostic): void {
  try {
    getDebugLogger().warn({
      domain: 'artifact',
      event: 'execution-history.diagnostic',
      message: diagnostic.message ? `${diagnostic.reason}: ${diagnostic.message}` : diagnostic.reason,
      ...(diagnostic.runId ? { runId: diagnostic.runId } : {}),
    });
  } catch {
    /* 诊断失败绝不冒泡（与 writer 的 write-error 闩锁同纪律） */
  }
}

/** 取当前工作区的执行历史实例（不存在则创建并 start；换工作区自动切换）。 */
export function getExecutionHistory(): ExecutionHistoryStore {
  const key = workspaceKeyNow();
  if (cached && cached.key === key) return cached.store;
  if (cached) {
    cached.store.stop();
    void cached.store.close();
    cached = null;
  }
  const store = createExecutionHistory({
    rootDir: join(app.getPath('userData'), 'execution-history'),
    workspaceKey: key,
    onDiagnostic: reportDiagnostic,
  });
  store.start();
  cached = { key, store };
  return cached.store;
}

/** 退出时停表 + 收尾（不阻塞退出：close 内部按 writer 纪律自己吞错）。 */
export function stopExecutionHistory(): void {
  if (!cached) return;
  cached.store.stop();
  void cached.store.close();
  cached = null;
}
