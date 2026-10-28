import { app } from 'electron';
import { join } from 'node:path';

/**
 * 远程访问相关路径解析。
 *
 * 打包态与开发态的落点不同，这里集中一处，避免"开发能跑、装机就 503"这类漂移
 * （静态页目录找不到时 RemotePageServer 会返回 503，看着像网络问题）。
 */

/** 设备页静态资源根目录。 */
export function resolveRemotePageRoot(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app-remote');
  }
  // 开发态：packages/desktop → packages/pwa/dist（app.getAppPath() 是 packages/desktop）
  return join(app.getAppPath(), '..', 'pwa', 'dist');
}

/** frpc 可执行文件。随包分发，落在 <resources>/runtime/win32-x64/。 */
export function resolveFrpcBinary(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'runtime', 'win32-x64', 'frpc.exe');
  }
  return join(app.getAppPath(), '..', '..', 'runtime-out', 'win32-x64', 'frpc.exe');
}

/** 远程访问的配置文件（M1 阶段由本地写入，M2 起由后端下发后覆盖）。 */
export function resolveRemoteAccessConfigPath(): string {
  return join(app.getPath('userData'), 'remote-access.json');
}

/** frpc.toml 与 frpc 日志落在运行数据下。 */
export function resolveRemoteAccessStateDir(): string {
  return join(app.getPath('userData'), 'runtime');
}
