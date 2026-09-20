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
