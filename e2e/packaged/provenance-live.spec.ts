import { expect, test } from '@playwright/test';
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
  waitForRelayModels,
  type LaunchedApp,
} from './harness.js';
import { readDevProvision, provisionProfile } from './provision.js';
import { pickModel } from './model-picker.js';

/**
 * 消息级 model 徽章 —— **真实模型** E2E（同会话切模型）。
 *
 * 与 `provenance.spec.ts` 的分工：那份是**确定性**的（消息由 IPC 写库，不调模型）；
 * 这份是**真的**：真的商业激活、真的中转目录、真的发消息、真的让三个不同的模型
 * 各回一条，然后看 UI 上**每条是不是各自标了自己的模型**。
 *
 * 证的四件事：
 *   ① 同一条会话里三条回复，UI 上三枚徽章**各是各的**（不会串成会话当前选的模型）
 *   ② 之后把 picker 切到**第四个**模型（不发消息）⇒ 前三条徽章**一个字都不变**
 *   ③ 重启客户端 ⇒ 三条 provenance 全在（靠落库 + `hydrateFromLocal`，不是内存）
 *   ④ 独立证据：直接读 sqlite 的三行，model 逐条对得上
 *
 * ⚠️ 纪律：只发中性文本（「只回复：收到」）——**不问"你是什么模型"**。
 *    模型自述会被历史回声带偏（实测过），那不是证据；这条链的唯一证据是
 *    网关逐条消息的 `model` 字段。
 *
 * ⚠️ 需要开发机上有可搬运的商业身份；没有就 skip（见 `provision.ts`）。
 */

const provision = readDevProvision();
const CDP = 9411;

let app: LaunchedApp | null = null;
let profileDir = '';
let workspaceDir = '';

async function stopAll(): Promise<void> {
  await stopEverything(app, profileDir);
  app = null;
}

function queryDb<T>(sql: string): T[] {
  const dbPath = path.join(workspaceDir, '.clawwork.db');
  if (!fs.existsSync(dbPath)) return [];
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

interface GwSession {
  key?: string;
  model?: string;
  modelProvider?: string;
  modelOverrideSource?: string;
  outputTokens?: number;
  status?: string;
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

test('L1. 真实模型：同会话三条回复各带自己的徽章；切到第四个模型不改历史；重启仍在', async () => {
  test.setTimeout(25 * 60_000);
  test.skip(!provision, '开发机上没有可搬运的商业身份（%APPDATA%\\@clawwork\\desktop）');

  profileDir = freshTrackedProfile('prov-live');
  workspaceDir = path.join(profileDir, 'workspace');
  provisionProfile(profileDir, provision!, { workspacePath: workspaceDir });

  app = launchApp(profileDir, CDP);
  expect(await waitForGateway(), '网关没起来').toBe(true);
  const first = await connect(CDP);
  let page = first.page;

  const send = async (text: string): Promise<void> => {
    const composer = page.locator('textarea').first();
    await composer.waitFor({ state: 'visible', timeout: 30_000 });
    await composer.fill(text);
    const btn = page.getByRole('button', { name: '发送', exact: true });
    await expect(btn, '输入了内容发送键却不可点').toBeEnabled({ timeout: 15_000 });
    await btn.click({ timeout: 15_000 });
  };

  /** 等这一轮**真的跑完**（状态 done + 产出了 token），返回网关记的模型。 */
  const waitTurnDone = async (sessionKey: string): Promise<GwSession> => {
    const deadline = Date.now() + 180_000;
    let last = '（一次都没读到）';
    for (;;) {
      const res = (await page.evaluate(async () => {
        const api = (window as unknown as { clawwork: { listSessions: (g: string) => Promise<unknown> } }).clawwork;
        return (await api.listSessions('local-runtime')) as { result?: { sessions?: GwSession[] } };
      })) as { result?: { sessions?: GwSession[] } };
      const s = res.result?.sessions?.find((x) => x.key === sessionKey);
      last = s
        ? `model=${s.model ?? '(空)'} out=${s.outputTokens ?? 0} status=${s.status ?? '(空)'}`
        : '（还没这个会话）';
      if (s && s.model && (s.outputTokens ?? 0) > 0 && s.status === 'done') return s;
      if (Date.now() >= deadline) throw new Error(`等了 3 分钟这轮还没跑完；最后读到：${last}`);
      await new Promise((r) => setTimeout(r, 2_000));
    }
  };

  try {
    // ---- 0. 商业激活就绪：中转目录必须真的非空 ----
    const models = await waitForRelayModels(page, 3, 240_000);
    expect(models.relay.length, '中转目录没起来，无法做真实模型用例').toBeGreaterThanOrEqual(3);

    // 优先用用户点名的那三款；目录里没有就顺位取前三（断言的是"各是各的"，与具体款无关）
    const preferred = ['glm-4.7', 'qwen-turbo', 'kimi-k2-thinking'];
    const picked = preferred
      .map((p) => models.relay.find((m) => m.id === p || m.name === p))
      .filter((m): m is (typeof models.relay)[number] => Boolean(m));
    for (const m of models.relay) {
      if (picked.length >= 3) break;
      if (!picked.some((x) => x.id === m.id)) picked.push(m);
    }
    const [m1, m2, m3] = picked;
    const fourth = models.relay.find((m) => !picked.some((x) => x.id === m.id));
    expect(m1 && m2 && m3, '模型中转目录不足 3 款').toBeTruthy();
    expect(fourth, '目录里没有第 4 款可切').toBeTruthy();
    console.log(
      `\n[prov-live] 用这三款：${picked.map((m) => `${m.id}(${m.name})`).join(' / ')}；` +
        `第四款=${fourth!.id}(${fourth!.name})`,
    );

    // ---- 1. 新任务 ----
    await page.locator('button[aria-label="新任务"]').click({ timeout: 30_000 });
    await expect
      .poll(async () => (await page.locator('body').innerText()).includes('main'), { timeout: 30_000 })
      .toBe(true);

    // ⚠️ 点"新任务"只是在 UI 里开一个 —— **它这时还没落库**（实测：立即 `loadTasks()`
    //    拿到 `{ok:true, rows:[]}`）。任务要等**第一条消息发出去**才写进 tasks 表，
    //    所以任务 id / sessionKey 只能在第一轮发送之后取。
    const loadTask = async (): Promise<{ id: string; sessionKey: string } | undefined> => {
      const res = (await page.evaluate(async () => {
        const api = (window as unknown as { clawwork: { loadTasks: () => Promise<unknown> } }).clawwork;
        return (await api.loadTasks()) as { rows?: Array<{ id: string; sessionKey: string }> };
      })) as { rows?: Array<{ id: string; sessionKey: string }> };
      return res.rows?.[0];
    };
    const waitForTask = async (): Promise<{ id: string; sessionKey: string }> => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const t = await loadTask();
        if (t?.sessionKey) return t;
        if (Date.now() >= deadline) throw new Error('发出去 60 秒了，tasks 表里还是没有这个任务');
        await new Promise((r) => setTimeout(r, 1_000));
      }
    };

    // ---- 2. 三轮：切模型 → 发中性文本 → 等跑完，并逐条验网关记的模型 ----
    const used: string[] = [];
    let task: { id: string; sessionKey: string } | null = null;
    for (const m of [m1, m2, m3]) {
      await pickModel(page, m.name);
      await expect(page.locator('button:has(span.max-w-36)').first()).toContainText(m.name, { timeout: 15_000 });
      await send('只回复：收到');
      task ??= await waitForTask();
      const s = await waitTurnDone(task.sessionKey);
      const bare = String(s.model ?? '').replace(/^[^/]+\//, '');
      expect(bare, `这一轮网关记的是 ${s.model}，不是刚选的 ${m.id}`).toBe(m.id);
      expect(s.modelOverrideSource, '不是用户选的那个覆盖（那就是默认值兜的）').toBe('user');
      used.push(m.id);
      console.log(`[prov-live] 第 ${used.length} 轮：网关 model=${s.model} out=${s.outputTokens}`);
    }
    if (!task) throw new Error('三轮都跑完了却没拿到任务');

    // 给任务一个**确定的名字**：重启之后要靠它把任务点开。放在三轮**之后**改名是因为
    // `autoTitleIfNeeded` 在 final 帧就会拿首条回复当标题 —— 它只在"还没标题"时才动手，
    // 所以这里改完就不会再被盖掉（提前改也一样安全，放后面只是省得跟它抢）。
    await page.evaluate(
      async ({ id, updatedAt }) => {
        const api = (window as unknown as { clawwork: { persistTaskUpdate: (x: unknown) => Promise<unknown> } })
          .clawwork;
        return api.persistTaskUpdate({ id, title: '模型徽章：真实模型', updatedAt });
      },
      { id: task.id, updatedAt: new Date().toISOString() },
    );

    // ---- 3. ⭐ DOM：三条徽章各是各的（顺序 = 发送顺序）----
    const badges = page.getByTestId('model-badge');
    await expect(badges).toHaveCount(3, { timeout: 60_000 });
    for (let i = 0; i < 3; i++) {
      // 徽章文本是**目录里的展示名**（可能不等于 id）⇒ 用 title 上的原始 id 做铁证
      await expect(badges.nth(i), `第 ${i + 1} 条徽章不是它自己的模型`).toHaveAttribute('title', used[i]!);
    }

    // ---- 4. ⭐ 切到第四款（不发消息）⇒ 历史三条**一个字都不变** ----
    const before = await badges.evaluateAll((els) => els.map((e) => e.getAttribute('title')));
    await pickModel(page, fourth!.name);
    await expect(page.locator('button:has(span.max-w-36)').first()).toContainText(fourth!.name, { timeout: 15_000 });
    const after = await badges.evaluateAll((els) => els.map((e) => e.getAttribute('title')));
    expect(after, '切换 picker 竟然改了历史消息的徽章').toEqual(before);
    expect(after).toEqual(used);

    // ---- 5. ⭐ 重启：徽章必须还在（落库 + hydrateFromLocal，不是内存）----
    await first.browser.close().catch(() => {});
    await stopAll();
    app = launchApp(profileDir, CDP);
    expect(await waitForGateway(), '重启后网关没起来').toBe(true);
    const again = await connect(CDP);
    try {
      page = again.page;
      await expect
        .poll(async () => (await page.locator('body').innerText()).includes('已重连'), { timeout: 90_000 })
        .toBe(true);
      // 打开原任务
      const nav = page.getByText('模型徽章：真实模型').first();
      await nav.waitFor({ state: 'visible', timeout: 60_000 });
      await nav.click({ timeout: 15_000 });

      const badges2 = page.getByTestId('model-badge');
      await expect(badges2, '重启后徽章没了').toHaveCount(3, { timeout: 60_000 });
      for (let i = 0; i < 3; i++) {
        await expect(badges2.nth(i)).toHaveAttribute('title', used[i]!);
      }

      // ---- 6. 独立证据：sqlite 三行逐条对得上 ----
      const rows = queryDb<{ model: string | null }>(
        `SELECT model FROM messages WHERE task_id='${task.id}' AND role='assistant' ORDER BY timestamp`,
      );
      expect(
        rows.map((r) => r.model),
        '⛔ 库里存的和 UI 上显示的对不上',
      ).toEqual(used);

      console.log(
        `\n[prov-live] 通过：三条=${used.join(' → ')}；切 ${fourth!.id} 后历史不变；重启后仍对；sqlite 逐条一致`,
      );
    } finally {
      await again.browser.close().catch(() => {});
      await stopAll();
    }
  } finally {
    await first.browser.close().catch(() => {});
  }
});
