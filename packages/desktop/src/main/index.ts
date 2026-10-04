import { app, dialog, shell, BrowserWindow, Menu, ipcMain, globalShortcut, protocol } from 'electron';
import { join } from 'path';
import { electronApp, is } from '@electron-toolkit/utils';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { nativeTheme } from 'electron';
import { initAllGateways, destroyAllGateways } from './ws/index.js';
import { getMainWindow, setMainWindow } from './window-manager.js';
import { sendToWindow } from './ws/window-utils.js';
import { initDebugLogger, getDebugLogger } from './debug/index.js';
import { registerWsHandlers } from './ipc/ws-handlers.js';
import { registerArtifactHandlers } from './ipc/artifact-handlers.js';
import { registerInboxHandlers } from './ipc/inbox-handlers.js';
import { registerMediaHandlers } from './ipc/media-handlers.js';
import { registerWorkspaceHandlers } from './ipc/workspace-handlers.js';
import { registerSettingsHandlers } from './ipc/settings-handlers.js';
import { registerSearchHandlers } from './ipc/search-handlers.js';
import { registerDataHandlers } from './ipc/data-handlers.js';
import { registerTeamMeetingHandlers } from './ipc/team-meeting-handlers.js';
import { registerStatsHandlers } from './ipc/stats-handlers.js';
import { registerUpdateHandlers } from './ipc/update-handlers.js';
import { runUpdaterStartupHousekeeping } from './auto-updater.js';
import { registerDebugHandlers } from './ipc/debug-handlers.js';
import { configureVoicePermissionHandlers, registerVoiceHandlers } from './ipc/voice-handlers.js';
import { registerTrayHandlers } from './ipc/tray-handlers.js';
import { registerQuickLaunchHandlers } from './ipc/quick-launch-handlers.js';
import { registerContextHandlers } from './ipc/context-handlers.js';
import { registerNotificationHandlers } from './ipc/notification-handlers.js';
import { registerAvatarHandlers, registerAvatarProtocol } from './ipc/avatar-handlers.js';
import { registerHubHandlers } from './ipc/hub-handlers.js';
import { registerCommercialHandlers } from './ipc/commercial-handlers.js';
import { registerCommunityHandlers } from './ipc/community-handlers.js';
import { registerMarketHandlers } from './ipc/market-handlers.js';
import { registerGrowthHandlers } from './ipc/growth-handlers.js';
import { registerAnalyticsHandlers } from './ipc/analytics-handlers.js';
import { registerPrivacyHandlers } from './ipc/privacy-handlers.js';
import { registerKbHandlers } from './ipc/kb-handlers.js';
import { registerSkillsHandlers } from './skills/handlers.js';
import { buildKbRuntime, ensureKbRuntime } from './kb/runtime.js';
import { setupAnalytics, teardownAnalytics } from './analytics/setup.js';
import { initUsageReporter, destroyUsageReporter } from './commercial/usage-reporter.js';
import { initRelayLiveness, destroyRelayLiveness } from './commercial/relay-liveness.js';
import { bootstrapCommercialRelay } from './commercial/relay-startup.js';
import { isInstallingUpdate } from './auto-updater.js';
import {
  createPortableHealthCoordinator,
  expectedProgramPathFor,
  readPortableHealthEnvironment,
  writePortableHealthReceipt,
} from './update/portable-health.js';
import { initTray, destroyTray } from './tray.js';
import { initQuickLaunch, destroyQuickLaunch } from './quick-launch.js';
import { readConfig, updateConfig } from './workspace/config.js';
import { prepareWorkspaceAtStartup } from './workspace/startup.js';
import { createWorkspaceStartupDialogs } from './workspace/startup-dialogs.js';
import { closeDatabase, getSqlite } from './db/index.js';
import { applyUserDataOverride } from './runtime/user-data-override.js';
import { applyPortableAppData } from './runtime/portable-app-data.js';
import { continueAfterPortableAppData } from './runtime/portable-startup-gate.js';
import { runtimeCacheScopeDir } from './runtime/cache-scope.js';
import {
  buildInstanceBusyCopy,
  buildPortBusyCopy,
  readInstanceOwner,
  recordInstanceOwner,
} from './runtime/instance-guard.js';
import { bootstrapLocalGatewayRuntime, GATEWAY_PORT_OCCUPIED, shutdownLocalGatewayRuntime } from './runtime/index.js';
import { bootstrapWithRetry } from './runtime/bootstrap-retry.js';
import { ensureClientGatewayEntry } from './runtime/state-config.js';
import { PORTABLE_STATE_MIGRATION_BLOCKED } from './runtime/portable-state-migration.js';
import { getRuntimeBootstrapStatus, publishRuntimeBootstrapStatus } from './runtime/bootstrap-status.js';
import { removableDrives } from './workspace/removable-drives.js';
import { GATEWAY_WS_PORT } from '@clawwork/shared';

protocol.registerSchemesAsPrivileged([
  { scheme: 'clawwork-avatar', privileges: { secure: true, supportFetchAPI: true } },
]);

let isQuitting = false;
let devModeEnabled = false;

process.stdout?.on?.('error', () => {});
process.stderr?.on?.('error', () => {});

// Opt-in CDP endpoint for local debugging (CLAUDEW_DEBUG_PORT=9222).
// Off unless the env var is set, so packaged builds are unaffected.
if (process.env.CLAUDEW_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.CLAUDEW_DEBUG_PORT);
}

function buildAppMenu(devMode = false): Menu {
  const isMac = process.platform === 'darwin';
  const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
    { role: 'resetZoom' as const },
    { role: 'zoomIn' as const },
    { role: 'zoomOut' as const },
    { type: 'separator' as const },
    { role: 'togglefullscreen' as const },
  ];
  if (devMode || is.dev) {
    viewSubmenu.push({ type: 'separator' as const }, { role: 'reload' as const }, { role: 'toggleDevTools' as const });
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const, accelerator: 'Command+H' },
              { role: 'hideOthers' as const, accelerator: 'Command+Alt+H' },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const, accelerator: 'Command+Q' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' as const, accelerator: 'Command+W' } : { role: 'quit' as const }],
    },
    { role: 'editMenu' as const },
    {
      label: 'View',
      submenu: viewSubmenu,
    },
    ...(isMac
      ? [
          {
            label: 'Window',
            submenu: [
              { role: 'minimize' as const, accelerator: 'Command+M' },
              { role: 'zoom' as const },
              { type: 'separator' as const },
              { role: 'front' as const },
            ],
          },
        ]
      : []),
  ];
  return Menu.buildFromTemplate(template);
}

function createWindow(): BrowserWindow {
  getDebugLogger().info({ domain: 'app', event: 'app.window.create' });
  devModeEnabled = readConfig()?.devMode === true;
  Menu.setApplicationMenu(buildAppMenu(devModeEnabled));

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    icon: is.dev ? join(__dirname, '../../build/icon.png') : join(process.resourcesPath, 'icon.png'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: (() => {
      const t = readConfig()?.theme;
      const dark = t === 'light' ? false : t === 'dark' ? true : nativeTheme.shouldUseDarkColors;
      return dark ? '#1C1C1C' : '#FAFAFA';
    })(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.on('close', (e) => {
    if (!isQuitting && !isInstallingUpdate()) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('ready-to-show', () => {
    const savedZoom = readConfig()?.zoomLevel;
    if (savedZoom) {
      win.webContents.setZoomLevel(savedZoom);
    }
    win.show();
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    if ((input.meta || input.control) && (input.key === '-' || input.key === '_')) {
      const level = win.webContents.getZoomLevel() - 0.5;
      win.webContents.setZoomLevel(level);
      updateConfig({ zoomLevel: level });
      event.preventDefault();
      return;
    }

    if (is.dev || devModeEnabled) return;

    const isReload = input.key === 'F5' || ((input.meta || input.control) && input.code === 'KeyR');
    if (isReload) event.preventDefault();
  });

  win.on('blur', () => {
    if (win.isDestroyed()) return;
    const level = win.webContents.getZoomLevel();
    const saved = readConfig()?.zoomLevel ?? 0;
    if (level !== saved) {
      updateConfig({ zoomLevel: level });
    }
  });

  win.webContents.setWindowOpenHandler((details) => {
    try {
      const parsed = new URL(details.url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        shell.openExternal(details.url);
      }
    } catch {}
    return { action: 'deny' };
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  setMainWindow(win);
  return win;
}

// ⚠️ 必须在 `app.ready` **之前**：userData 路径要在建窗口/建数据库之前就定下来。
// 仅 dev/test 且显式设了 CLAWWORK_USER_DATA_DIR 时生效 —— 这是模拟"新用户"的
// **唯一**合法手段（绝不靠删真实 %APPDATA%，见 junction 事故）。
applyUserDataOverride({ app, isPackaged: app.isPackaged });

const localUserDataDir = app.getPath('userData');

/**
 * ⚠️ **必须排在 `requestSingleInstanceLock()` 之前**，也就必须在 `app.ready` 之前：
 * 单实例锁是**按 userData 目录**算的 —— 先搬、再抢锁，U 盘那份才不会和"装到电脑"
 * 那份抢同一个实例（那正是交付包里那个 `.bat` 唯一在做的事：怕用户"双击没反应"）。
 *
 * ⚠️ 判定只认盘（可移动盘 / 盘根 marker / 我们自己的工作区 marker），本机安装形态
 * 一次 `setPath` 都不会发生（`portable-app-data.ts` 里有测试钉住）。
 */
const portableAppData = applyPortableAppData({
  app,
  exePath: process.execPath,
  isPackaged: app.isPackaged,
  systemDrive: process.env.SystemDrive ?? null,
  // 交付形态判据要拿它跟自己那份随包运行时对（`DriveType=3` 的盘上只剩这条判据）。
  resourcesPath: process.resourcesPath,
  exists: existsSync,
  // 惰性：前两条判据（纯文件检查）命中时**不枚举**可移动盘（PowerShell，秒级）。
  removableDrives: () => removableDrives(),
});

continueAfterPortableAppData(
  portableAppData,
  {
    notifyFailure: (copy) => dialog.showErrorBox(copy.title, copy.content),
    exit: (code) => app.exit(code),
  },
  () => {
    const runtimeCacheUserDataDir = runtimeCacheScopeDir({
      localUserDataDir,
      effectiveUserDataDir: app.getPath('userData'),
      portable: portableAppData.reason !== null && portableAppData.failed === undefined,
    });

    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      /**
       * ⚠️ 旧行为是**裸 `app.quit()`** —— 用户看到的是"双击了没反应"（U 盘交付包里那个
       * `①双击这里启动.bat` 唯一在做的事，就是拿 tasklist 查一遍再 echo 一段人话）。
       * 交付包不再带 `.bat`（用户直接双击 `荣盈魔方\荣盈魔方.exe`），这句话就得由程序说。
       * 抢不到锁 ⇒ 同一个 userData 目录下已经有一份在跑 ⇒ 那一份刚写过主人文件，读出来
       * 告诉用户是哪一份、出口在哪儿。
       */
      void app.whenReady().then(async () => {
        const copy = buildInstanceBusyCopy({
          owner: readInstanceOwner({ userDataDir: app.getPath('userData') }),
          currentExePath: process.execPath,
        });
        await dialog.showMessageBox({
          type: 'info',
          title: copy.title,
          message: copy.message,
          detail: copy.detail,
          buttons: [copy.button],
          noLink: true,
          defaultId: 0,
        });
        app.quit();
      });
    } else {
      // 抢到锁 ⇒ 先把"这一份在跑"记下来（越早越好：第二次双击时才有得读）。
      // 失败无所谓（盘只读/没权限），它只是给对话框用的一句解释。
      recordInstanceOwner({
        userDataDir: app.getPath('userData'),
        exePath: process.execPath,
        portable: portableAppData.target !== null,
      });

      app.on('second-instance', () => {
        const win = getMainWindow();
        if (win) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
      });

      const portableHealthHandoff = readPortableHealthEnvironment(process.env);
      const portableHealth = createPortableHealthCoordinator({
        ...portableHealthHandoff,
        expectedProgramPath: expectedProgramPathFor(portableHealthHandoff.healthPath),
        runningProgramPath: dirname(process.execPath),
        runningVersion: app.getVersion(),
        writeReceipt: async (receipt) => {
          const healthPath = portableHealthHandoff.healthPath;
          if (healthPath === undefined) return;
          await writePortableHealthReceipt({ healthPath, receipt });
        },
      });

      app
        .whenReady()
        .then(async () => {
          initDebugLogger(app.getPath('logs'));
          getDebugLogger().info({ domain: 'app', event: 'app.start', data: { userData: app.getPath('userData') } });
          // 盘上形态（把应用数据放进 U 盘）在 `app.ready` 之前就决定了，那时还没有日志 ——
          // 补记一笔，否则"数据到底落在哪儿"在日志里查不到（外部审计问过这个）。
          if (portableAppData.target) {
            getDebugLogger().info({
              domain: 'app',
              event: 'app.userData.portable',
              data: {
                userData: portableAppData.target,
                volumeRoot: portableAppData.volumeRoot,
                reason: portableAppData.reason,
              },
            });
          } else if (portableAppData.failed) {
            getDebugLogger().warn({
              domain: 'app',
              event: 'app.userData.portable_failed',
              data: {
                volumeRoot: portableAppData.volumeRoot,
                reason: portableAppData.reason,
                message: portableAppData.failed,
              },
            });
          }
          electronApp.setAppUserModelId(
            portableAppData.reason ? 'com.mofangluopan.app.portable' : 'com.mofangluopan.app',
          );

          registerWsHandlers();
          registerArtifactHandlers();
          registerInboxHandlers();
          registerMediaHandlers();
          registerWorkspaceHandlers(
            portableAppData.target
              ? {
                  syncRuntimeWorkspace: async (workspacePath) => {
                    await ensureClientGatewayEntry({
                      userDataDir: app.getPath('userData'),
                      stateUserDataDir: app.getPath('userData'),
                      legacyStateUserDataDir: localUserDataDir,
                      portableWorkspacePath: workspacePath,
                    });
                  },
                }
              : {},
          );
          registerSettingsHandlers();
          registerSearchHandlers();
          registerDataHandlers();
          registerTeamMeetingHandlers();
          registerStatsHandlers();
          registerUpdateHandlers({ onRendererReady: () => portableHealth.markRendererReady() });
          registerDebugHandlers();
          registerVoiceHandlers();
          configureVoicePermissionHandlers();
          registerTrayHandlers();
          registerQuickLaunchHandlers();
          registerContextHandlers();
          registerNotificationHandlers();
          registerAvatarHandlers();
          registerAvatarProtocol();
          registerHubHandlers();
          registerCommercialHandlers();
          registerCommunityHandlers();
          registerMarketHandlers();
          registerGrowthHandlers();
          registerAnalyticsHandlers();
          registerPrivacyHandlers();
          registerKbHandlers();
          // 「我们自己的技能」—— 随包目录 + 一键装/卸（T-a2）。
          registerSkillsHandlers();

          ipcMain.handle('app:rebuild-menu', () => {
            devModeEnabled = readConfig()?.devMode === true;
            Menu.setApplicationMenu(buildAppMenu(devModeEnabled));
          });

          /**
           * 本机运行时起不来的**初始读**（渲染层挂载时补读一次）。
           *
           * ⚠️ 与 relay 公开状态是同一个形状的同一个理由（见 `commercial-handlers.ts`）：
           *    bootstrap 在 `app.whenReady()` 里就跑，窗口与渲染层是**之后**才挂上来的 ——
           *    那之前发出的推送没人收。少了这条读，界面就只会一直"正在准备模型"。
           * ⚠️ 返回 `null` = **还没有结论**，与"没问题"是两回事：界面按"没结论"处理
           *    （继续显示准备中），不许把它说成出错。
           */
          ipcMain.handle('runtime:bootstrap-status', () => getRuntimeBootstrapStatus());

          ipcMain.on('ui:set-window-button-visibility', (_event, visible: boolean) => {
            if (process.platform === 'darwin') {
              const win = getMainWindow();
              if (win) win.setWindowButtonVisibility(visible);
            }
          });

          // 主进程这一侧就绪 = 全部 IPC 已注册。健康回执四个里程碑里的第一个。
          portableHealth.markMainReady();

          // ⚠️ 工作区准备（T-U1）——盘上首启不选盘、盘符变了自愈、数据库打不开给「换目录/重建/退出」
          //    三选一。**任何失败路径都不许在这里 `app.quit()`**：退出只能由用户在对话框里选
          //    （源码契约钉在 `test/workspace-startup-flow.test.ts`）。旧行为是
          //    `showErrorBox('Database Error') + app.quit()` —— 换机器/换盘符就是死路一条。
          const workspace = await prepareWorkspaceAtStartup({
            exePath: process.execPath,
            resourcesPath: process.resourcesPath,
            dialogs: createWorkspaceStartupDialogs(),
            quit: () => app.quit(),
            onEvent: (event, data) => getDebugLogger().info({ domain: 'workspace', event, data }),
          });
          if (workspace.kind === 'quit') return;
          const wsPath = workspace.path;
          getDebugLogger().info({
            domain: 'workspace',
            event: 'workspace.detected',
            data: { workspacePath: wsPath, portable: workspace.portable, decision: workspace.decision.kind },
          });

          // 工作区就绪 = 本地库已经打开（`prepareWorkspaceAtStartup` 里建的）。
          portableHealth.markDatabaseReady();

          // ⚠️ 更新缓存的日常维护必须**在工作区就绪之后**做：清理逻辑要靠
          //    `getPortableWorkspaceRoot()` 判断"这一进程是不是盘上运行"，而那个判定
          //    就是上面 `prepareWorkspaceAtStartup()` 写下的（放在 registerUpdateHandlers
          //    那会儿还恒为 null ⇒ U 盘那份会去清本机共享的更新缓存，把同机另一份副本
          //    正等着装的包删掉）。
          runUpdaterStartupHousekeeping();

          // ⚠️ 埋点必须**在开窗之前**初始化：窗口一开，登录/激活的 IPC 就活了，
          //    而下面那次运行时就绪等待在首跑要 37–74 秒 —— 用户在这段里完成登录/激活时，
          //    未初始化的 `trackEvent` 是**静默 no-op**（无日志、无重试），首跑最关键的
          //    `login_success` / `license_activated` 会直接丢掉。
          setupAnalytics();

          // 窗口先出来，别像卡死 —— 首次启动要解压 35k 个文件（1–3 分钟）
          createWindow();

          // 窗口已经存在。渲染进程那一侧还要它自己握手（`markRendererReady`）。
          portableHealth.markWindowReady();

          // 资料库运行时（T6b/T6c）：加载本地嵌入模型 + 建服务。
          //
          // ⚠️ **故意不 await**：加载要读 90MB 模型（几百毫秒到几秒），绝不能挡在开窗之前。
          // ⚠️ 失败也**不影响别的**：`createKbRuntime` 在引擎起不来时返回一个 engine=null 的
          //    服务（纯关键词检索，合法降级），所以这里只需要把"连服务都没建起来"记进日志。
          //    界面拿到的是 `kb:not-ready`，与"你还没加过资料"是两回事（见 kb-handlers 的说明）。
          void ensureKbRuntime(() => {
            const sqlite = getSqlite();
            if (!sqlite) throw new Error('工作区库未初始化');
            return buildKbRuntime({
              sqlite,
              isPackaged: app.isPackaged,
              resourcesPath: process.resourcesPath,
              appPath: app.getAppPath(),
              log: (event, data) => getDebugLogger().info({ domain: 'kb', event, data }),
            });
          }).catch((err: unknown) => {
            getDebugLogger().error({
              domain: 'kb',
              event: 'kb.runtime.create_failed',
              data: { message: err instanceof Error ? err.message : String(err) },
            });
          });

          // ⚠️ 拉起本机运行时（定位 → 部署 → 起网关 → 等就绪）。**这一步永不抛**：
          // 失败只是"网关没起来"，界面照常出，让 ConnectionBanner 说真话；
          // 上一轮留下的、或用户自己的网关可能还活着，下面 initAllGateways() 照样要去连它。
          const runtimeResult = await bootstrapWithRetry({
            attempt: () =>
              bootstrapLocalGatewayRuntime({
                userDataDir: app.getPath('userData'),
                runtimeCacheUserDataDir,
                stateCacheUserDataDir: app.getPath('userData'),
                legacyStateUserDataDir: portableAppData.target ? localUserDataDir : undefined,
                // 便携版主助手必须和用户文件一起留在已验证的盘上工作区；否则 OpenClaw
                // 会把 `main` 默认到本机 state/workspace，生成物与“记住你”的文件就会
                // 悄悄落进 C 盘。非 NTFS 盘已在工作区启动门禁被诚实拒绝。
                portableWorkspacePath: workspace.portable ? wsPath : undefined,
                deps: {
                  log: (event, data) => {
                    const entry = { domain: 'gateway' as const, event, data };
                    if (event === 'runtime.bootstrap.failed') getDebugLogger().error(entry);
                    else getDebugLogger().info(entry);
                  },
                },
              }),
            sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
            // ⭐ 只在**可重试**的那一类上退避（我们自己的网关还没就绪）。
            //    端口被**别人的**网关占用是终态 —— 见 `runtime/bootstrap-retry.ts` 的白名单。
            onRetry: ({ attempt, delayMs, reason }) =>
              getDebugLogger().info({
                domain: 'gateway',
                event: 'runtime.bootstrap.retry',
                data: { attempt, delayMs, reason },
              }),
          });
          if (!runtimeResult.ok) {
            // ⚠️ 盘上那份与"装到电脑"那份的应用数据现在是**分开**的（各自一个单实例锁），
            //    "两份同时开着"于是从"第二份根本起不来"变成了"第二份能开、本地网关抢不到
            //    18789"。这个失败必须**当面说出来**：界面只会显示"连不上"，用户无从下手。
            //    （原来只有一行日志，出了事谁也看不见。）
            if (runtimeResult.code === GATEWAY_PORT_OCCUPIED) {
              const copy = buildPortBusyCopy({ port: GATEWAY_WS_PORT });
              const win = getMainWindow();
              const options: Electron.MessageBoxOptions = {
                type: 'warning',
                title: copy.title,
                message: copy.message,
                detail: copy.detail,
                buttons: [copy.button],
                noLink: true,
                defaultId: 0,
              };
              void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
            }
            // ⭐ 光弹一次窗是不够的：用户点掉之后界面上**什么都不剩**，只会显示
            //    "正在准备模型"一直转（2026-09-25 真日志：六分钟）。所以这条结论要
            //    留在主进程里、并推给渲染层 —— 界面才说得出是哪一类失败。
            //    ⚠️ 只发 `{ ok, code }`，`runtimeResult.reason`（给人看的那条描述，
            //    带路径/端口）**不进** IPC：见 `runtime/bootstrap-status.ts`。
            //    ⚠️ 推可能丢（窗口还没挂上来）—— 渲染层挂上来后会用
            //    `runtime:bootstrap-status` 补读一次，所以这里推失败不是 bug。
          }

          publishRuntimeBootstrapStatus(runtimeResult);
          sendToWindow(getMainWindow(), 'runtime-status', getRuntimeBootstrapStatus());

          if (runtimeResult.code !== PORTABLE_STATE_MIGRATION_BLOCKED) initAllGateways();

          // ⚠️ **runtime ready ≠ commercial ready**：网关活着只说明连得上；模型能不能用
          // 要看中转配置有没有落到网关（clawrouter provider）。
          //
          // 刻意**不 await**：这一步要等网关握手、要问服务端要 key，首次启动可能十几秒 ——
          // 挡住的话窗口白屏。也不抛（内部永不抛），因为"没登录/没激活"是**正常状态**，
          // 不是启动失败；界面自己有未激活的表达。
          //
          // 目录刷新靠 dispatcher 既有的退避重试（~60s 预算，见 gateway-dispatcher），
          // 它本来就是为"网关目录还没热"这件事写的。
          void bootstrapCommercialRelay().then((res) => {
            getDebugLogger().info({ domain: 'commercial', event: 'commercial.relay.bootstrap', data: { ...res } });
          });

          // 放在网关之后：首跑要立刻读一次额度，此时会话/配置已就绪，否则首报必然是空
          initUsageReporter();
          initRelayLiveness();
          initTray();
          initQuickLaunch();

          app.on('activate', () => {
            const win = getMainWindow();
            if (win) {
              win.show();
              win.focus();
            } else {
              createWindow();
            }
          });
        })
        // ⚠️ 这条 `.catch()` 是**必须**的，不是保险丝：上面那条链一个 `await` 拒绝，
        //    `createWindow()` 就永远不会执行 —— 进程活着、屏幕上什么都没有，用户
        //    只会说"双击了没反应"（没有全局 unhandledRejection 兜底，日志里也就那一行）。
        //    兜住之后至少开一个窗口，让界面自己把"没就绪/连不上"说出来。
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          try {
            getDebugLogger().error({ domain: 'app', event: 'app.whenReady.failed', data: { message } });
          } catch {
            // 日志系统本身还没起来时也不能在这里再抛
          }
          console.error('[app] whenReady chain failed:', err);
          try {
            if (!getMainWindow()) createWindow();
          } catch (windowErr) {
            console.error('[app] failed to open a window after startup failure:', windowErr);
          }
        });
    }
  },
);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;

  const logger = getDebugLogger();
  logger.info({ domain: 'app', event: 'app.before-quit', data: { installingUpdate: isInstallingUpdate() } });

  // Flush pending debug log writes before exit, then complete shutdown
  logger
    .flush()
    .catch(() => {})
    .finally(() => {
      globalShortcut.unregisterAll();
      // 先掐定时器，否则拆网关的过程中还会触发一次上报，撞上半死会话
      destroyUsageReporter();
      destroyRelayLiveness();
      // 顺手把队列里剩下的事件发出去（最后一次 flush 只在这一刻发生）
      teardownAnalytics();
      // ⚠️ 只有 ownership==='spawned' 才会真的停 —— 复用的网关是**先于客户端存在**的，
      // 绝不能因为用户关掉客户端就把它带走（判断在 stopGatewayIfOwned 里，有单测钉住）
      void shutdownLocalGatewayRuntime()
        .catch((err) => {
          // 收尾失败**绝不能**挡住退出 —— 记一笔就继续
          console.error('[runtime] 退出时收尾失败（忽略，继续退出）:', err);
        })
        .finally(async () => {
          destroyAllGateways();
          destroyTray();
          destroyQuickLaunch();
          closeDatabase();
          await logger.close().catch((err) => console.error('[debug] close failed:', err));
          app.quit();
        });
    });
});
