import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { cp } from 'fs/promises';
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
 * 在工作区里放一个自身标记（`portable.ts` 的 `WORKSPACE_MARKER_FILE`）。
 *
 * 作用：盘符变了以后，靠"这个目录里有没有我们的标记"认出**它是不是那份工作区**
 * —— 光靠盘根 marker 只能证明"这个卷是我们的盘"，证明不了目录这一层。
 *
 * ⚠️ **尽力而为、绝不抛**：写不进去（只读盘、权限）只是失去一条认盘线索，
 *    不该把「设置工作区」整个弄失败。
 */
function writeWorkspaceMarker(workspacePath: string): void {
  const markerPath = join(workspacePath, WORKSPACE_MARKER_FILE);
  if (existsSync(markerPath)) return;
  try {
    writeFileSync(
      markerPath,
      `${JSON.stringify({ formatVersion: 1, app: 'rongying-cube', createdAt: new Date().toISOString() }, null, 2)}\n`,
      'utf-8',
    );
  } catch (err) {
    console.warn('[workspace] 写工作区标记失败（忽略，继续）:', err);
  }
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
