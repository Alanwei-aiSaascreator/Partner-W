import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { GATEWAY_ID, GATEWAY_WS_URL, GATEWAY_TOKEN } from './constants';
import { freshProfile, safeRemoveTree } from './temp-root';

const CONFIG_FILE_NAME = 'clawwork-config.json';
const DESKTOP_PKG = path.resolve(__dirname, '../../packages/desktop');
const APP_ENTRY = path.join(DESKTOP_PKG, 'out/main/index.js');

function resolveElectronBinary(): string {
  const electronMain = require.resolve('electron', { paths: [DESKTOP_PKG] });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electronBin = require(electronMain) as unknown as string;
  return electronBin;
}

interface LaunchResult {
  app: ElectronApplication;
  page: Page;
  cleanup: () => void;
  userDataDir: string;
  workspaceDir: string;
}

function dumpDiagnostics(electronBin: string): void {
  console.log('[e2e-diag] APP_ENTRY:', APP_ENTRY, 'exists:', fs.existsSync(APP_ENTRY));
  console.log('[e2e-diag] electron binary:', electronBin, 'exists:', fs.existsSync(electronBin));
  console.log('[e2e-diag] platform:', process.platform, 'arch:', process.arch);
  console.log('[e2e-diag] CI:', process.env.CI ?? 'false');
  console.log('[e2e-diag] DISPLAY:', process.env.DISPLAY ?? 'unset');

  const outDir = path.join(DESKTOP_PKG, 'out');
  if (fs.existsSync(outDir)) {
    const files = fs.readdirSync(outDir, { recursive: true }) as string[];
    console.log('[e2e-diag] out/ files:', files.slice(0, 20).join(', '));
  } else {
    console.log('[e2e-diag] out/ directory DOES NOT EXIST');
  }
}

export async function launchApp(options?: {
  gateway?: boolean;
  userDataDir?: string;
  workspaceDir?: string;
}): Promise<LaunchResult> {
  const electronBin = resolveElectronBinary();
  dumpDiagnostics(electronBin);

  // ⚠️ 落在**统一临时根**下（见 temp-root.ts）：不再直接堆 `%TEMP%`（在 C 盘上）。
  const userDataDir = options?.userDataDir ?? freshProfile('e2e-userdata');
  const workspaceDir = options?.workspaceDir ?? freshProfile('e2e-ws');

  const config: Record<string, unknown> = {
    workspacePath: workspaceDir,
    trayEnabled: false,
    quickLaunch: {
      enabled: false,
      shortcut: 'Alt+Space',
    },
    gateways: options?.gateway
      ? [
          {
            id: GATEWAY_ID,
            name: 'E2E Test Gateway',
            url: GATEWAY_WS_URL,
            token: GATEWAY_TOKEN,
            isDefault: true,
          },
        ]
      : [],
    defaultGatewayId: options?.gateway ? GATEWAY_ID : undefined,
  };

  fs.writeFileSync(path.join(userDataDir, CONFIG_FILE_NAME), JSON.stringify(config, null, 2));

  const launchArgs = [APP_ENTRY, `--user-data-dir=${userDataDir}`];
  if (process.env.CI) {
    launchArgs.push('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');
  }

  console.log('[e2e-diag] launch args:', launchArgs);

  let app: ElectronApplication;
  try {
    app = await electron.launch({
      executablePath: electronBin,
      args: launchArgs,
      env: { ...process.env, NODE_ENV: 'test', ELECTRON_DISABLE_SANDBOX: '1' },
    });
  } catch (err) {
    console.error('[e2e-diag] electron.launch() FAILED:', err);
    throw err;
  }

  console.log('[e2e-diag] electron launched, pid:', app.process().pid);

  app.process().stderr?.on('data', (chunk: Buffer) => {
    console.log('[electron-stderr]', chunk.toString().trimEnd());
  });

  const page = await app.firstWindow();
  console.log('[e2e-diag] first window obtained, url:', page.url());

  // ⚠️ **不要**用 `fs.rmSync(..., {recursive:true})`：profile 里可能有目录 junction，
  //    是否跟随不由我们决定。`safeRemoveTree` 只认 lstat，遇到链接只摘链接本身。
  //    （项目里真的发生过：`rm -rf` 跟进 junction 删掉了真实 `node_modules/openclaw`。）
  const cleanup = (): void => {
    for (const dir of [userDataDir, workspaceDir]) {
      try {
        safeRemoveTree(dir);
      } catch {
        // best-effort
      }
    }
  };

  return { app, page, cleanup, userDataDir, workspaceDir };
}
