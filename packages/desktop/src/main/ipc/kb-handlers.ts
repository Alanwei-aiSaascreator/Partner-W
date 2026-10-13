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

import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { realpathSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { classifyTier } from '../context/file-types.js';
import { getKbRuntime } from '../kb/runtime.js';
import { getWorkspacePath } from '../workspace/config.js';
import { getWorkspaceScope, subscribeWorkspaceScope } from '../workspace/scope.js';

function ipcError(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
}

/** 运行时还没建好时的统一答复。`code` 让界面能区分"没就绪"和"真出错了"。 */
const NOT_READY = { ok: false as const, code: 'not-ready' as const };

/**
 * 资料库「添加文件」的**短期授权（grant）** —— BUG-056④。
 *
 * 背景：`kb:add-file` 曾经直接拿渲染层给的任意路径去入库。渲染层是沙箱化的，
 * 但"能发 IPC"这件事本身不该等于"能让应用替你读任意文件建索引" —— 合法的来源
 * 只有一条：**用户刚在系统选择框里亲自选过**。
 *
 * 一次 pick 建立一条 grant，绑四样东西：
 *   · **sender / frame**：A 窗口（或另一个子帧）选的，B 窗口用不了；
 *   · **canonical path 集合**：入库前重新 realpath，选择之后被换成指向别处的链接
 *     （canonical 变了）⇒ 拒绝；
 *   · **工作区路径**：与 add 时刻不一致 ⇒ 拒绝并清理；
 *   · **工作区代次（scope + revision，见 `workspace/scope.ts`）**：picker **打开前**捕获，
 *     结果回来时和 add 时都比一遍仍是同一代；换代（关库/开库/换盘）⇒ 旧 grant 立即清掉，
 *     "切回原路径"也是新一代，不复活（S-R1）。
 *
 * picker 还有**自己的代次**（S-R2）：每个 sender/frame 单调推进，**每次打开选择框
 * （含取消）都推进**。await 回来的结果只有"仍是该窗口最后一次打开"的才可能建立 grant ——
 * 较旧选择框的迟到结果既不能写回授权，也不能覆盖/清掉较新一次的授权。
 *
 * 消耗与重试的**明确语义**（测试逐条钉住）：
 *   · 取消 dialog ⇒ 该窗口 grant 归零（旧的一并作废）；
 *   · grant 过期（{@link KB_FILE_GRANT_TTL_MS}）⇒ 拒绝；
 *   · 入库**成功**后该路径**一次性消耗**（同路径重放拒绝）；
 *   · 服务抛错（库锁/磁盘）⇒ 授权**不消耗**，同一条路径可安全重试
 *     （仅当这条 grant 仍是当前代、未被替换时才放回）；
 *   · 校验失败（不是选出来的 / 格式 / 形态）⇒ 不消耗（挡的是请求，不是这条授权）。
 *
 * ⚠️ 其他"把文件塞进资料库"的入口只有模型产物沉淀（`addArtifact`/`addNote` 走各自
 *    的 handler），它们不经过 picker —— 别给它们开口子把用户盘上的任意路径带进来。
 */
export const KB_FILE_GRANT_TTL_MS = 5 * 60_000;

interface KbFileGrant {
  /** pick 打开时刻的工作区（canonical）；与 add 时刻不一致 ⇒ 该 grant 立即作废并清理。 */
  workspace: string | null;
  /** pick 打开时刻的工作区代次（scope UUID + revision）；任何一项变了 ⇒ 立即作废并清理。 */
  scope: string | null;
  revision: number;
  /** pick 时刻的 canonical 目标集合；每条成功入库就删掉（一次性消耗）。 */
  paths: Set<string>;
  expiresAt: number;
}

/** 每窗口（sender+frame）一条。窗口关掉不清理也没关系：过期即被清（无定时器，惰性）。 */
const fileGrants = new Map<string, KbFileGrant>();

/** 每窗口（sender+frame）的 picker 代次：每次打开选择框（含取消）都推进。 */
const pickerGenerations = new Map<string, number>();

/**
 * 工作区换代 ⇒ 所有旧 grant 立即清掉（与其他 IPC 模块同款：模块加载时注册一次）。
 * 这是"即刻失效"；add 路径自己还会再比一次代次（防通知丢失/顺序变化），两层都要在。
 */
subscribeWorkspaceScope(() => {
  fileGrants.clear();
});

function sameScopeGeneration(
  a: { scope: string | null; revision: number },
  b: { scope: string | null; revision: number },
): boolean {
  return a.scope === b.scope && a.revision === b.revision;
}

/** 谁在说话：webContents id + 顶层帧 routingId（拿不到就用 -1 哨兵，仍按窗口隔离）。 */
function senderIdentity(event: IpcMainInvokeEvent): string {
  const senderId = typeof event?.sender?.id === 'number' ? event.sender.id : -1;
  const frame = event?.senderFrame as { routingId?: number } | null | undefined;
  const legacyFrameId = (event as { frameId?: number } | undefined)?.frameId;
  const frameId =
    typeof frame?.routingId === 'number' ? frame.routingId : typeof legacyFrameId === 'number' ? legacyFrameId : -1;
  return `${senderId}:${frameId}`;
}

function pruneExpiredGrants(now = Date.now()): void {
  for (const [key, grant] of fileGrants) {
    if (grant.expiresAt <= now) fileGrants.delete(key);
  }
}

function canonicalize(target: string): string | null {
  try {
    return realpathSync.native(target);
  } catch {
    return null;
  }
}

function canonicalWorkspace(): string | null {
  const workspace = getWorkspacePath();
  if (!workspace || !workspace.trim()) return null;
  return canonicalize(workspace) ?? resolve(workspace);
}

function samePath(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const KB_PICK_FILE_DIALOG_OPTIONS: Electron.OpenDialogOptions = {
  properties: ['openFile', 'multiSelections'],
  filters: [{ name: '文本资料', extensions: ['txt', 'md', 'markdown', 'json', 'csv', 'log', 'yaml', 'yml'] }],
};

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
   * 选文件（**只回路径**，不入库；同时建立短期 grant）。
   *
   * 为什么不让渲染层传路径：渲染层拿不到真实的绝对路径（沙箱），而且用户想加的是
   * "我盘上那个文件"。选完再走 `kb:add-file` —— 两步分开，是因为入库可能失败
   *（文件太大/不是文本），失败时用户应该看到是**哪一步**出的问题。
   *
   * ⚠️ 每次 pick 用**本次结果**替换该窗口的 grant（取消 ⇒ 归零）：授权永远只对
   *    "用户刚看到的那一次选择框"有效，不是一扇长期开的门。
   *
   * ⚠️ 结果回来要过两道**代次**校验（S-R1/S-R2），任何一道不过 ⇒ 不写 grant、不把
   *    paths 交回界面（回空结果，与"取消"在渲染层等价，用户重新选一次即可）：
   *      1. picker 代次仍是该窗口最后一次打开的那次（较旧的迟到结果整体作废）；
   *      2. 打开前捕获的工作区代次（scope+revision）与现在仍是同一代（await 期间换库 ⇒ 作废）。
   *    add 侧没 grant 必然拒绝 —— 界面不会拿到"看起来可用其实不能用"的授权。
   */
  ipcMain.handle('kb:pick-files', async (event: IpcMainInvokeEvent) => {
    const key = senderIdentity(event);
    // 打开前捕获：工作区路径 + 工作区代次（关库/开库/换盘都会推进 revision/换 scope）
    const openedWorkspace = canonicalWorkspace();
    const openedAt = getWorkspaceScope();
    // 本次打开的 picker 代次：取消也算一次（推进在打开时，不在结果返回时）
    const generation = (pickerGenerations.get(key) ?? 0) + 1;
    pickerGenerations.set(key, generation);
    fileGrants.delete(key);
    pruneExpiredGrants();

    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await (win
      ? dialog.showOpenDialog(win, KB_PICK_FILE_DIALOG_OPTIONS)
      : dialog.showOpenDialog(KB_PICK_FILE_DIALOG_OPTIONS));

    // 校验 1：是否已被本窗口后面打开的 picker 顶掉（S-R2）
    if (pickerGenerations.get(key) !== generation) {
      return { ok: true, paths: [], stale: 'picker-superseded' as const };
    }
    // 校验 2：工作区是否仍是打开 picker 时的那一代（S-R1）
    if (!sameScopeGeneration(openedAt, getWorkspaceScope())) {
      return { ok: true, paths: [], stale: 'workspace-changed' as const };
    }
    if (result.canceled) return { ok: true, paths: [] };

    const granted = new Set<string>();
    for (const picked of result.filePaths) {
      const canonical = canonicalize(picked);
      if (canonical) granted.add(canonical); // 拿不到真实路径的项不进 grant（add 时会如实拒绝）
    }
    if (granted.size > 0) {
      fileGrants.set(key, {
        workspace: openedWorkspace,
        scope: openedAt.scope,
        revision: openedAt.revision,
        paths: granted,
        expiresAt: Date.now() + KB_FILE_GRANT_TTL_MS,
      });
    }
    return { ok: true, paths: result.filePaths };
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

  ipcMain.handle('kb:add-file', async (event: IpcMainInvokeEvent, params: { path: string; title?: string }) => {
    const denied = (error: string) => ({ ok: false as const, error });
    pruneExpiredGrants();
    const key = senderIdentity(event);
    const grant = fileGrants.get(key);
    if (!grant) {
      return denied('这个文件不是从「添加文件」选择框里选出来的（或选择已过期）：请重新选择');
    }
    // 同代校验：路径 + scope/revision **都要**与 pick 打开时刻一致（S-R1）。
    // 订阅清理是"即刻失效"，这里是"亲自再比一次" —— 两层都要，缺一会给未来改动留复活口。
    if (!samePath(grant.workspace, canonicalWorkspace()) || !sameScopeGeneration(grant, getWorkspaceScope())) {
      fileGrants.delete(key); // 切 scope 即清理 —— 不是"离开冻结、回来复活"
      return denied('工作区已切换，上次选择的文件已作废：请重新选择');
    }
    if (typeof params?.path !== 'string' || !params.path.trim()) return denied('文件路径无效');

    const canonical = canonicalize(params.path);
    if (!canonical) return denied('文件不存在或不可读：请重新选择');
    if (!grant.paths.has(canonical)) {
      return denied('所选文件在选择之后发生了变化：请重新选择');
    }
    if (classifyTier(extname(canonical).toLowerCase()) !== 'text') {
      return denied('只支持文本类资料（txt / md / json / csv / 日志等）');
    }
    try {
      if (!statSync(canonical).isFile()) return denied('目标不是一个文件：请重新选择');
    } catch {
      return denied('文件不存在或不可读：请重新选择');
    }

    const runtime = getKbRuntime();
    if (!runtime) return NOT_READY;

    // 一次性消耗：先摘掉授权再调服务；服务抛错时**放回**（失败安全重试）——
    // 只放回给"仍是当前代的那条 grant"：调用期间被换掉/清理掉/过期清理的，不许复活。
    grant.paths.delete(canonical);
    try {
      return { ok: true, outcome: await runtime.service.addFile(canonical, { title: params.title }) };
    } catch (err) {
      if (fileGrants.get(key) === grant && sameScopeGeneration(grant, getWorkspaceScope())) {
        grant.paths.add(canonical);
      }
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
