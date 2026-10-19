/**
 * 长时记忆的 IPC 面（设置页「记忆」用）。
 *
 * ## 一条纪律：**每一次改动都跟着一次投影**
 *
 * 库是真源，但助手真正读到的是 `MEMORY.md`。如果"确认了"只改库不投影，用户在界面上
 * 看到记忆多了一条、助手却读不到 —— 那正是"界面可见 ≠ 真实可用"的假象。
 * 所以 `create / delete / confirm` 三条**改到已确认集合**的动作，改完都立刻
 * `syncMemoryToAgents`；投影结果连同失败助手一起回给界面（部分失败如实显示）。
 *
 * `reject` **不**触发投影：拒绝只动 `pending` 行，已确认集合没变 —— 空转一次
 * 网关往返只会让"点了拒绝"变慢。
 *
 * ## 永不让渲染层看到"看起来成功"的失败
 *
 * 每个 handler 返回 `{ ok, ... }`；库没打开、网关没连上都**明确**返回失败原因，
 * 不返回一个空列表冒充"你没有记忆"。
 */

import { ipcMain, BrowserWindow } from 'electron';
import { getGatewayClient } from '../ws/index.js';
import { getDebugLogger } from '../debug/index.js';
import { currentMemoryOwnerId } from '../memory/owner.js';
import { currentMemoryStore, type MemoryMutation } from '../memory/store.js';
import { syncMemoryToAgents, readMemoryRecallSnapshot } from '../memory/sync.js';

type SyncSummary =
  | { status: 'synced'; written: string[]; unchanged: string[]; failed: Array<{ agentId: string; error: string }> }
  | { status: 'skipped'; reason: string };

function broadcast(channel: string, payload: Record<string, unknown>): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

/**
 * 改完之后把已确认集合投影到盘上每个助手。
 * **永不抛**：投影失败不影响"库已经改好了"这个事实，但要**如实**回给界面。
 */
async function syncAfterMutation(gatewayId: unknown): Promise<SyncSummary> {
  if (typeof gatewayId !== 'string' || gatewayId.length === 0) {
    return { status: 'skipped', reason: 'no-gateway' };
  }
  const gateway = getGatewayClient(gatewayId);
  if (!gateway?.isConnected) return { status: 'skipped', reason: 'gateway-not-connected' };
  try {
    const outcome = await syncMemoryToAgents({ gateway });
    if (!outcome.ok) return { status: 'skipped', reason: outcome.reason };
    return {
      status: 'synced',
      written: outcome.result.written,
      unchanged: outcome.result.unchanged,
      failed: outcome.result.failed,
    };
  } catch (error) {
    getDebugLogger().warn({
      domain: 'memory',
      event: 'memory.sync.failed',
      data: { reason: error instanceof Error ? error.message : 'unknown' },
    });
    return { status: 'skipped', reason: 'sync-failed' };
  }
}

/** 每次改动后让设置页重新读一次（它可能在别的窗口/别的页上开着）。 */
function announceChange(gatewayId: unknown): void {
  broadcast('memory:changed', { gatewayId: typeof gatewayId === 'string' ? gatewayId : null });
}

export function registerMemoryHandlers(): void {
  ipcMain.handle('memory:list', () => {
    const store = currentMemoryStore();
    if (!store) return { ok: false, reason: 'unavailable' };
    const ownerUserId = currentMemoryOwnerId();
    return {
      ok: true,
      ownerUserId,
      entries: store.list({ ownerUserId, status: 'confirmed' }),
      pending: store.list({ ownerUserId, status: 'pending' }),
      rejected: store.list({ ownerUserId, status: 'rejected' }),
    };
  });

  ipcMain.handle('memory:create', async (_event, payload: { text?: unknown; gatewayId?: unknown }) => {
    const store = currentMemoryStore();
    if (!store) return { ok: false, reason: 'unavailable' };
    const outcome: MemoryMutation = store.create({
      ownerUserId: currentMemoryOwnerId(),
      text: typeof payload?.text === 'string' ? payload.text : '',
      source: 'user',
    });
    if (!outcome.ok) return outcome;
    const sync = await syncAfterMutation(payload?.gatewayId);
    announceChange(payload?.gatewayId);
    return { ok: true, entry: outcome.entry, sync };
  });

  ipcMain.handle('memory:delete', async (_event, payload: { id?: unknown; gatewayId?: unknown }) => {
    const store = currentMemoryStore();
    if (!store) return { ok: false, reason: 'unavailable' };
    const outcome = store.remove({
      ownerUserId: currentMemoryOwnerId(),
      id: typeof payload?.id === 'string' ? payload.id : '',
    });
    if (!outcome.ok) return outcome;
    const sync = await syncAfterMutation(payload?.gatewayId);
    announceChange(payload?.gatewayId);
    return { ok: true, entry: outcome.entry, sync };
  });

  ipcMain.handle(
    'memory:draft-confirm',
    async (_event, payload: { id?: unknown; text?: unknown; gatewayId?: unknown }) => {
      const store = currentMemoryStore();
      if (!store) return { ok: false, reason: 'unavailable' };
      const outcome = store.confirm({
        ownerUserId: currentMemoryOwnerId(),
        id: typeof payload?.id === 'string' ? payload.id : '',
        text: typeof payload?.text === 'string' ? payload.text : undefined,
      });
      if (!outcome.ok) return outcome;
      const sync = await syncAfterMutation(payload?.gatewayId);
      announceChange(payload?.gatewayId);
      return { ok: true, entry: outcome.entry, sync };
    },
  );

  ipcMain.handle('memory:draft-reject', (_event, payload: { id?: unknown; gatewayId?: unknown }) => {
    const store = currentMemoryStore();
    if (!store) return { ok: false, reason: 'unavailable' };
    const outcome = store.reject({
      ownerUserId: currentMemoryOwnerId(),
      id: typeof payload?.id === 'string' ? payload.id : '',
    });
    if (!outcome.ok) return outcome;
    announceChange(payload?.gatewayId);
    return { ok: true, entry: outcome.entry };
  });

  /** 手动重投影（启动注入失败后、或用户怀疑"助手没读到"时点一下）。 */
  ipcMain.handle('memory:sync', async (_event, payload: { gatewayId?: unknown }) => {
    const sync = await syncAfterMutation(payload?.gatewayId);
    return sync.status === 'synced' ? { ok: true, sync } : { ok: false, reason: sync.reason };
  });

  /** 取证：只读回读每个助手的 `MEMORY.md` 受管区块，**不写任何东西**。 */
  ipcMain.handle('memory:recall-proof', async (_event, payload: { gatewayId?: unknown }) => {
    if (typeof payload?.gatewayId !== 'string' || payload.gatewayId.length === 0) {
      return { ok: false, reason: 'no-gateway' };
    }
    const gateway = getGatewayClient(payload.gatewayId);
    if (!gateway?.isConnected) return { ok: false, reason: 'gateway-not-connected' };
    const snapshot = await readMemoryRecallSnapshot({ gateway });
    if (!snapshot.ok) return { ok: false, reason: snapshot.reason };
    return { ok: true, entries: snapshot.entries, files: snapshot.files };
  });
}
