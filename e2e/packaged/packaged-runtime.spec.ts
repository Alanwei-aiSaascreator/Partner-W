import { chromium, expect, test } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 阶段 1 的**打包态**验收 —— dev E2E 不能代替它。
 *
 * 证的是整条链，每一步都是真的（真 exe、真解压、真 spawn、真端口）：
 *
 *   启动打包好的 app
 *   → 找运行时（`CLAWWORK_RUNTIME_DIR` 指向真实的 runtime-out）
 *   → 部署 Node + OpenClaw 进**隔离的** userData
 *   → 从 `deployed/<key>/node/node.exe` 起网关
 *   → /startupz = started
 *   → 客户端连上 local-runtime
 *   → UI 真的出现 Agent / 会话
 *
 * ⚠️ 几个刻意的选择：
 *   - **userData 隔离用 Electron 原生的 `--user-data-dir`**，不是
 *     `CLAWWORK_USER_DATA_DIR` —— 后者在 `isPackaged` 时被**刻意关掉**
 *     （正式版不接受环境变量改数据目录，见 `user-data-override.ts`）。
 *   - **host 不依赖合格 Node**：Electron 34.5.8 内嵌的是 Node 20.19.1，而
 *     openclaw 要求 >=24.16.0 —— 所以网关**只能**跑在部署进来的那个 node 上。
 *     这一点用进程表直接验（`ExecutablePath` 必须是 userData 里那一个）。
 *   - 不预置任何网关配置：那条 `local-runtime` 条目必须是**客户端自己**建的。
 *
 * 跑法（先 `pnpm --filter @clawwork/desktop build && npx electron-builder --win --dir`）：
 *   pnpm test:e2e:packaged
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const APP_EXE = path.join(REPO_ROOT, 'packages/desktop/dist/win-unpacked/魔方罗盘.exe');
const RUNTIME_OUT = path.join(REPO_ROOT, 'runtime-out');
const ARTIFACTS = path.join(REPO_ROOT, 'packages/desktop/e2e-artifacts');
const GATEWAY_PORT = 18789;
const CDP_PORT = 9333;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function portHasGateway(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/startupz`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 进程表里所有 node.exe 的 (pid, 可执行文件路径)。用来证明"跑的是哪一个"。 */
function nodeProcesses(): Array<{ pid: number; exe: string }> {
  const ps = [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`,
  ];
  try {
    const out = execFileSync('powershell', ps, { encoding: 'utf-8', timeout: 30_000, windowsHide: true });
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf('|');
        return { pid: Number(line.slice(0, idx)), exe: line.slice(idx + 1) };
      })
      .filter((p) => Number.isFinite(p.pid) && p.exe);
  } catch {
    return [];
  }
}

test.describe('打包态：客户端自己把运行时拉起来', () => {
  test.setTimeout(20 * 60_000);

  let userDataDir = '';
  let app: ChildProcess | null = null;

  test.beforeAll(async () => {
    expect(fs.existsSync(APP_EXE), `打包产物不在：${APP_EXE}（先 build + electron-builder --dir）`).toBe(true);
    expect(fs.existsSync(RUNTIME_OUT), `运行时源不在：${RUNTIME_OUT}`).toBe(true);

    // 端口必须是 DOWN 的 —— 否则"客户端自己拉起来的"这句话就不成立
    expect(await portHasGateway(GATEWAY_PORT), `端口 ${GATEWAY_PORT} 上已经有网关在跑，先停掉`).toBe(false);

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-packaged-'));
    fs.mkdirSync(ARTIFACTS, { recursive: true });
  });

  test.afterAll(async () => {
    // ⚠️ 收 app **整棵进程树**：网关是它的子进程，留着会占端口影响下一次跑
    if (app?.pid) {
      try {
        execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], {
          timeout: 15_000,
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        /* 已经退出了 */
      }
    }
  });

  test('打包 app → 部署 → 从 deployed node 起网关 → 客户端连上 → UI 出现 Agent/会话', async () => {
    const exeDir = path.dirname(APP_EXE);
    app = spawn(APP_EXE, [`--user-data-dir=${userDataDir}`, `--remote-debugging-port=${CDP_PORT}`], {
      cwd: exeDir,
      env: {
        ...process.env,
        // 「真实 runtime source」：指到仓库里那份真运行时
        CLAWWORK_RUNTIME_DIR: RUNTIME_OUT,
        // 显式清掉，免得"这台机器恰好有个合格 Node"混进来
        CLAWWORK_NODE: '',
        CLAWWORK_USER_DATA_DIR: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });

    // ① 等网关起来（首次要解压 35k 文件 + 冷启动）
    const deadline = Date.now() + 10 * 60_000;
    let started = false;
    while (Date.now() < deadline) {
      if (await portHasGateway(GATEWAY_PORT)) {
        started = true;
        break;
      }
      await sleep(2000);
    }
    expect(started, '网关没起来（/startupz 一直不通）').toBe(true);

    const startupz = (await (await fetch(`http://127.0.0.1:${GATEWAY_PORT}/startupz`)).json()) as { status?: string };
    expect(startupz.status).toBe('started');

    // ② 部署真的落在**隔离的** userData 里（不是真实 %APPDATA%）
    const deployedRoot = path.join(userDataDir, 'runtime', 'deployed');
    const keys = fs.readdirSync(deployedRoot);
    expect(keys.length).toBe(1);
    const deployDir = path.join(deployedRoot, keys[0]);
    const deployedNode = path.join(deployDir, 'node', 'node.exe');
    expect(fs.existsSync(deployedNode)).toBe(true);
    expect(fs.existsSync(path.join(deployDir, 'node_modules', 'openclaw', 'openclaw.mjs'))).toBe(true);

    // ③ 令牌 store 是 ClawWork 自己的（不是 openclaw 的配置文件）
    expect(fs.existsSync(path.join(userDataDir, 'runtime', 'local-gateway-auth.json'))).toBe(true);

    // ④ ⭐ 跑着的网关用的**就是**部署进来的那个 node
    //    （Electron 自带 Node 20.19.1，openclaw 要求 >=24.16.0 —— 它根本跑不了）
    const nodes = nodeProcesses();
    const gatewayNodes = nodes.filter((p) =>
      p.exe.toLowerCase().startsWith(path.join(userDataDir, 'runtime').toLowerCase()),
    );
    expect(gatewayNodes.length, `没找到跑在 userData 里的 node.exe。实测进程表：${JSON.stringify(nodes)}`).toBe(1);
    expect(gatewayNodes[0].exe.toLowerCase()).toBe(deployedNode.toLowerCase());

    // ⑤ 那条 local-runtime 网关条目必须是**客户端自己**建的
    const cfgPath = path.join(userDataDir, 'clawwork-config.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
      gateways?: Array<{ id?: string; url?: string; token?: string }>;
    };
    const local = cfg.gateways?.find((g) => g.id === 'local-runtime');
    expect(local, '客户端没有建 local-runtime 条目').toBeTruthy();
    expect(local?.url).toBe(`ws://127.0.0.1:${GATEWAY_PORT}`);
    expect((local?.token ?? '').length).toBeGreaterThan(20);
    // 落盘必须是密文（要么 enc: 要么本机 safeStorage 不可用时的明文 —— 这里只要求非空）
    expect(local?.token).not.toContain('undefined');

    // ⑥ UI：真出现 Agent / 会话
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    try {
      const page = browser.contexts().flatMap((c) => c.pages())[0];
      await page.waitForLoadState('domcontentloaded');

      // 网关连上（ConnectionBanner 说真话）
      await expect
        .poll(async () => (await page.locator('body').innerText()).includes('已重连'), { timeout: 60_000 })
        .toBe(true);

      // Agent：展开智能体切换，必须列出网关给的 `main`
      await page.locator('button[aria-label="切换智能体"]').click();
      await expect
        .poll(async () => (await page.locator('body').innerText()).includes('main'), { timeout: 30_000 })
        .toBe(true);
      await page.screenshot({ path: path.join(ARTIFACTS, 'packaged-01-agents.png') });
      await page.keyboard.press('Escape');

      // 会话：新任务面板打得开，且绑在 main 这个 Agent 上。
      // ⚠️ 「描述你的任务…」是 **placeholder** —— 它不在 innerText 里，得按属性找。
      await page.locator('button[aria-label="新任务"]').click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(ARTIFACTS, 'packaged-02-session.png') });
      await expect(page.locator('[placeholder*="描述你的任务"]').first()).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(async () => (await page.locator('body').innerText()).includes('main'), { timeout: 30_000 })
        .toBe(true);
    } finally {
      await browser.close().catch(() => {});
    }
  });
});
