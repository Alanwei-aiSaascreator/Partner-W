/**
 * 「安装助手之前，工作区到底能不能用」这一问的**唯一入口**。
 *
 * ⚠️ 为什么要有这个模块（2026-09-20 U 盘交付实机）：
 *    工作区没解析出来时，两条安装链各自**悄悄降级**成一条垃圾路径 ——
 *    - `workspace:team-path` 在 `!base` 时 `return slug`：给出去的是**相对路径**；
 *    - 市场模板把 `getWorkspacePath()` 的 null 用 `?? ''` 吞掉，再拼成
 *      `/rongying-agents/<id>`：给出去的是**根相对路径**。
 *    而工作区字符串是交给**另一个进程**（网关）去解析的：它按自己的 cwd/home 解释，
 *    于是每一个助手都建失败，界面上却只剩一句 `No agents were created successfully`
 *    —— 用户看不到原因，我们也无法远程定位。
 *
 * ⇒ 规则：安装用的工作区**必须是绝对路径**，否则一律**拒绝**，并给中文原因。
 *    拼接（`<工作区>/<子目录>`）由各自的调用方负责，这里不替它清理尾部分隔符。
 */
export const WORKSPACE_UNAVAILABLE_MESSAGE = '工作区还没准备好，先在设置里指定工作区，再安装助手。';
export const WORKSPACE_FILESYSTEM_UNSUPPORTED_MESSAGE = '当前工作区所在磁盘不支持助手文件，请改用 NTFS 工作区。';

export type InstallWorkspaceCheck = { ok: true; path: string } | { ok: false; message: string };

/** 盘符（`C:\` / `d:/`）、UNC（`\\nas\share`）、POSIX（`/tmp`）三种绝对路径形态。 */
export function isAbsoluteWorkspacePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\/]/.test(path) || /^\//.test(path);
}

export function checkInstallWorkspace(raw: string | null | undefined): InstallWorkspaceCheck {
  const path = (raw ?? '').trim();
  if (!path || !isAbsoluteWorkspacePath(path)) return { ok: false, message: WORKSPACE_UNAVAILABLE_MESSAGE };
  return { ok: true, path };
}

export async function checkInstallWorkspaceCapability(
  raw: string | null | undefined,
  probe: () => Promise<WorkspaceFsIdentity | null>,
): Promise<InstallWorkspaceCheck> {
  const checked = checkInstallWorkspace(raw);
  if (!checked.ok) return checked;

  let identity: WorkspaceFsIdentity | null;
  try {
    identity = await probe();
  } catch {
    return { ok: false, message: WORKSPACE_UNAVAILABLE_MESSAGE };
  }
  if (identity?.state === 'unsupported-identity') {
    return { ok: false, message: WORKSPACE_FILESYSTEM_UNSUPPORTED_MESSAGE };
  }
  if (identity?.state !== 'ok') return { ok: false, message: WORKSPACE_UNAVAILABLE_MESSAGE };
  return checked;
}

/**
 * 「**用户手打**的工作区字符串」能不能信 —— 比 `isAbsoluteWorkspacePath` 宽一档：
 * 绝对路径之外，`~` / `~/…` / `~\…` 也放行，因为**网关那边确实会**把 `~` 展开成家目录
 * （随包运行时 `home-dir-59dFSOZn.mjs:55-63` `expandHomePrefix`：只认 `~` 后跟结尾或 `[\\/]`
 * ⇒ `~abc` 不算、要拒）。
 *
 * ⚠️ 为什么这个判据非要有：写进 `agents.create` 的工作区是交给**网关那个进程**去解析的
 * （`agent-create-BSK3Nvv3.mjs:121` → `home-dir-59dFSOZn.mjs:66-79` `path.resolve`）
 * ⇒ **相对路径 = 网关进程的 cwd**，助手的文件落在谁也没预期的地方，而且**全程不报错**。
 *
 * ⚠️ 与 `checkInstallWorkspace` 分开、别互相替代：安装路径是**我们自己**给的
 * （`getWorkspacePath()` 的返回值，天然绝对），不需要为 `~` 开口子；这里是**用户手打**的。
 */
export function isWorkspaceInputResolvable(raw: string | null | undefined): boolean {
  const path = (raw ?? '').trim();
  if (!path) return false;
  if (path === '~' || /^~[\\/]/.test(path)) return true;
  return isAbsoluteWorkspacePath(path);
}
import type { WorkspaceFsIdentity } from '@clawwork/shared';
