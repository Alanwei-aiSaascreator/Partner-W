import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  connect,
  freshTrackedProfile,
  launchApp,
  markFailure,
  cleanupProfiles,
  stopEverything,
  waitForGateway,
  type LaunchedApp,
} from './harness.js';

/**
 * 消息级 model 徽章 —— **确定性** E2E。
 *
 * 证的是「每条 assistant 消息显示**实际生成它的模型**」这条链的**持久化 + 渲染**：
 *
 *   真实 IPC 写入（`persistMessage`，走真的 data-handlers/upsert）
 *   → 落进真的 sqlite（sqlite3 CLI 直接读，**不是**问应用自己）
 *   → 中途一次**不带 model** 的 upsert（工具调用/推理就是这么写的）
 *   → 重启客户端（同一 profile）
 *   → `hydrateFromLocal` 读回 → UI 上每条各自渲染自己的徽章
 *
 * ## 为什么是确定性的（不需要真模型、不需要商业身份）
 *
 * 它**不调用任何模型**：消息由 IPC 直接写库，模型 id 由用例给定。
 * 所以它不依赖中转目录、不依赖网络、不依赖 provision —— 可以反复跑。
 * 「真的让模型生成、真的切模型」那条在真实模型 E2E 里，两者互补。
 *
 * ## 纪律（与用户点名的语义一致）
 *
 *   - 徽章只认网关逐条给的 `model`；**不**从 picker / 会话默认模型 / 模型自述推断
 *   - 没有 model 的消息**不渲染徽章**（老数据不猜、不占位、不 backfill）
 *   - 断言同时看**展示文本**（徽章里写的）与**原始 id**（`title` 属性）——
 *     只看文本会被展示名骗过去
 *
 * ⚠️ 与 `commercial-activation.spec.ts` 的隔离差别：**workspace 建在 profile 里面**。
 * 那个 spec 用共享的 `e2e-artifacts/e2e-workspace`，于是上一次跑剩下的任务/消息
 * 会留在库里（实测：全新 profile 里一上来就有 13 个会话）。本文件要断言"恰好两条"，
 * 必须用干净 workspace；放在 profile 里还能跟着 profile 一起被收走。
 */

const CDP = 9410;
const MODEL_A = 'glm-4.7';
const MODEL_B = 'qwen-turbo';

let app: LaunchedApp | null = null;
let profileDir = '';
let workspaceDir = '';

async function stopAll(): Promise<void> {
  await stopEverything(app, profileDir);
  app = null;
}

/** 直接读**真实的** sqlite（不经应用，独立证据）。 */
function queryDb<T>(sql: string): T[] {
  const dbPath = path.join(workspaceDir, '.clawwork.db');
  if (!fs.existsSync(dbPath)) return [];
  // ⚠️ 应用开着的时候库是 WAL：CLI 读得到已提交的内容，但偶发 SQLITE_BUSY 要重试。
  for (let i = 0; i < 10; i++) {
    try {
      const out = execFileSync('sqlite3', [dbPath, '-json', sql], { encoding: 'utf8', timeout: 15_000 }).trim();
      return out ? (JSON.parse(out) as T[]) : [];
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    }
  }
  throw new Error(`sqlite3 读不出来（一直 BUSY）：${sql}`);
}

interface MsgRow {
  id: string;
  role: string;
  model: string | null;
  content: string;
}

/** 走**真实 IPC** 写一条消息（不是直接写库 —— 那样就绕过了 upsert 逻辑）。 */
async function persistMessage(page: Page, msg: Record<string, unknown>): Promise<void> {
  const res = (await page.evaluate(async (m) => {
    const api = (window as unknown as { clawwork: { persistMessage: (x: unknown) => Promise<unknown> } }).clawwork;
    return (await api.persistMessage(m)) as { ok?: boolean; error?: string };
  }, msg)) as { ok?: boolean; error?: string };
  expect(res?.ok, `persistMessage 失败：${JSON.stringify(res)}`).toBe(true);
}

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await stopAll();
  const res = cleanupProfiles();
  console.log(`[e2e-clean] ${res.reason}：删了 ${res.removed.length} 个，留了 ${res.kept.length} 个`);
});

// eslint-disable-next-line no-empty-pattern -- Playwright 要求第一个参数是解构模式，这里不需要任何 fixture
test.afterEach(({}, testInfo) => {
  if (testInfo.status !== 'passed' && testInfo.status !== 'skipped') markFailure();
});

test('P1. 确定性：两条不同 model → upsert 不抹 → 重启后 UI 各显示各的徽章', async () => {
  test.setTimeout(20 * 60_000);

  profileDir = freshTrackedProfile('prov'); // 创建即登记 ⇒ 收摊必删（见 profile-ledger.spec.ts）
  workspaceDir = path.join(profileDir, 'workspace'); // 干净 workspace，且随 profile 一起收走
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'clawwork-config.json'),
    JSON.stringify({ workspacePath: workspaceDir, gateways: [] }, null, 2),
  );

  app = launchApp(profileDir, CDP);
  expect(await waitForGateway(), '网关没起来').toBe(true);
  const first = await connect(CDP);

  const taskId = 'task-prov-1';
  const sessionKey = `agent:main:clawwork:prov:task:${taskId}`;
  const t0 = '2026-09-13T12:00:00.000Z';
  const t1 = '2026-09-13T12:00:01.000Z';
  const t2 = '2026-09-13T12:00:02.000Z';

  try {
    // ---- 1. 建任务（真实 IPC）----
    const taskRes = (await first.page.evaluate(
      async (t) => {
        const api = (window as unknown as { clawwork: { persistTask: (x: unknown) => Promise<unknown> } }).clawwork;
        return (await api.persistTask(t)) as { ok?: boolean };
      },
      {
        id: taskId,
        sessionKey,
        sessionId: 'session-prov-1',
        title: '模型徽章：确定性',
        status: 'active',
        createdAt: t0,
        updatedAt: t2,
        tags: [],
        artifactDir: `tasks/${taskId}`,
        gatewayId: 'local-runtime',
      },
    )) as { ok?: boolean };
    expect(taskRes?.ok, '任务没建出来').toBe(true);

    // ---- 2. 两条 assistant，各带自己的 model（＋一条 user，它**不该**有徽章）----
    await persistMessage(first.page, {
      id: 'u-prov-1',
      taskId,
      role: 'user',
      content: '只回复：收到',
      timestamp: t0,
    });
    await persistMessage(first.page, {
      id: 'a-prov-1',
      taskId,
      role: 'assistant',
      content: '收到（一）',
      timestamp: t1,
      model: MODEL_A,
    });
    await persistMessage(first.page, {
      id: 'a-prov-2',
      taskId,
      role: 'assistant',
      content: '收到（二）',
      timestamp: t2,
      model: MODEL_B,
    });

    // ---- 3. 独立证据：直接读 sqlite，两条各带自己的 model ----
    let rows = queryDb<MsgRow>(
      `SELECT id, role, model, content FROM messages WHERE task_id='${taskId}' ORDER BY timestamp`,
    );
    expect(rows.map((r) => `${r.id}:${r.model}`)).toEqual([
      'u-prov-1:null',
      `a-prov-1:${MODEL_A}`,
      `a-prov-2:${MODEL_B}`,
    ]);

    // ---- 4. ⭐ upsert 不抹：中途一次**不带 model** 的重写（工具调用/推理就是这样写的）----
    await persistMessage(first.page, {
      id: 'a-prov-2',
      taskId,
      role: 'assistant',
      content: '收到（二）—— 带工具调用',
      timestamp: t2,
      // 刻意 **不传** model
    });
    rows = queryDb<MsgRow>(
      `SELECT id, role, model, content FROM messages WHERE task_id='${taskId}' ORDER BY timestamp`,
    );
    const second = rows.find((r) => r.id === 'a-prov-2');
    expect(second?.content).toContain('带工具调用'); // 确实被更新了
    expect(second?.model, '⛔ 一次不带 model 的 upsert 把已落库的 model 抹掉了').toBe(MODEL_B);

    await first.browser.close().catch(() => {});

    // ---- 5. ⭐ 重启（同一 profile）：UI 必须各显示各的徽章 ----
    await stopAll();
    app = launchApp(profileDir, CDP);
    expect(await waitForGateway(), '重启后网关没起来').toBe(true);
    const again = await connect(CDP);
    try {
      const page = again.page;
      await expect
        .poll(async () => (await page.locator('body').innerText()).includes('已重连'), { timeout: 90_000 })
        .toBe(true);

      // 打开这个任务（重启后不一定默认就是它）
      const nav = page.getByText('模型徽章：确定性').first();
      await nav.waitFor({ state: 'visible', timeout: 60_000 });
      await nav.click({ timeout: 15_000 });

      // ⭐⭐ 徽章：两条 assistant 各一枚，展示文本与原始 id 都对
      const badges = page.getByTestId('model-badge');
      await expect(badges).toHaveCount(2, { timeout: 60_000 });
      await expect(badges.nth(0)).toHaveText(MODEL_A);
      await expect(badges.nth(0)).toHaveAttribute('title', MODEL_A);
      await expect(badges.nth(1)).toHaveText(MODEL_B);
      await expect(badges.nth(1)).toHaveAttribute('title', MODEL_B);

      // 用户那条**不许**有徽章 —— 网关对 user 记录本来就不带 model
      const userBubble = page.getByText('只回复：收到').first();
      await expect(userBubble).toBeVisible({ timeout: 15_000 });
      await expect(userBubble.locator('[data-testid="model-badge"]')).toHaveCount(0);

      console.log(
        `\n[prov] P1 确定性通过：sqlite 两条 model=${MODEL_A}/${MODEL_B}（upsert 未抹），` +
          `重启后 DOM 两枚徽章逐条对应`,
      );
    } finally {
      await again.browser.close().catch(() => {});
      await stopAll();
    }
  } finally {
    await first.browser.close().catch(() => {});
  }
});
