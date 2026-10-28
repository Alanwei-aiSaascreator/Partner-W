import { mkdirSync, existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { cp } from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'path';
import { sep as winSep } from 'node:path/win32';
import { WORKSPACE_MARKER_FILE } from './portable.js';

export async function initWorkspace(workspacePath: string): Promise<void> {
  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true });
  }
  writeWorkspaceMarker(workspacePath);
}

/**
 * 把**损坏**的工作区标记改名保留（`<marker>.corrupt-<时间戳>`），返回备份路径。
 *
 * ⚠️ 与 `portable-state-migration.ts` 的 `quarantineUnusableLocks` 同一条纪律：
 *    "不可读"永远是**改名**（保留原始字节供排查），绝不是删除、也不是原地覆盖。
 * ⚠️ 改名失败就**抛** —— 上层 catch 会放弃这次写入，坏文件原样留在盘上（fail-closed）。
 *    宁可这次没身份，也不许把唯一的一份现场毁掉。
 */
function quarantineCorruptMarker(markerPath: string): string {
  const target = `${markerPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  renameSync(markerPath, target);
  return target;
}

/**
 * 在工作区里放一个自身标记（`portable.ts` 的 `WORKSPACE_MARKER_FILE`）。
 *
 * 作用：盘符变了以后，靠"这个目录里有没有我们的标记"认出**它是不是那份工作区**
 * —— 光靠盘根 marker 只能证明"这个卷是我们的盘"，证明不了目录这一层。
 *
 * ⚠️ **身份（P-A v2，2026-10-15）**：标记里带一个 `workspaceId`（uuid），配置侧
 *    同步记一份 —— 恢复端用它证明"候选就是记录的那一份工作区"，不再拿"目录里
 *    有个通用标记"当身份（独立审查反例：外部工作区失联时冒名收养同相对路径的
 *    另一份带标记工作区）。老标记（没有 id）在**确认过的工作区**上补铸一次：
 *    `initWorkspace` / 启动 `configured` 分支都会到这里。
 *
 * ⚠️ **尽力而为、绝不抛**：写不进去（只读盘、权限）只是失去一条认盘线索，
 *    不该把「设置工作区」整个弄失败。
 *
 * ⚠️ **标记损坏要修，不是放弃**（2026-10-16 Owner C / T15「标记损坏」）：
 *    文件存在但读不出（坏 JSON / 半截写 / 非对象）时，旧实现直接 `return` ——
 *    于是 `readWorkspaceId()` 永远 null、这个工作区**永久没有身份**，而且用户确认后
 *    `startup.ts` 会把 null 身份写回配置 ⇒ 配置里记的身份被静默清掉，跨盘符自愈
 *    退化到最弱判据、且每次启动重复一遍。修法：坏文件**改名保留**（证据不丢，与
 *    `quarantineUnusableLocks` 同一条纪律），再写一份带新 `workspaceId` 的标记。
 *    绝不原地覆盖、绝不直接删除。
 */
function writeWorkspaceMarker(workspacePath: string): void {
  const markerPath = join(workspacePath, WORKSPACE_MARKER_FILE);
  try {
    if (existsSync(markerPath)) {
      // 补铸：老标记只有 formatVersion/app/createdAt ⇒ 原样补一个 workspaceId。
      const existing = readMarkerJson(markerPath);
      if (existing) {
        if (typeof existing.workspaceId === 'string' && existing.workspaceId.trim()) return;
        writeFileSync(markerPath, `${JSON.stringify({ ...existing, workspaceId: randomUUID() }, null, 2)}\n`, 'utf-8');
        return;
      }
      // 损坏（读不出/不是对象）：改名保留现场，落下去当作"没有标记"重新写一份。
      quarantineCorruptMarker(markerPath);
    }
    writeFileSync(
      markerPath,
      `${JSON.stringify(
        { formatVersion: 1, app: 'partner-w', workspaceId: randomUUID(), createdAt: new Date().toISOString() },
        null,
        2,
      )}\n`,
      'utf-8',
    );
  } catch (err) {
    console.warn('[workspace] 写工作区标记失败（忽略，继续）:', err);
  }
}

/** 读标记 JSON（容错）；读不出给 null。 */
function readMarkerJson(markerPath: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(markerPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 读工作区标记里的 `workspaceId`（P-A v2 的身份读口；没有/坏了给 null）。
 *
 * 只读、同步、绝不抛 —— 调用方是启动判定路径，读不出来只表示"身份不可用"。
 */
export function readWorkspaceId(workspacePath: string): string | null {
  const marker = readMarkerJson(join(workspacePath, WORKSPACE_MARKER_FILE));
  const id = marker?.workspaceId;
  return typeof id === 'string' && id.trim() ? id : null;
}

/**
 * 确保工作区有身份并返回它（有了就返回，没有就补铸再读；失败给 null）。
 *
 * 只对**确认过的工作区**调用（`configured` 分支 / 用户选定 / 初始化路径）——
 * 老记录在正常启动一次后就自动升级成有身份的记录。
 */
export function ensureWorkspaceId(workspacePath: string): string | null {
  writeWorkspaceMarker(workspacePath);
  return readWorkspaceId(workspacePath);
}

/** True when the destination is the same as or nested inside the source workspace path. */
export function isNestedOrEqualWorkspacePath(resolvedOld: string, resolvedNew: string): boolean {
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  const normOld = caseInsensitive ? resolvedOld.toLowerCase() : resolvedOld;
  const normNew = caseInsensitive ? resolvedNew.toLowerCase() : resolvedNew;
  const pathSep = process.platform === 'win32' ? winSep : sep;
  return normNew === normOld || normNew.startsWith(normOld + pathSep);
}

export async function migrateWorkspace(oldPath: string, newPath: string): Promise<void> {
  if (!existsSync(oldPath)) throw new Error(`Source workspace does not exist: ${oldPath}`);
  const resolvedOld = resolve(oldPath);
  const resolvedNew = resolve(newPath);
  if (isNestedOrEqualWorkspacePath(resolvedOld, resolvedNew)) {
    throw new Error('New workspace path must not be inside or equal to the current workspace');
  }
  await cp(resolvedOld, resolvedNew, {
    recursive: true,
    errorOnExist: false,
    force: true,
  });
}

export function ensureTaskDir(workspacePath: string, taskId: string): string {
  const taskDir = join(workspacePath, taskId);
  const resolved = resolve(taskDir);
  const base = resolve(workspacePath);
  if (!resolved.startsWith(base + sep)) {
    throw new Error('taskId escapes workspace directory');
  }
  if (!existsSync(taskDir)) {
    mkdirSync(taskDir, { recursive: true });
  }
  return taskDir;
}
