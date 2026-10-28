/**
 * 主框架导航守卫（BUG-056②）。规则与既有 `setWindowOpenHandler` 一致：
 * 只允许应用自己的页面（prod=渲染目录内的 file://；dev=ELECTRON_RENDERER_URL 同源），
 * 其余 http(s) 交给系统浏览器，javascript:/data:/file: 越界一律只拦不跳。
 *
 * 接线（I 域）：`main/index.ts` 的 `createWindow()` 与 `quick-launch.ts` 的
 * `createQuickLaunchWindow()` 各自在 loadURL/loadFile **之前**装一次。
 */
import { shell, type WebContents } from 'electron';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NavigationGuardOptions {
  /** dev 下允许的渲染层源（ELECTRON_RENDERER_URL）；prod 传 null。 */
  devOrigin?: string | null;
  /** prod 下应用渲染目录（file:// 页面只许在本目录内导航）。 */
  appRendererDir: string;
  /** 外链打开器（测试注入用）。 */
  openExternal?: (url: string) => void;
}

export function isAllowedAppNavigation(rawUrl: string, options: NavigationGuardOptions): boolean {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return false;
  }
  if (options.devOrigin) {
    try {
      return target.origin === new URL(options.devOrigin).origin;
    } catch {
      return false;
    }
  }
  if (target.protocol !== 'file:') return false;
  try {
    const filePath = realpathSync(fileURLToPath(target));
    const root = realpathSync(options.appRendererDir);
    const relation = relative(root, filePath);
    return relation !== '' && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
  } catch {
    return false;
  }
}

export function installNavigationGuards(contents: Pick<WebContents, 'on'>, options: NavigationGuardOptions): void {
  const open = options.openExternal ?? ((url: string) => void shell.openExternal(url));
  const guard = (event: { preventDefault: () => void }, url: string): void => {
    if (isAllowedAppNavigation(url, options)) return;
    event.preventDefault();
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') open(url);
    } catch {
      /* 连 URL 都不是：只拦 */
    }
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard); // 服务器跳转同样不许把主框架带出去
}
