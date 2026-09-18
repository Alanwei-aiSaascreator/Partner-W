/**
 * 资料库的 IPC 面（T6c）。
 *
 * 薄薄一层：拿运行时单例 → 调服务 → 把结果原样回给渲染进程。
 * **不做业务判断**（哪些该嵌、能不能搜、降级成什么），那些都在 `kb/service.ts` 里，
 * 有它自己的单测。
 *
 * ⚠️ 唯一需要在这里表达的是**"还没就绪"**：运行时是工作区就绪之后**异步**建的
 *（加载 90MB 模型要几百毫秒），而界面可能在那之前就问上来了。
 * 这时回一个**明确的** `not-ready`，而不是空数组 —— 空数组会让界面显示
 * "你还没加过资料"，用户会以为自己加的东西丢了。两者是完全不同的事。
 */

import { BrowserWindow, dialog, ipcMain } from 'electron';
import { getKbRuntime } from '../kb/runtime.js';

function ipcError(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
}

/** 运行时还没建好时的统一答复。`code` 让界面能区分"没就绪"和"真出错了"。 */
const NOT_READY = { ok: false as const, code: 'not-ready' as const };

export function registerKbHandlers(): void {
  ipcMain.handle('kb:stats', () => {
    const runtime = getKbRuntime();
    if (!runtime) return NOT_READY;
    try {
      // `engine` 一起回：界面据此说明"为什么只有关键词检索"（没有引擎 ≠ 出错）
      return { ok: true, stats: runtime.service.getStats(), engine: runtime.engine?.model ?? null };
    } catch (err) {
      return ipcError(err);
    }
  });

  /**
   * 选文件（**只回路径**，不入库）。
   *
   * 为什么不让渲染层传路径：渲染层拿不到真实的绝对路径（沙箱），而且用户想加的是
   * "我盘上那个文件"。选完再走 `kb:add-file` —— 两步分开，是因为入库可能失败
   *（文件太大/不是文本），失败时用户应该看到是**哪一步**出的问题。
   */
  ipcMain.handle('kb:pick-files', async () => {
    const win = BrowserWindow.getAllWindows()[0];
    const result = await (win
      ? dialog.showOpenDialog(win, {
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '文本资料', extensions: ['txt', 'md', 'markdown', 'json', 'csv', 'log', 'yaml', 'yml'] }],
        })
      : dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] }));
    return { ok: true, paths: result.canceled ? [] : result.filePaths };
  });

  ipcMain.handle('kb:list-sources', () => {
    const runtime = getKbRuntime();
    if (!runtime) return NOT_READY;
    try {
      return { ok: true, sources: runtime.service.listSources() };
    } catch (err) {
      return ipcError(err);
    }
  });

  ipcMain.handle('kb:add-file', async (_event, params: { path: string; title?: string }) => {
    const runtime = getKbRuntime();
    if (!runtime) return NOT_READY;
    try {
      return { ok: true, outcome: await runtime.service.addFile(params.path, { title: params.title }) };
    } catch (err) {
      return ipcError(err);
    }
  });

  ipcMain.handle('kb:add-note', async (_event, params: { title: string; text: string }) => {
    const runtime = getKbRuntime();
    if (!runtime) return NOT_READY;
    try {
      return { ok: true, outcome: await runtime.service.addNote(params) };
    } catch (err) {
      return ipcError(err);
    }
  });

  ipcMain.handle('kb:remove-source', (_event, params: { sourceId: string }) => {
    const runtime = getKbRuntime();
    if (!runtime) return NOT_READY;
    try {
      return { ok: true, removed: runtime.service.removeSource(params.sourceId) };
    } catch (err) {
      return ipcError(err);
    }
  });

  ipcMain.handle('kb:search', async (_event, params: { query: string; limit?: number }) => {
    const runtime = getKbRuntime();
    if (!runtime) return NOT_READY;
    try {
      return { ok: true, outcome: await runtime.service.search(params.query, { limit: params.limit }) };
    } catch (err) {
      return ipcError(err);
    }
  });

  /** 「继续建索引」按钮：把还缺向量的切片嵌上。没有引擎时它什么都不做（服务自己判）。 */
  ipcMain.handle('kb:index-pending', async (_event, params: { sourceId?: string } | undefined) => {
    const runtime = getKbRuntime();
    if (!runtime) return NOT_READY;
    try {
      return { ok: true, report: await runtime.service.indexPending(params?.sourceId) };
    } catch (err) {
      return ipcError(err);
    }
  });

  /**
   * 「重建索引」按钮：整库（或单份资料）**重切 + 重嵌**。
   *
   * ⚠️ 报告里的 `skipped: 'no-engine'` 必须原样透出去：那是"我**什么都没做**"的唯一信号
   *（没有引擎时重建只会把现有向量删了补不回来，服务直接拒绝）。
   * 这一层要是把它抹平成一份全 0 的报告，界面就会把"没做"说成"重建完成"。
   */
  ipcMain.handle('kb:rebuild', async (_event, params: { sourceId?: string } | undefined) => {
    const runtime = getKbRuntime();
    if (!runtime) return NOT_READY;
    try {
      return { ok: true, report: await runtime.service.rebuild(params?.sourceId) };
    } catch (err) {
      return ipcError(err);
    }
  });
}
