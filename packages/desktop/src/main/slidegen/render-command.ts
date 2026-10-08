import { app, session } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSlideSourceFile } from './render-file.js';
import { contained } from './source-file.js';
import { renderNativePptFile } from '../docgen/native-file.js';
import { resolvePptxTemplatesRoot } from '../docgen/pptx-template/locate.js';

let sent = false;
let deadline: ReturnType<typeof setTimeout> | undefined;
function finish(report: { status: string }) {
  if (sent) return;
  sent = true;
  clearTimeout(deadline);
  process.stdout.write(JSON.stringify(report) + '\n', () => app.exit(report.status === 'file-generated' ? 0 : 1));
}
function failure(code: string) {
  return {
    schemaVersion: 1,
    status: 'render-failed',
    diagnostics: [{ code }],
    fileCreated: false,
    artifactIndexed: false,
    visualReview: 'not-performed',
  };
}

const native = process.argv.includes('--royin-render-native-ppt');
const flag = process.argv.indexOf(native ? '--royin-render-native-ppt' : '--royin-render-slidegen');
const args = process.argv.slice(flag + 1);
if (
  flag < 0 ||
  (args.length !== 1 && !(native && args.length === 3 && args[1] === '--previous')) ||
  args[0].startsWith('--')
) {
  finish({ ...failure('source-argument-invalid'), status: 'source-invalid' });
} else {
  try {
    /**
     * BUG-041 ③：工作区要么**显式传进来**（`ROYIN_SLIDEGEN_WORKSPACE`，调用方=技能脚本，
     * 它手里就是任务工作区），要么回落 `cwd`（历史行为）。
     *
     * 为什么不能只靠 `cwd`：这是个子进程，`cwd` 是调用方"顺手"设的 —— 一旦哪天换壳
     * （打包器/服务化/测试夹具）它就是**宿主目录**，而工作区在这里是"哪些文件允许被
     * 渲染进程读"的边界（见下面 onBeforeRequest 的 `contained(workspace, file)`）：
     * 认错工作区 = 要么渲染读不到源文件，要么把边界放到了别处。
     *
     * ⚠️ 显式值读不出来（路径不存在等）⇒ 回落到 cwd 并**在 stderr 留痕**：
     *    stdout 是给调用方解析的 JSON 流，绝不能掺进日志。
     */
    const explicitWorkspace = process.env.ROYIN_SLIDEGEN_WORKSPACE?.trim();
    let workspace: string;
    if (explicitWorkspace) {
      try {
        workspace = fs.realpathSync(explicitWorkspace);
      } catch (error) {
        console.error('[royin-render] ROYIN_SLIDEGEN_WORKSPACE 不可用，回落 cwd:', error);
        workspace = fs.realpathSync(process.cwd());
      }
    } else {
      workspace = fs.realpathSync(process.cwd());
      console.error(
        `[royin-render] ROYIN_SLIDEGEN_WORKSPACE 未设置，按 cwd 推断工作区（调用方应显式传入）: ${workspace}`,
      );
    }
    const requestedProfile = process.env.ROYIN_SLIDEGEN_PROFILE;
    const profile = requestedProfile
      ? fs.realpathSync(requestedProfile)
      : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'royin-slidegen-')));
    if (
      requestedProfile &&
      (path.dirname(fs.realpathSync(os.tmpdir())) !== profile ||
        !path.basename(profile).startsWith('royin-slidegen-launch-'))
    )
      throw new Error('invalid launcher profile');
    for (const name of ['appData', 'userData', 'sessionData', 'logs', 'temp', 'cache', 'crashDumps'] as const) {
      const directory = path.join(profile, name);
      fs.mkdirSync(directory, { recursive: true });
      app.setPath(name, directory);
    }
    process.env.TEMP = path.join(profile, 'temp');
    process.env.TMP = process.env.TEMP;
    app.disableHardwareAcceleration();
    deadline = setTimeout(() => finish(failure('render-command-timeout')), 120_000);
    app
      .whenReady()
      .then(async () => {
        session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
          let allowed = /^(data:|devtools:)/.test(details.url);
          if (details.url.startsWith('file:')) {
            try {
              const file = fs.realpathSync(fileURLToPath(details.url));
              allowed = contained(workspace, file) || contained(profile, file);
            } catch {
              allowed = false;
            }
          }
          callback({ cancel: !allowed });
        });
        session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        session.defaultSession.setPermissionCheckHandler(() => false);
        try {
          if (native) {
            finish(
              await renderNativePptFile(args[0], workspace, {
                enabled: process.env.ROYIN_NATIVE_PPT_VALIDATION === '1',
                templatesRoot: resolvePptxTemplatesRoot({
                  isPackaged: app.isPackaged,
                  appPath: app.getAppPath(),
                  resourcesPath: process.resourcesPath,
                }),
                previous: args[2],
                isCurrent: () => !sent,
              }),
            );
          } else
            finish(
              await renderSlideSourceFile(args[0], workspace, {
                onPage: (progress) => {
                  if (!sent) process.stdout.write(JSON.stringify(progress) + '\n');
                },
              }),
            );
        } catch {
          finish(failure('render-command-failed'));
        }
      })
      .catch(() => finish(failure('render-runtime-unavailable')));
  } catch {
    finish(failure('render-runtime-unavailable'));
  }
}
