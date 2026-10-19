import { app, dialog, shell, BrowserWindow, Menu, ipcMain, globalShortcut, protocol } from 'electron';
import { join } from 'path';
import { electronApp, is } from '@electron-toolkit/utils';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { nativeTheme } from 'electron';
import { initAllGateways, destroyAllGateways, getGatewayClient, reconnectGateway } from './ws/index.js';
import { getMainWindow, setMainWindow } from './window-manager.js';
import { sendToWindow } from './ws/window-utils.js';
import { initDebugLogger, getDebugLogger } from './debug/index.js';
import { getExecutionHistory, stopExecutionHistory } from './execution/history-instance.js';
import type { ExecutionEvent } from '@clawwork/core';
import { registerWsHandlers } from './ipc/ws-handlers.js';
import { registerArtifactHandlers } from './ipc/artifact-handlers.js';
import { registerInboxHandlers } from './ipc/inbox-handlers.js';
import { registerMediaHandlers } from './ipc/media-handlers.js';
import { registerWorkspaceHandlers } from './ipc/workspace-handlers.js';
import { registerSettingsHandlers } from './ipc/settings-handlers.js';
import { registerSearchHandlers } from './ipc/search-handlers.js';
import { registerDataHandlers } from './ipc/data-handlers.js';
import { registerMemoryHandlers } from './ipc/memory-handlers.js';
import { ensureMemoryContractPromptWithRetry } from './memory/contract.js';
import { syncMemoryToAgentsWithRetry } from './memory/sync.js';
import { registerProfileStorageHandlers, requestQuitStorageFlush } from './ipc/profile-storage-handlers.js';
import { registerTeamMeetingHandlers } from './ipc/team-meeting-handlers.js';
import { registerStatsHandlers } from './ipc/stats-handlers.js';
import { installNavigationGuards } from './security/navigation-guard.js';
import { registerUpdateHandlers } from './ipc/update-handlers.js';
import { runUpdaterStartupHousekeeping } from './auto-updater.js';
import { registerDebugHandlers } from './ipc/debug-handlers.js';
import { configureVoicePermissionHandlers, registerVoiceHandlers } from './ipc/voice-handlers.js';
import { registerTrayHandlers } from './ipc/tray-handlers.js';
import { registerQuickLaunchHandlers } from './ipc/quick-launch-handlers.js';
import { registerContextHandlers } from './ipc/context-handlers.js';
import { registerNotificationHandlers } from './ipc/notification-handlers.js';
import { registerAvatarHandlers, registerAvatarProtocol } from './ipc/avatar-handlers.js';
import { registerOpeningMediaProtocol } from './media/opening-asset.js';
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
import {
  bootstrapLocalGatewayRuntime,
  GATEWAY_PORT_OCCUPIED,
  getActiveLocalGatewayStateDir,
  shutdownLocalGatewayRuntime,
} from './runtime/index.js';
import type { RuntimeBootstrapResult } from './runtime/index.js';
import type { DeployProgress } from './runtime/deploy.js';
import {
  clearDeployProgress,
  createDeployStallWatch,
  getDeployProgress,
  publishDeployProgress,
  publishDeployStalled,
} from './runtime/deploy-progress.js';
import { bootstrapWithRetry } from './runtime/bootstrap-retry.js';
import { ensureClientGatewayEntry, LOCAL_GATEWAY_ID } from './runtime/state-config.js';
import { ensureCapabilityBoundaryPromptWithRetry } from './capability/capability-boundary-prompt.js';
import { PORTABLE_STATE_MIGRATION_BLOCKED } from './runtime/portable-state-migration.js';
// 诊断与修复（FEAT-03）：引擎/宿主是**纯逻辑+只读探测**，不 import electron，
// 所以在主进程里静态引入不会多拉任何窗口/GUI 依赖。
import { createSessionForHost, readPersistedLanguage, resolveRepairHost } from './repair/host.js';
import { registerRepairHandlers } from './ipc/repair-handlers.js';
import { registerConnectorHandlers } from './ipc/connector-handlers.js';
import { repairFeishuInstallOnStartup } from './connectors/feishu-install-repair.js';
import { clearProviderBillingCooldowns, resolveCooldownStateDirs } from './commercial/auth-cooldown.js';
import { registerPetHandlers } from './ipc/pet-handlers.js';
import { registerVideoQualityHandlers } from './ipc/video-quality-handlers.js';
import { getRuntimeBootstrapStatus, publishRuntimeBootstrapStatus } from './runtime/bootstrap-status.js';
import { removableDrives } from './workspace/removable-drives.js';
import { GATEWAY_WS_PORT } from '@clawwork/shared';
import type { RuntimeDeployProgress } from '@clawwork/shared';

protocol.registerSchemesAsPrivileged([
  { scheme: 'clawwork-avatar', privileges: { secure: true, supportFetchAPI: true } },
  { scheme: 'clawwork-asset', privileges: { secure: true, supportFetchAPI: true } },
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
  // ⚠️ 2026-10-06（用户点名）：Windows 菜单栏必须**汉化**（原 File/Edit/View 英文上屏，
  //    对商业交付用户属"半成品感"）。方案=**保留 Electron role（快捷键/行为零变化）只改标签**；
  //    「重新加载/开发者工具」仅 dev/调试模式可见（生产面不出现开发项）。macOS 分支维持惯例不动。
  const viewSubmenu: Electron.MenuItemConstructorOptions[] = [
    { role: 'resetZoom' as const, label: '实际大小' },
    { role: 'zoomIn' as const, label: '放大' },
    { role: 'zoomOut' as const, label: '缩小' },
    { type: 'separator' as const },
    { role: 'togglefullscreen' as const, label: '全屏' },
  ];
  if (devMode || is.dev) {
    viewSubmenu.push(
      { type: 'separator' as const },
      { role: 'reload' as const, label: '重新加载' },
      { role: 'toggleDevTools' as const, label: '开发者工具' },
    );
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
      label: '文件',
      submenu: [
        isMac
          ? { role: 'close' as const, label: '关闭窗口', accelerator: 'Command+W' }
          : { role: 'quit' as const, label: '退出荣盈魔方' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' as const, label: '撤销' },
        { role: 'redo' as const, label: '重做' },
        { type: 'separator' as const },
        { role: 'cut' as const, label: '剪切' },
        { role: 'copy' as const, label: '复制' },
        { role: 'paste' as const, label: '粘贴' },
        ...(isMac ? [{ role: 'pasteAndMatchStyle' as const, label: '粘贴并匹配样式' }] : []),
        { role: 'delete' as const, label: '删除' },
        { type: 'separator' as const },
        { role: 'selectAll' as const, label: '全选' },
      ],
    },
    {
      label: '视图',
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
    icon: is.dev ? join(import.meta.dirname, '../../build/icon.png') : join(process.resourcesPath, 'icon.png'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: (() => {
      const t = readConfig()?.theme;
      const dark = t === 'light' ? false : t === 'dark' ? true : nativeTheme.shouldUseDarkColors;
      return dark ? '#1C1C1C' : '#FAFAFA';
    })(),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
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

  // ⭐ BUG-056②（S 包 patch，I 接线）：主框架导航守卫 —— 只许应用自己的页面；
  //    外链交给系统浏览器；will-navigate/will-redirect 双钩（服务器跳转也不许把主框架带出去）。
  installNavigationGuards(win.webContents, {
    devOrigin: is.dev ? (process.env['ELECTRON_RENDERER_URL'] ?? null) : null,
    appRendererDir: join(import.meta.dirname, '../renderer'),
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
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

      /**
       * 部署进度：主进程留快照 + 推给渲染层（窗口还没挂上来时推送会丢，
       * 渲染层挂上来后靠 `runtime:deploy-progress` 补读 —— 见 `deploy-progress.ts`）。
       *
       * ⚠️ 每条真实事件都重新计时；**>90 秒没有新事件** = 这块盘读写很慢 ——
       *    推一条 `stalled` 让界面说人话（"正在等系统响应"），但**不中止**任何东西：
       *    慢盘上重来一次只会更坏（前功尽弃，还要再等一遍）。
       */
      const emitDeployProgress = (snapshot: RuntimeDeployProgress | null): void => {
        sendToWindow(getMainWindow(), 'runtime-deploy-progress', snapshot);
      };
      const deployStallWatch = createDeployStallWatch({
        onStall: () => {
          const stalled = publishDeployStalled();
          if (stalled) emitDeployProgress(stalled);
        },
      });
      const handleDeployProgress = (progress: DeployProgress): void => {
        const published = publishDeployProgress(progress);
        if (published) emitDeployProgress(published);
        // `finalize` = 部署本体已走完（再往后是解析 Node / 起网关，是**另一段**等待，
        // 不该被"部署停滞"的提示粘上）。
        if (progress.phase === 'finalize') deployStallWatch.cancel();
        else deployStallWatch.touch();
      };
      /** 这一轮部署结束（成功/失败都算）：清快照 + 推 null，界面不再挂着上一轮的进度。 */
      const finishDeployProgress = (): void => {
        deployStallWatch.cancel();
        const hadProgress = getDeployProgress() !== null;
        clearDeployProgress();
        // 全程没报过进度（走的是"本机缓存已就绪"的快路径）⇒ 不推：没人见过它开始，
        // 也就不需要一条"它结束了"。
        if (hadProgress) emitDeployProgress(null);
      };

      /**
       * 一轮完整的本机运行时拉起（定位 → 部署 → 起网关 → 等就绪）。
       *
       * ⚠️ 启动路径与用户点的「重新准备」（IPC `runtime:bootstrap-retry`）**共用这一段**：
       *    两条路各写一遍必然漂移，而漂移的代价是"手动重试和启动跑的不是同一件事"。
       */
      const runRuntimeBootstrap = (portableWorkspacePath: string | undefined): Promise<RuntimeBootstrapResult> => {
        // BUG-161：网关尚未拉起时先清一次「计费冷却」——内核在 worker 里缓存那份 store，
        // 只有启动前清才可靠（换卡后重启客户端即恢复，不必干等 10 分钟）。
        try {
          clearProviderBillingCooldowns({
            stateDirs: resolveCooldownStateDirs(app.getPath('userData'), process.env.OPENCLAW_STATE_DIR),
          });
        } catch {
          // 清不了不影响启动。
        }
        return bootstrapWithRetry({
          attempt: () =>
            bootstrapLocalGatewayRuntime({
              // 2026-10-18：网关"自重启"= 退出等外部拉起（飞书接入会触发）⇒ 必须监督重启。
              superviseGateway: true,
              onGatewayRestarted: () => reconnectGateway(LOCAL_GATEWAY_ID),
              userDataDir: app.getPath('userData'),
              runtimeCacheUserDataDir,
              stateCacheUserDataDir: app.getPath('userData'),
              legacyStateUserDataDir: portableAppData.target ? localUserDataDir : undefined,
              // 便携版主助手必须和用户文件一起留在已验证的盘上工作区；否则 OpenClaw
              // 会把 `main` 默认到本机 state/workspace，生成物与“记住你”的文件就会
              // 悄悄落进 C 盘。非 NTFS 盘已在工作区启动门禁被诚实拒绝。
              portableWorkspacePath,
              onDeployProgress: handleDeployProgress,
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
      };

      /**
       * 「重新准备」重试时用的盘上工作区路径。
       *
       * ⚠️ 工作区准备在 `whenReady` 链里才做（这里是占位）；重试**不重跑工作区准备** ——
       *    那件事已经做完了，重跑等于把用户拖回一次选盘/自愈。
       */
      let retryPortableWorkspacePath: string | undefined;

      /**
       * 能力边界注入（BUG-043）：把"已知能力清单 + 暂不支持时怎么回答"写进 main 助手的
       * `AGENTS.md`（运行时每轮全文注入的提示词通道；**子代理会话只注入它**，见
       * `capability-boundary-prompt.ts` 的头注释）。
       *
       * **刻意不 await、永不抛**：注入失败只影响"模型答得漂不漂亮"，绝不能挡住窗口/工作区
       *（首跑那 1–3 分钟里网关 RPC 本来就不可靠）；失败只留一条日志，下次启动再补。
       * 首跑被 `portable-state-migration-blocked` 挡下时**不注入**（连接都没建）——
       * 用户点「重新准备」成功那条路会再调一次这个函数（见下面的重试 IPC）。
       */
      const kickCapabilityBoundaryInjection = (): void => {
        const client = getGatewayClient(LOCAL_GATEWAY_ID);
        if (!client) return;
        void ensureCapabilityBoundaryPromptWithRetry(client, {
          sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
          delaysMs: [5000, 15000, 30000],
        })
          .then((outcome) => {
            getDebugLogger().info({
              domain: 'gateway',
              event: 'capability.boundary',
              data: { ...outcome },
            });
          })
          .catch(() => {});
      };

      /**
       * 记忆注入（2026-10-16）：①把「记忆草案」契约写进 main 的 `AGENTS.md`（助手才知道
       * 怎么提草案）；②把**当前账号**已确认的记忆投影进盘上每个助手的 `MEMORY.md`
       * （运行时每轮全文注入的召回通道）。
       *
       * ⚠️ 与能力边界同样的姿态：**不 await、永不抛**。启动这一刻网关可能还没连上
       *（首跑那 1–3 分钟里 RPC 本来就不可靠）—— 所以这一跳**必须自己退避重试**：
       *  2026-10-17 实机取证，三次冷启动（盘符 S→U→V）全部在 `agents.list` 上
       *  撞 `GATEWAY_NOT_CONNECTED` ⇒ `list-failed`，而它当时**没有重试**，
       *  等于每次冷启动记忆都没投影进 `MEMORY.md`。见 `memory/sync.ts` 的
       *  `syncMemoryToAgentsWithRetry`（只重试"没连上"；库不可用/名单为空立刻收手）。
       * ⚠️ 投影**按当前账号过滤**：换账号后这次跑的是新账号那批 ——
       *    上一账号的记忆不会通过提示词泄给下一账号。
       */
      const kickMemoryInjection = (): void => {
        const client = getGatewayClient(LOCAL_GATEWAY_ID);
        if (!client) return;
        void ensureMemoryContractPromptWithRetry(client, {
          sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
          delaysMs: [5000, 15000, 30000],
        })
          .then((outcome) => {
            getDebugLogger().info({ domain: 'memory', event: 'memory.contract', data: { ...outcome } });
          })
          .catch(() => {});
        void syncMemoryToAgentsWithRetry(client, {
          sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        })
          .then((outcome) => {
            getDebugLogger().info({
              domain: 'memory',
              event: 'memory.startup-sync',
              data: outcome.ok
                ? {
                    agents: outcome.agentIds.length,
                    entries: outcome.entries.length,
                    written: outcome.result.written.length,
                    unchanged: outcome.result.unchanged.length,
                    failed: outcome.result.failed.length,
                  }
                : { ...outcome },
            });
          })
          .catch(() => {});
      };

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
          registerMemoryHandlers();
          // ⭐ V4（I 接线）：有界执行历史 —— 写入 fire-and-forget（不阻塞渲染层）、
          //    恢复读取按当前工作区隔离（换盘/换 userData 即换目录）。
          ipcMain.on('execution-history:append', (_event, sessionKey: unknown, records: unknown) => {
            if (typeof sessionKey !== 'string' || !sessionKey) return;
            if (!Array.isArray(records) || records.length === 0) return;
            getExecutionHistory().append(sessionKey, records as ExecutionEvent[]);
          });
          ipcMain.handle('execution-history:read-run', (_event, sessionKey: unknown, runId: unknown) => {
            if (typeof sessionKey !== 'string' || typeof runId !== 'string') return null;
            return getExecutionHistory().readRun(sessionKey, runId);
          });
          ipcMain.handle('execution-history:list-runs', (_event, sessionKey: unknown) => {
            if (typeof sessionKey !== 'string') return [];
            return getExecutionHistory().listRuns(sessionKey);
          });
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
          registerOpeningMediaProtocol({
            isPackaged: app.isPackaged,
            resourcesPath: process.resourcesPath,
            appPath: app.getAppPath(),
          });
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
          // ⭐ M3（BUG-034）：画像保存成功后的 DOMStorage 落盘请求。
          //    sender 定 session、渲染层无参；`requested` 仅为"已请求"，非物理落盘确认。
          registerProfileStorageHandlers();

          // 诊断与修复（FEAT-03）——「设置 → 诊断与修复」这一条入口。
          //
          // ⚠️ 与 `--repair` 独立窗口**共用一个引擎**（`main/repair/*` 单真源），差别只在
          //    窗口与生命周期。这条路径下 session 挂在**正在跑的应用**上，所以引擎的
          //    "本机有一份在跑"活锁判据天然成立 ⇒ 会改文件的动作全部 skipped，
          //    只放行诊断包。这正是要的：应用开着时不该并发改自己的配置。
          // ⚠️ `resolveRepairHost` / 建 session 都是**只读**的（不建目录、不写盘）。
          // ⚠️ 语言用 `readPersistedLanguage()` 而不是 `readConfig()`：后者在配置损坏时会
          //    当场改名隔离 —— 那是一次没经确认的写动作，不该由"打开设置页"触发。
          const repairHost = resolveRepairHost({
            userDataDir: app.getPath('userData'),
            isPackaged: app.isPackaged,
            resourcesPath: process.resourcesPath ?? null,
            appVersion: app.getVersion(),
          });
          registerRepairHandlers({
            session: createSessionForHost(repairHost),
            host: repairHost,
            language: readPersistedLanguage(repairHost.targets.dataRoot),
          });

          // 「连接器」——飞书接入（2026-10-17）。状态只报盘上可确认的事实。
          // ⚠️ 运行时部署根与 userData 在便携形态下不同（`portable-runtime-cache`）：
          //    不传 `runtimeCacheUserDataDir`，盘（F:/U 盘）上的连接器会一直判
          //    「运行时不可用」并禁用飞书接入（2026-10-18 同事实机）。
          registerConnectorHandlers({
            userDataDir: app.getPath('userData'),
            runtimeCacheUserDataDir,
            // 随包 npm 负载（npm.cmd + node_modules/npm + npm-cache）：首次接入飞书时
            // 惰性复制到已部署的 node 目录，用于生成内核认可的**可信安装记录**。
            runtimeNodePayloadDir: app.isPackaged
              ? join(process.resourcesPath, 'runtime', 'node')
              : join(app.getAppPath(), '..', '..', 'runtime-out', 'node'),
            // 便携分裂态的真实 state 是 `<…>/state/<token 哈希>`，只有 runtime 层知道。
            // 惰性读取：注册时启动链还没跑，值必须等到用户真的打开连接器时再解析。
            // 解析不到（启动早期/失败）⇒ 连接器按"运行时未就绪"处理，不往推测目录写东西。
            stateDir: () => getActiveLocalGatewayStateDir() ?? process.env.OPENCLAW_STATE_DIR?.trim() ?? null,
          });
          // 桌面宠物（2026-10-17）：看桌面 / 整理 / 删除（删除走回收站 + 确认框）。
          registerPetHandlers();
          // 视频画质档位（标准 / 豆包 Seedance 2.5 高质量）。
          registerVideoQualityHandlers();

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

          /**
           * 部署进度的**初始读**（渲染层挂载时补读一次）。
           *
           * ⚠️ 与 `runtime:bootstrap-status` 同一个理由：部署在窗口建好**之前**就跑，
           *    那之前的推送没人收。`null` = 现在没有部署在进行（**不是**"部署完成"）。
           */
          ipcMain.handle('runtime:deploy-progress', () => getDeployProgress());

          /**
           * 「重新准备」—— 用户在准备页 / 就绪面板上点的重试。
           *
           * ⭐ 这条通道存在的理由（2026-10-07 体检）：运行时**起不来**时原来那个重试
           *    只是重新初始化连接层 —— 在同一个"起不来"上再转一圈，什么都不会变，
           *    用户唯一的出路是**完全退出应用重开**。这里让它和启动走**同一条路**
           *    （重跑一轮 bootstrap：定位 → 部署 → 起网关 → 等就绪）。
           *
           * ⚠️ 单飞：连点两下不许并发跑两轮（两轮会同时往同一个 tmp 目录里解压、
           *    抢同一个原子 rename 的目标）。
           * ⚠️ 结束时与启动路径一样推 `runtime-status`：渲染层据此把"起不来"那条
           *    结论换掉（成功换成就绪，失败换成新的那一类）。
           */
          let runtimeRetryInFlight = false;
          ipcMain.handle('runtime:bootstrap-retry', async () => {
            if (runtimeRetryInFlight) return getRuntimeBootstrapStatus();
            runtimeRetryInFlight = true;
            try {
              const result = await runRuntimeBootstrap(retryPortableWorkspacePath);
              finishDeployProgress();
              publishRuntimeBootstrapStatus(result);
              sendToWindow(getMainWindow(), 'runtime-status', getRuntimeBootstrapStatus());
              // 网关是**这一次**才起来的（首跑被 migration-blocked 挡下、用户点重试）⇒
              // 补一次能力边界注入（同一条 fire-and-forget，失败不挡任何东西）。
              if (result.ok) {
                // ⭐ BUG-064 D：本机运行时是被「重新准备」救回来的 —— 把因
                //   `gateway.reconnect.suppressed-runtime-down` 停下的本地网关**显式**
                //   唤醒（快照此刻已是 ok，重连照常走；只唤醒本机这一个网关）。
                reconnectGateway(LOCAL_GATEWAY_ID);
                kickCapabilityBoundaryInjection();
                kickMemoryInjection();
              }
              return getRuntimeBootstrapStatus();
            } finally {
              runtimeRetryInFlight = false;
            }
          });

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
          // 盘上运行才带：重试（IPC `runtime:bootstrap-retry`）**不重跑工作区准备**，
          // 直接用这一轮已经验证过的那个工作区 —— 重跑等于把用户拖回一次选盘/自愈。
          retryPortableWorkspacePath = workspace.portable ? wsPath : undefined;

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

          // ⚠️ 托盘必须**紧跟开窗**建起来（2026-10-07 体检）：窗口的 `close` 一律拦下来
          //    改成隐藏（`win.on('close')`），而托盘原来是 bootstrap **之后**才建 ——
          //    首跑那 1–20 分钟里点 X = 窗口没了、托盘还没有 = 用户眼里"程序消失了"，
          //    只能去任务管理器杀进程。托盘先立起来，关窗就是老老实实收进托盘。
          //    （它只读 config 建一个图标，不依赖网关，也不挡任何东西。）
          initTray();

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
          const runtimeResult = await runRuntimeBootstrap(retryPortableWorkspacePath);
          finishDeployProgress();
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

          // 飞书安装记录启动自愈（BUG-175，2026-10-19）：插件在、但**可信安装记录没了**
          // （换盘符后 installPath 失效 / 1.0.9 的目录复制从来就没记录）⇒ 用随包 npm
          // 重装一次，通道才能重新收消息。只在真有问题时动手，每进程最多一次。
          // ⚠️ 放在 `initAllGateways()` 那一行**之后**是刻意的：那一行是
          //    `test/runtime-main-publication.test.ts` 切片的终点，自愈不能进切片。
          if (runtimeResult.code !== PORTABLE_STATE_MIGRATION_BLOCKED) {
            /**
             * 为什么是"退避重试"而不是一次 10s（2026-10-19 自审）：
             * 全新盘/清缓存盘首次启动的运行时部署实测要 **149s**，而这里 10s 就会触发。
             * 自愈在运行时未就绪时返回 `deferred`（不消耗"每进程一次"的门闩），
             * 由这里按 10/30/60/120/180s 继续等 —— 累计 400s，跨得过首次部署与它的重试。
             */
            const repairDelaysMs = [10_000, 30_000, 60_000, 120_000, 180_000];
            const runFeishuInstallRepair = (attempt: number): void => {
              if (attempt >= repairDelaysMs.length) return;
              setTimeout(() => {
                void repairFeishuInstallOnStartup({
                  stateDir: getActiveLocalGatewayStateDir() ?? process.env.OPENCLAW_STATE_DIR?.trim() ?? null,
                  deploymentDir: runtimeCacheUserDataDir,
                  runtimeNodePayloadDir: app.isPackaged
                    ? join(process.resourcesPath, 'runtime', 'node')
                    : join(app.getAppPath(), '..', '..', 'runtime-out', 'node'),
                  bundledPluginDir: app.isPackaged
                    ? join(process.resourcesPath, 'connectors', 'feishu')
                    : join(app.getAppPath(), 'resources', 'connectors', 'feishu'),
                  log: (event, detail) => {
                    // 2026-10-19 现场：这行原来只进 stdout，打包后**看不到** ——
                    // 用户只看到"插件缺少可信安装记录"，我们无法判断自愈是没跑、
                    // 跑了失败、还是被跳过。现在同时进主进程日志（next run 可取证）。
                    getDebugLogger().info({ domain: 'connector', event, data: detail ?? {} });
                    console.log(`[connectors] ${event}`, detail ?? '');
                  },
                })
                  .then((result) => {
                    getDebugLogger().info({
                      domain: 'connector',
                      event: 'connectors.feishu-install.repair-result',
                      data: { result, attempt },
                    });
                    if (result === 'deferred') runFeishuInstallRepair(attempt + 1);
                  })
                  .catch(() => {
                    /* 自愈失败不影响启动；界面按“通道未就绪”如实提示 */
                  });
              }, repairDelaysMs[attempt]);
            };
            runFeishuInstallRepair(0);
          }

          // 能力边界注入（BUG-043）：网关刚起来、连接刚建好，这是本进程里第一个"能调网关 RPC"的点。
          kickCapabilityBoundaryInjection();
          // 记忆注入（2026-10-16）：同一时刻 —— 契约写 `AGENTS.md`、已确认记忆投影 `MEMORY.md`。
          kickMemoryInjection();

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

  // ⭐ V4（I 接线）：执行历史 writer 停表收尾（不阻塞退出 —— close 内部按 writer 纪律吞错）。
  stopExecutionHistory();

  // ⭐ M3（BUG-034）：退出前对存活窗口 session 尽力请求 DOMStorage 落盘。
  //    细节收敛在 `profile-storage-handlers.requestQuitStorageFlush()`（单一具名参与者，
  //    绝不抛、不阻塞退出——Electron 34 flushStorageData 是 void，只代表"已发起请求"；
  //    强关/断电无保证，口径见 BUG-034）。
  requestQuitStorageFlush();

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
