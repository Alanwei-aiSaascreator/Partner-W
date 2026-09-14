import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  ARTIFACTS,
  cleanupProfiles,
  connect,
  ensureArtifacts,
  freshUserData,
  launchApp,
  stopEverything,
  waitForGateway,
  waitForRelayModels,
  type LaunchedApp,
} from './harness.js';
import { sweepStaleProfiles } from '../helpers/temp-root.js';
import { readDevProvision, provisionProfile } from './provision.js';

/**
 * `syncSessions` 的**端到端**回归：真实会话在网关存在且跑完一次真实往返后，
 * 客户端必须能把它发现回来。
 *
 * ## 为什么需要这一条（而单测不够）
 *
 * 2026-09-14 查实：`chat.history` 的 `content` 是**多态的**（`user` 是字符串、
 * `assistant` 是块数组），而 handler 只按块数组处理 ⇒ 撞上字符串抛
 * `filter is not a function`；更糟的是那条语句与 `sessions.list` 共用一个 `try`，
 * 于是**一条会话出错就把整个网关清零**，表现成 `discovered=0` **且到处都不报错**
 * （`ok:true` 却什么也没导入）。
 *
 * ⇒ 只有把「真网关 + 真消息往返 + 真 syncSessions」串起来才测得到；
 *   内容形状本身的各种边角（string / 块数组 / null / 未知形状 / 一坏一好隔离）
 *   已由 `packages/desktop/test/sync-sessions-content.test.ts` 钉死，**这里不重复**。
 *
 * ## 隔离纪律
 *
 * - **fresh isolated profile**（`freshUserData`）—— 不碰开发机的真实 profile
 * - **本 run 独占 workspace** —— 共享 workspace 会带上一次跑的任务，
 *   曾把「正向样本没建起来」误读成 bug（本地任务表 14 条脏数据）
 * - 网关由 **packaged App 自己** spawn（不预占 18789、不起 foreign gateway）
 * - 收摊一律走 junction-safe 清理
 *
 * ## 隐私
 *
 * 只发一条固定的合成文本。**不打印**消息正文、token、phone/OTP、licenseKey、会话 metadata。
 */

const provision = readDevProvision();
const CDP = 9404;
const WORKSPACE = path.join(ARTIFACTS, `e2e-workspace-discovery-${process.pid}-${Date.now().toString(36)}`);
/** 固定合成文本，无敏感内容。 */
const PROMPT = '你好';

let app: LaunchedApp | null = null;
let currentUserData = '';

interface LogEvent {
  ts: string;
  event: string;
  data?: Record<string, unknown>;
}

function readLogEvents(userDataDir: string): LogEvent[] {
  const dir = path.join(userDataDir, 'logs');
  if (!fs.existsSync(dir)) return [];
  const out: LogEvent[] = [];
  for (const file of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ndjson'))
    .sort()) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line) as LogEvent;
        if (d.ts && d.event) out.push(d);
      } catch {
        /* 半行/坏行跳过 */
      }
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

async function callIpc<T>(page: Page, fn: string, args: unknown[]): Promise<T> {
  return (await page.evaluate(
    async ({ fn: name, args: a }) => {
      const api = (window as unknown as { clawwork: Record<string, (...xs: unknown[]) => Promise<unknown>> }).clawwork;
      return await api[name]!(...a);
    },
    { fn, args },
  )) as T;
}

interface GwSession {
  key?: string;
  status?: string;
  outputTokens?: number;
}

test.describe.configure({ mode: 'serial' });

test('session discovery：真实往返过的会话必须能被 syncSessions 找回', async () => {
  test.setTimeout(30 * 60_000);
  test.skip(!provision, '开发机上没有可搬运的商业身份（%APPDATA%\\@clawwork\\desktop）');

  ensureArtifacts();
  const swept = sweepStaleProfiles({ log: (m) => console.log(m) });
  if (swept.removed.length > 0) console.log(`[e2e-clean] 启动清扫：删了 ${swept.removed.length} 个旧 profile`);
  fs.mkdirSync(WORKSPACE, { recursive: true });

  const userDataDir = freshUserData('discovery');
  currentUserData = userDataDir;
  // 带会话启动：需要 relay 真的能用，才能完成一次真实往返
  provisionProfile(userDataDir, provision!, { workspacePath: WORKSPACE });

  try {
    app = launchApp(userDataDir, CDP);
    expect(await waitForGateway(), '网关没起来').toBe(true);
    const { browser, page } = await connect(CDP);

    try {
      // ---------- 1. relay 可用（否则消息发不出去，正向样本无从谈起）
      const models = await waitForRelayModels(page, 1, 240_000);
      expect(models.relay.length, 'relay 模型为空 ⇒ 造不出真实往返样本').toBeGreaterThan(0);

      // ---------- 2. 新建任务 + 发一条真实消息
      await page.locator('button[aria-label="新任务"]').click({ timeout: 30_000 });
      const composer = page.locator('textarea').first();
      await composer.waitFor({ state: 'visible', timeout: 30_000 });
      await composer.fill(PROMPT);
      const send = page.getByRole('button', { name: '发送', exact: true });
      // 发送键在 canSend 为假时是 disabled 的 —— 直接点会静默什么都不做
      await expect(send, '输入了内容发送键却不可点').toBeEnabled({ timeout: 15_000 });
      await send.click({ timeout: 15_000 });

      // ---------- 3. 精确定位**本次**目标会话（不依赖 rows[0] 恰好是它）
      const loaded = await callIpc<{ rows?: Array<{ id: string; sessionKey: string }> }>(page, 'loadTasks', []);
      const rows = loaded.rows ?? [];
      // 独占 workspace 自检：本 run 之前这里应该是空的 ⇒ 只可能有一条
      expect(rows.length, `本 run 的 workspace 不干净：任务表已有 ${rows.length} 条`).toBe(1);
      const target = rows[0];
      expect(target?.sessionKey, '本地任务表里没有刚建的任务').toBeTruthy();
      const targetKey = target!.sessionKey;

      // ---------- 4. 正向控制：网关里确实有它、属于当前 deviceId、且真的往返过
      const cfg = JSON.parse(fs.readFileSync(path.join(userDataDir, 'clawwork-config.json'), 'utf-8')) as {
        deviceId?: string;
      };
      const deviceId = cfg.deviceId ?? '';
      expect(deviceId, 'profile 里没有 deviceId').toBeTruthy();

      const deadline = Date.now() + 180_000;
      let gwSession: GwSession | undefined;
      for (;;) {
        const res = await callIpc<{ result?: { sessions?: GwSession[] } }>(page, 'listSessions', ['local-runtime']);
        gwSession = (res.result?.sessions ?? []).find((s) => s.key === targetKey);
        if (gwSession && gwSession.status === 'done' && (gwSession.outputTokens ?? 0) > 0) break;
        if (Date.now() >= deadline) break;
        await page.waitForTimeout(5000);
      }
      expect(gwSession, '网关侧找不到本次会话 ⇒ 正向控制不成立').toBeTruthy();
      expect(gwSession!.outputTokens ?? 0, '本次会话没有产出 token ⇒ 没有真实往返').toBeGreaterThan(0);
      // session key 带设备段，且段值就是本 profile 的 deviceId
      const seg = targetKey.match(/^agent:([^:]+):clawwork:([^:]+):task:(.+)$/);
      expect(seg, '会话键不是"带设备段"的形状').not.toBeNull();
      expect(seg![2], '会话键里的 deviceId 与本 profile 不一致').toBe(deviceId);

      // ---------- 5. 被测行为：syncSessions 必须能发现它
      const sync = await callIpc<{ ok: boolean; discovered?: Array<{ sessionKey?: string; messages?: unknown[] }> }>(
        page,
        'syncSessions',
        [],
      );
      expect(sync.ok, 'syncSessions 失败').toBe(true);
      const discovered = sync.discovered ?? [];
      const found = discovered.find((d) => d.sessionKey === targetKey);
      expect(found, 'syncSessions 没有发现这次真实往返过的会话（discovered=0 回归）').toBeTruthy();
      expect(found!.messages?.length ?? 0, '发现回来了但没有消息').toBeGreaterThan(0);

      // ---------- 6. 本地可见状态里也找得到它
      const after = await callIpc<{ rows?: Array<{ id: string; sessionKey: string }> }>(page, 'loadTasks', []);
      expect(
        (after.rows ?? []).some((r) => r.sessionKey === targetKey),
        '最终本地任务表里找不到目标会话',
      ).toBe(true);

      // ---------- 7. 目标会话不得出现 dropped / gateway-failed
      const events = readLogEvents(userDataDir);
      const droppedForTarget = events.filter(
        (e) =>
          e.event === 'renderer.session.dropped.missing_session' && JSON.stringify(e.data ?? {}).includes(targetKey),
      );
      expect(droppedForTarget, '目标会话被 renderer 判成 missing_session').toHaveLength(0);
      const gatewayFailed = events.filter((e) => e.event === 'ipc.ws.sync-sessions.gateway-failed');
      expect(gatewayFailed, '本次出现了 gateway 级 sync 失败').toHaveLength(0);

      console.log(
        `\n[discovery] ✅ 目标会话被发现：gateway sessions=${(await callIpc<{ result?: { sessions?: GwSession[] } }>(page, 'listSessions', ['local-runtime'])).result?.sessions?.length ?? 0}` +
          `，discovered=${discovered.length}，目标命中=yes，missing_session=0，gateway-failed=0`,
      );
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    await stopEverything(app, currentUserData);
    const res = cleanupProfiles();
    console.log(`[e2e-clean] ${res.reason}：删了 ${res.removed.length} 个，留了 ${res.kept.length} 个`);
  }
});
