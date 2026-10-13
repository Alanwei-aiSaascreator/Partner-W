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
import { createExecutionHistory, type ExecutionHistoryStore } from './history.js';

let cached: { key: string; store: ExecutionHistoryStore } | null = null;

function workspaceKeyNow(): string {
  const workspace = getWorkspacePath();
  const material = workspace && workspace.trim() ? workspace : '(default)';
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
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
