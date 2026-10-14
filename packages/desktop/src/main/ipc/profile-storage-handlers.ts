/**
 * 画像持久化刷新（BUG-034 · M3）：渲染层**保存成功后**请求把 sender 所属 session 的
 * DOMStorage 落盘；主进程正常退出时另做一次尽力刷新（见 `main/index.ts` before-quit）。
 *
 * ⚠️ 两条纪律（BUG-034 复核口径）：
 *  1. Electron 34 的 `session.flushStorageData()` 是 **void**（无完成回执）——
 *     `{ requested: true }` 只表示"已发起刷新请求"，**不是**物理落盘确认。
 *  2. 目标 session **只从 `event.sender` 解析**，渲染层不传任何参数（不收 partition/path）；
 *     非受信应用页面来源一律拒绝。
 */
import { ipcMain } from 'electron';
import { join } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { isAllowedAppNavigation } from '../security/navigation-guard.js';
import { getDebugLogger } from '../debug/index.js';

interface ProfileFlushOptions {
  /** prod：应用渲染目录（file:// 页面白名单）；测试注入临时目录。 */
  appRendererDir?: string;
  /** dev：`ELECTRON_RENDERER_URL` 同源白名单；prod 为 null。 */
  devOrigin?: string | null;
}

function resolveOptions(options?: ProfileFlushOptions): { devOrigin: string | null; appRendererDir: string } {
  if (options) {
    return {
      devOrigin: options.devOrigin ?? null,
      appRendererDir: options.appRendererDir ?? join(import.meta.dirname, '../renderer'),
    };
  }
  // 生产默认：与 `main/index.ts` 建窗口时的导航守卫同源同参数。
  // （主进程整包 bundle 后所有模块的 `import.meta.dirname` 都是 `out/main`。）
  return {
    devOrigin: process.env['ELECTRON_RENDERER_URL'] ?? null,
    appRendererDir: join(import.meta.dirname, '../renderer'),
  };
}

/** sender 是否为一个受信的应用页面（复用导航守卫的白名单判据）。 */
export function isTrustedProfileFlushSender(event: IpcMainInvokeEvent, options?: ProfileFlushOptions): boolean {
  try {
    const frame = event.senderFrame;
    if (!frame) return false;
    return isAllowedAppNavigation(frame.url, resolveOptions(options));
  } catch {
    return false;
  }
}

/** 退出路径/通用用：对给定 session 尽力请求刷新；**绝不抛、不阻塞**。 */
export function requestSessionFlushBestEffort(session: { flushStorageData?: () => void } | null | undefined): boolean {
  try {
    if (!session || typeof session.flushStorageData !== 'function') return false;
    session.flushStorageData();
    return true;
  } catch {
    return false;
  }
}

export function registerProfileStorageHandlers(options?: ProfileFlushOptions): void {
  ipcMain.handle('profile:flush-storage', (event) => {
    const logger = getDebugLogger();
    try {
      if (!isTrustedProfileFlushSender(event, options)) {
        logger.warn({
          domain: 'profile-storage',
          event: 'profile-storage.flush-rejected',
          data: { reason: 'untrusted-sender' },
        });
        return { ok: false, error: 'untrusted sender', errorCode: 'profile-flush-untrusted-sender' };
      }
      event.sender.session.flushStorageData();
      logger.info({
        domain: 'profile-storage',
        event: 'profile-storage.flush-requested',
        data: { source: 'renderer' },
      });
      return { ok: true, result: { requested: true } };
    } catch (error) {
      logger.warn({
        domain: 'profile-storage',
        event: 'profile-storage.flush-failed',
        data: { message: error instanceof Error ? error.message : String(error) },
      });
      return { ok: false, error: 'flush request failed', errorCode: 'profile-flush-failed' };
    }
  });
}
