/**
 * `Partner-W.exe --repair` 的**修复模式**（SPEC 一·形态）。
 *
 * 与正常启动的差别（全部是刻意的）：
 *
 * | 正常启动 | 修复模式 |
 * |---|---|
 * | 抢单实例锁，抢不到就退 | **不抢**（要能在"已经有一份在跑"时打开并告诉用户先退出） |
 * | 起本机网关、占 18789 | **一步都不做** |
 * | 工作区准备 / 数据库 / 迁移 | **不做**（修复工具要在这些坏掉时也能跑） |
 * | 埋点 / 托盘 / 快捷键 / 自动更新 | 不做 |
 * | 1280×800 主窗口 | 小窗口单页（修复面板） |
 *
 * ⚠️ **不 import `../index.js`**：那条链会把网关、数据库、商业通道全拉起来 ——
 *    正是 SPEC 一「不启动网关、不走正常首启链」要排除的东西。
 */

import { app, BrowserWindow, dialog, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';
import { installNavigationGuards } from '../security/navigation-guard.js';
import { applyPortableAppData } from '../runtime/portable-app-data.js';
import { createSessionForHost, readPersistedLanguage, resolveRepairHost } from './host.js';
import { resolveRepairDataRoot } from './targets.js';
import { registerRepairHandlers } from '../ipc/repair-handlers.js';

// 与主程序同款的可选 CDP 端点（`CLAUDEW_DEBUG_PORT=9222`）。默认关闭，
// 打包态不受影响 —— 修复模式排障时"看不到界面上到底出了什么"是最难的一环。
// ⚠️ 必须在 `app.ready` 之前 append（模块顶层，不是 `runRepairMode` 里面）。
if (process.env.CLAUDEW_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.CLAUDEW_DEBUG_PORT);
}

function createRepairWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 940,
    height: 720,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Partner-W 修复工具',
    autoHideMenuBar: true,
    backgroundColor: '#FAFAFA',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.on('ready-to-show', () => win.show());

  // 与主窗口同一条导航纪律：只许应用自己的页面；外链交给系统浏览器
  installNavigationGuards(win.webContents, {
    devOrigin: is.dev ? (process.env['ELECTRON_RENDERER_URL'] ?? null) : null,
    appRendererDir: join(import.meta.dirname, '../renderer'),
  });

  win.webContents.setWindowOpenHandler((details) => {
    try {
      const parsed = new URL(details.url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') void shell.openExternal(details.url);
    } catch {
      // 不是 URL 就算了
    }
    return { action: 'deny' };
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/repair.html`);
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/repair.html'));
  }
  return win;
}

/**
 * 盘上形态的应用数据重定向（修复模式也认盘）。
 *
 * ⚠️ 失败**不退出**：正常启动会因为"数据目录建不出来"直接告诉用户并退出，
 *    而修复工具恰恰要在这种状态下能跑起来 —— 退不了盘就把结论如实写在面板上。
 *    所以这里只吞掉失败，用当前的 userData 继续。
 */
function redirectAppDataIfPortable(): { target: string | null } {
  try {
    // 判定+重定向都在它里面（`setPath('userData'|'sessionData'|'logs')`）；
    // `failed` 在这里**不当致命**用 —— 见上面那段说明。
    return applyPortableAppData({
      app,
      exePath: process.execPath,
      isPackaged: app.isPackaged,
      systemDrive: process.env.SystemDrive ?? null,
      resourcesPath: process.resourcesPath,
      exists: existsSync,
      // 惰性枚举**不启用**：修复工具不花几秒去问系统"哪些盘可移动"
      removableDrives: () => [],
    });
  } catch {
    // 见上：修复工具不能因为这一步失败就打不开
    return { target: null };
  }
}

/** 修复模式的完整生命周期。**永不抛**（入口处 `.catch` 会兜住，这里尽量不走到）。 */
export async function runRepairMode(): Promise<void> {
  // ⚠️ **必须在 setName 之前取**：`userData` 默认 = appData / 当前应用名。
  //    setName 之后拿到的是修复工具自己的 Chromium 目录；正常应用的运行数据
  //    （`openclaw-state` 所在）在**产品名**那份下面 —— 两者不是同一个目录。
  //    实测（2026-10-18 打包态冒烟）：正常应用 = `%APPDATA%\@clawwork`，
  //    修复工具 = `%APPDATA%\Partner-W 修复工具`；用错根 ⇒ 永远"没有找到状态目录"。
  const installedUserDataDir = app.getPath('userData');
  app.setName('Partner-W 修复工具');

  await app.whenReady();

  const portable = redirectAppDataIfPortable();

  const host = resolveRepairHost({
    userDataDir: resolveRepairDataRoot({
      portableTarget: portable.target,
      installedUserDataDir,
    }),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath ?? null,
    appVersion: app.getVersion(),
  });

  const session = createSessionForHost(host);
  registerRepairHandlers({ session, host, language: readPersistedLanguage(host.targets.dataRoot) });

  createRepairWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createRepairWindow();
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

/** 给入口用的"打不开也要说一句"的兜底。 */
export function reportRepairModeFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  try {
    dialog.showErrorBox('修复工具打不开', `修复工具启动时出错：${message}\n\n请把这句话连同诊断包一起发给客服。`);
  } catch {
    // 连对话框都弹不出来就只能退出了
  }
}
