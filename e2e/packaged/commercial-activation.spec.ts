import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  ARTIFACTS,
  cleanupProfiles,
  connect,
  ensureArtifacts,
  freshUserData,
  launchApp,
  nodeProcesses,
  markFailure,
  portHasGateway,
  readModels,
  stopEverything,
  waitForGateway,
  waitForRelayModels,
  type LaunchedApp,
} from './harness.js';
import { sweepStaleProfiles } from '../helpers/temp-root.js';
import { readDevProvision, provisionProfile } from './provision.js';
import { startAuthFaultProxy } from './auth-fault-proxy.js';
import { watchSessionStore, type SessionStoreWatcher } from './session-store-watch.js';

/**
 * 阶段 2A：商业激活 → **真模型**出现。
 *
 * 阶段 1 证明了「客户端能把网关拉起来」；但纯净 profile 里 `models.list` 是空的
 * （界面只有 Default）—— 因为模型目录来自中转服务，要走商业激活那条链。
 *
 * 本文件证的是那条链：
 *
 *   纯净 profile → 登录/授权就绪 → 中转配置落到网关 → `models.list` **非空**
 *   → UI 能看见并**选中**真模型
 *
 * ⚠️ 三条纪律（用户点名）：
 *   - **不伪造模型**：断言只认 `models.list` 里 `provider === 'clawrouter'` 的真实条目
 *   - **密钥最小暴露**：只断言存在性/数量/模型 id，**不打印任何 secret**
 *   - **runtime ready ≠ commercial ready**：「没激活」绝不能被报成「网关起不来」
 *
 * 需要开发机 `%APPDATA%\@clawwork\desktop` 上有已登录的商业身份；没有就 skip
 * （见 `provision.ts` 的说明：provisioning 本来就是带外的，仓库里没有）。
 */

const provision = readDevProvision();
const CDP = 9400;
const WORKSPACE = path.join(ARTIFACTS, 'e2e-workspace');

let app: LaunchedApp | null = null;
/** 场景 2 用的 profile —— 场景 4 要拿它验"重启恢复"。 */
let activatedUserData = '';
/** 当前这个 app 用的是哪个 profile（收摊时要按它找残留网关）。 */
let currentUserData = '';

/**
 * 彻底收摊。
 *
 * ⚠️ 必须**同时**收 app 和"跑在这个 profile 里的网关" —— 实测两次：应用被
 * `taskkill /T` 收掉之后网关还活着，继续占着 18789，下一个场景的"端口是空的"
 * 检查直接通过，然后一直等一个永远不来的状态、撞满超时。详见 harness 里的注释。
 */
async function stopAll(): Promise<void> {
  await stopEverything(app, currentUserData);
  app = null;
}

/**
 * 截图。**永远走这个函数**，别直接 `page.screenshot()`。
 *
 * ⚠️ 三条实测教训：
 *   ① `page.screenshot()` 会等页面"稳定"，而 `actionTimeout` 默认是 **0（不超时）**
 *      —— 页面只要有持续动画（Radix 菜单开着），它会**一直**等下去。实测卡死过一次，
 *      日志里什么都不出，看起来像网关挂了。
 *   ② 所以必须给 `timeout`；菜单开着时再开 `animations:'disabled'`。
 *   ③ **截图是产物，不是断言** ⇒ **失败只告警**。本机实测 `captureScreenshot`
 *      会偶发超时（窗口被遮挡 / 合成器不给帧），跟被测逻辑无关。
 *      让一张诊断图把 serial 的整套用例带走，代价远大于收益 ——
 *      真要判断对错的是下面那些断言，不是这张图。
 */
async function shot(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({ path: path.join(ARTIFACTS, name), animations: 'disabled', timeout: 20_000 });
  } catch (error) {
    console.warn(
      `[2A] 截图 ${name} 没拍成（**不影响成败**）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * 读这个 profile 里应用写下的 `relay.bootstrap.*` 事件。
 *
 * 用它而不是看界面：2B 要证的正是**分类**（"暂时问不出来" vs "没登录"），
 * 而这区分目前只体现在日志与状态里（渲染层还没有第三种表达）。
 *
 * ⚠️ 日志里**绝不含任何密钥**（`relay-bootstrap` 那条纪律），所以可以放心读。
 */
function bootstrapEvents(userDataDir: string): string[] {
  const dir = path.join(userDataDir, 'logs');
  if (!fs.existsSync(dir)) return [];
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.ndjson'));
  if (!file) return [];
  const out: string[] = [];
  for (const line of fs.readFileSync(path.join(dir, file), 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line) as { event?: string };
      const ev = String(d.event ?? '');
      if (ev.startsWith('relay.bootstrap') || ev.startsWith('commercial.relay.bootstrap')) out.push(ev);
    } catch {
      /* 半行/坏行跳过 */
    }
  }
  return out;
}

interface LogEvent {
  ts: string;
  event: string;
  data?: Record<string, unknown>;
}

/**
 * 读这个 profile 里**全部**结构化日志事件（按时间升序）。
 *
 * 与 `bootstrapEvents` 的区别：那个只回事件名、只看 `relay.bootstrap*`；
 * 这个要 `ts` 与 `data`，才能把 `commercial.auth.probe` 的耗时/错误
 * 和**代理侧**的请求次数按时间对齐 —— 6b 的决定性证据就是这么来的。
 *
 * ⚠️ 日志里**绝不含任何密钥**（`relay-bootstrap` 那条纪律），所以可以放心读。
 */
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
        const d = JSON.parse(line) as { ts?: string; event?: string; data?: Record<string, unknown> };
        if (d.ts && d.event) out.push({ ts: d.ts, event: String(d.event), data: d.data });
      } catch {
        /* 半行/坏行跳过 */
      }
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** 只取会话探测事件（`commercial.auth.probe`）。 */
function authProbes(userDataDir: string): LogEvent[] {
  return readLogEvents(userDataDir).filter((e) => e.event === 'commercial.auth.probe');
}

async function bootConfigured(
  tag: string,
  opts: {
    supabaseUrlOverride?: string;
    skipSession?: boolean;
    /**
     * provision 铺完、**应用还没启动**的那一刻。
     *
     * 只在需要"改动前基线"的场景用（6b 的会话文件观察器）：一旦 app 起来了，
     * 第一次 `setItem` 就可能已经发生，基线就取不到种子状态了。
     */
    afterProvision?: (userDataDir: string) => void;
  },
) {
  const { afterProvision, ...provisionOpts } = opts;
  // `freshUserData` 自己就把目录登记进收摊台账了 —— 别在这里再补 `trackProfile`
  // （登记只有一处，见 harness 里 `freshTrackedProfile` 的说明）。
  const userDataDir = freshUserData(tag);
  provisionProfile(userDataDir, provision!, { workspacePath: WORKSPACE, ...provisionOpts });
  afterProvision?.(userDataDir);
  currentUserData = userDataDir;
  app = launchApp(userDataDir, CDP);
  expect(await waitForGateway(), '网关没起来').toBe(true);
  const { browser, page } = await connect(CDP);
  return { userDataDir, browser, page };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  ensureArtifacts();
  // 先把**上一次**残留的 profile 扫掉 —— Ctrl+C / 超时 / 关机都会让 finally 跑不到。
  const swept = sweepStaleProfiles({ log: (m) => console.log(m) });
  if (swept.removed.length > 0) {
    console.log(
      `[e2e-clean] 启动清扫：删了 ${swept.removed.length} 个旧 profile，` +
        `释放 ${(swept.freedBytes / 1024 ** 3).toFixed(2)} GB`,
    );
  }
  // ⚠️ 要**建**，不是断言它存在 —— 它是本用例自己的产物目录，第一次跑时并不存在。
  fs.mkdirSync(WORKSPACE, { recursive: true });
});

// eslint-disable-next-line no-empty-pattern -- Playwright 要求第一个参数是解构模式，这里不需要任何 fixture
test.afterEach(({}, testInfo) => {
  // 失败要**留现场**：profile 里有商业会话密文、日志、网关 state，是唯一的证据。
  if (testInfo.status !== 'passed' && testInfo.status !== 'skipped') markFailure();
});

test.afterAll(async () => {
  await stopAll();
  // 全部通过 ⇒ 把本 suite 建的 profile 都删掉（junction-safe）。
  const res = cleanupProfiles();
  console.log(`[e2e-clean] ${res.reason}：删了 ${res.removed.length} 个，留了 ${res.kept.length} 个`);
});

// ---------------------------------------------------------------- 场景 1

test('场景 1：纯净 profile **未激活** ⇒ 不伪造模型，网关仍正常，UI 不把它说成网关故障', async () => {
  test.setTimeout(15 * 60_000);
  // ⚠️ 这条**刻意不走 `bootConfigured`**（那个会 `provisionProfile`，把 profile 激活，
  //    而本场景要证的恰恰是"未激活"）。手写创建流程的代价是容易漏掉 helper 附带的动作 ——
  //    这里曾经漏过 `trackProfile`，导致这个 634MB 的 profile 收摊时删不掉。
  //    现在 `freshUserData` 自带登记，手写路径不会再漏。
  const userDataDir = freshUserData('clean');
  // 只给一个 workspace，**不给任何商业配置** —— 这就是用户拿到手的纯净 profile
  fs.writeFileSync(
    path.join(userDataDir, 'clawwork-config.json'),
    JSON.stringify({ workspacePath: WORKSPACE, gateways: [] }, null, 2),
  );
  currentUserData = userDataDir;
  app = launchApp(userDataDir, CDP);
  expect(await waitForGateway(), '网关没起来').toBe(true);

  const { browser, page } = await connect(CDP);
  try {
    // 网关是好的 —— Agent / 会话照常
    await expect
      .poll(async () => (await page.locator('body').innerText()).includes('已重连'), { timeout: 90_000 })
      .toBe(true);
    await page.locator('button[aria-label="切换智能体"]').click();
    await expect
      .poll(async () => (await page.locator('body').innerText()).includes('main'), { timeout: 30_000 })
      .toBe(true);
    await page.keyboard.press('Escape');

    // ⭐ 模型**一条都没有**，而且**不是伪造出来的**
    const models = await readModels(page);
    expect(models.relay, `未激活却出现了中转模型：${JSON.stringify(models.relay)}`).toHaveLength(0);

    // ⭐ 关键区别：这是"没激活"，**不是**"网关起不来" —— 网关是活的
    expect(await portHasGateway()).toBe(true);

    ensureArtifacts();
    await shot(page, 'stage2-01-unactivated.png');

    console.log(`\n[2A] 场景1 未激活：gateway=up relayModels=${models.relay.length} totalCatalog=${models.total}`);
  } finally {
    await browser.close().catch(() => {});
    await stopAll();
  }
});

// ---------------------------------------------------------------- 场景 2

test('场景 2：登录/授权就绪 ⇒ 中转配置落到网关，`models.list` **真实非空**', async () => {
  test.setTimeout(15 * 60_000);
  test.skip(!provision, '开发机上没有可搬运的商业身份（%APPDATA%\\@clawwork\\desktop）');

  const { userDataDir, browser, page } = await bootConfigured('active', {});
  activatedUserData = userDataDir;
  try {
    const models = await waitForRelayModels(page, 1, 240_000);
    expect(models.relay.length, '等了 4 分钟仍没有中转模型').toBeGreaterThan(0);

    // 中转配置**真的**写进了网关（不是只写在我们自己的状态里）
    const gwConfig = JSON.parse(
      fs.readFileSync(path.join(userDataDir, 'openclaw-state', 'openclaw.json'), 'utf-8'),
    ) as { models?: { providers?: Record<string, { baseUrl?: string }> } };
    const provider = gwConfig.models?.providers?.clawrouter;
    expect(provider, '网关配置里没有 clawrouter provider').toBeTruthy();
    expect(String(provider?.baseUrl)).toContain('/relay');

    await shot(page, 'stage2-02-models.png');
    console.log(
      `\n[2A] 场景2 激活成功：relayModels=${models.relay.length} / totalCatalog=${models.total}\n` +
        `      模型 id：${models.relay.map((m) => m.id).join(', ')}`,
    );
  } finally {
    await browser.close().catch(() => {});
    // 刻意**不杀**：下一个场景要复用这个 profile 验重启恢复
  }
});

// ---------------------------------------------------------------- 场景 3

// ---------------------------------------------------------------- 场景 4

test('场景 4：重启恢复 ⇒ 从 cache 快速起来、商业配置还在、模型仍非空（不用重新激活）', async () => {
  test.setTimeout(15 * 60_000);
  test.skip(!provision, '同上');

  expect(activatedUserData, '场景 2 没跑成，没有可恢复的 profile').not.toBe('');
  // 记下重启前的证据
  const stateBefore = fs.readFileSync(path.join(activatedUserData, 'openclaw-state', 'openclaw.json'), 'utf-8');

  // 关掉（连网关一起），再用**同一个 profile** 冷启一次
  await stopAll();
  const t0 = Date.now();
  currentUserData = activatedUserData;
  app = launchApp(activatedUserData, CDP);
  expect(await waitForGateway(), '重启后网关没起来').toBe(true);
  const bootMs = Date.now() - t0;

  const { browser, page } = await connect(CDP);
  try {
    await expect
      .poll(async () => (await page.locator('body').innerText()).includes('已重连'), { timeout: 90_000 })
      .toBe(true);

    // ⭐ 没有重新激活、没有重新配置 —— 模型照样在
    const models = await waitForRelayModels(page, 1, 180_000);
    expect(models.relay.length, '重启后中转模型消失了').toBeGreaterThan(0);

    // 网关配置里的中转 provider 必须还在（说明是"恢复"，不是"重来一遍"）
    const stateAfter = fs.readFileSync(path.join(activatedUserData, 'openclaw-state', 'openclaw.json'), 'utf-8');
    const after = JSON.parse(stateAfter) as { models?: { providers?: Record<string, unknown> } };
    expect(after.models?.providers?.clawrouter, '重启后 clawrouter 配置丢了').toBeTruthy();
    expect(stateBefore).toContain('clawrouter');

    await shot(page, 'stage2-04-restart.png');
    console.log(`\n[2A] 场景4 重启恢复：bootMs≈${bootMs} relayModels=${models.relay.length}（未重新激活）`);
  } finally {
    await browser.close().catch(() => {});
  }
});

// ---------------------------------------------------------------- 场景 5

test('场景 5a：配了商业层但**没登录** ⇒ 不伪造模型，网关照常（不误报成 runtime 失败）', async () => {
  test.setTimeout(15 * 60_000);
  test.skip(!provision, '同上');
  await stopAll();

  const { browser, page } = await bootConfigured('nosession', { skipSession: true });
  try {
    await expect
      .poll(async () => (await page.locator('body').innerText()).includes('已重连'), { timeout: 90_000 })
      .toBe(true);
    const models = await readModels(page);
    expect(models.relay).toHaveLength(0);
    expect(await portHasGateway()).toBe(true);

    // 2B：**明确**没登录必须被认成 `unauthenticated`，既不能含糊成"暂不可用"，
    //     也不该对一份"根本没有会话"的客户端反复重试。
    //     （`AuthSessionMissingError` 的 status 是 **400** —— 只看状态码会归错的正是这一条。）
    const events = bootstrapEvents(currentUserData);
    expect(events, `没认出"明确未登录"：${events.join(' → ')}`).toContain('relay.bootstrap.unauthenticated');
    expect(events, `把"没登录"说成了暂时失败：${events.join(' → ')}`).not.toContain(
      'relay.bootstrap.auth-transient-failure',
    );
    expect(events, `对"没登录"做了无谓重试：${events.join(' → ')}`).not.toContain('relay.bootstrap.retry');
    console.log(`\n[2A] 场景5a 未登录：relayModels=${models.relay.length} gateway=up`);
  } finally {
    await browser.close().catch(() => {});
    await stopAll();
  }
});

test('场景 5b：商业后端**不可达** ⇒ 同样不伪造、网关照常（fail-safe）', async () => {
  test.setTimeout(15 * 60_000);
  test.skip(!provision, '同上');
  await stopAll();

  const { browser, page } = await bootConfigured('badbackend', {
    supabaseUrlOverride: 'https://127.0.0.1:1',
  });
  try {
    await expect
      .poll(async () => (await page.locator('body').innerText()).includes('已重连'), { timeout: 90_000 })
      .toBe(true);
    const models = await readModels(page);
    expect(models.relay).toHaveLength(0);
    expect(await portHasGateway()).toBe(true);

    // ⭐ 2B 的核心断言：后端**不可达**只是"暂时问不出来"，**绝不是**"用户没登录"。
    //    旧代码在这里报的正是 `unauthenticated` —— 一次网络问题就把用户的会话否掉，
    //    而且整个会话都不会再列模型。
    await expect
      .poll(() => bootstrapEvents(currentUserData).includes('relay.bootstrap.auth-transient-failure'), {
        timeout: 60_000,
      })
      .toBe(true);
    const events = bootstrapEvents(currentUserData);
    expect(events, `后端不可达被说成了"未登录"：${events.join(' → ')}`).not.toContain(
      'relay.bootstrap.unauthenticated',
    );
    // 重试必须**有界**：退避表用完就停（2s / 5s / 15s / 30s 各一次）
    const retries = events.filter((e) => e === 'relay.bootstrap.retry').length;
    expect(retries, `重试次数没有上界：${retries}`).toBeLessThanOrEqual(4);
    console.log(
      `\n[2A] 场景5b 商业后端不可达：relayModels=${models.relay.length} gateway=up（退避重试 ${retries} 次后有界停止）`,
    );
  } finally {
    await browser.close().catch(() => {});
    await stopAll();
  }
});

// ---------------------------------------------------------------- 场景 6（2B 核心）

/**
 * 2B 的核心验收。**拆成两半**，因为一半能证、一半证不了（见 6b）。
 *
 * 故障是**受控**注入的：`supabaseUrl` 指到一个本地反向代理，它在开关打开时
 * 把 `/auth/v1/*` 拖到 12 秒才回。客户端的会话检查窗口是 8 秒 ⇒ **它自己先超时**，
 * 而底层请求最终还是会成功 —— 这正是真实事故的形状（措辞很重要：**不是**"网络断了"，
 * 而是"请求还在路上，我们的窗口先到了"）。
 */
test('场景 6a：会话检查**暂时**问不出来 ⇒ 判"暂不可用"，**绝不判"未登录"**，且重试有界', async () => {
  test.setTimeout(15 * 60_000);
  test.skip(!provision, '同上');
  await stopAll();

  const proxy = await startAuthFaultProxy(provision!.supabaseUrl);
  try {
    const { userDataDir, browser } = await bootConfigured('authtransient', {
      supabaseUrlOverride: proxy.url,
    });
    try {
      await expect
        .poll(() => bootstrapEvents(userDataDir).includes('relay.bootstrap.auth-transient-failure'), {
          timeout: 150_000,
        })
        .toBe(true);

      const events = bootstrapEvents(userDataDir);
      // ⭐ 2B 的核心：暂时问不出来 ≠ 没登录
      expect(events, `暂时失败被说成了"未登录"：${events.join(' → ')}`).not.toContain(
        'relay.bootstrap.unauthenticated',
      );
      // 其它请求（org_members / activate_license）没被误伤 ⇒ 代理转发是通的
      // ⚠️ 这里判"注入点被真的打到过"要用 **totalHits**（到达即计数），
      //    不是 `failingHits` —— 后者只在 failing 期间增长，是旧版把结论带偏的那个口径。
      expect(proxy.totalHits(), `注入点没被真的打到过；路径=${JSON.stringify(proxy.requestPaths())}`).toBeGreaterThan(
        0,
      );
      expect(proxy.failingHits(), '失败相期间应当有请求到达').toBeGreaterThan(0);
      // 网关照常 —— runtime ready ≠ commercial ready，两者互不牵连
      expect(await portHasGateway()).toBe(true);
      console.log(
        `
[2B] 场景6a 暂时失败：判为 auth-transient（**不是** unauthenticated）` +
          `；代理 total=${proxy.totalHits()} failing=${proxy.failingHits()} healthy=${proxy.healthyHits()}` +
          `；网关仍 up\n${proxy.timeline()}`,
      );
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    await stopAll();
    await proxy.close();
  }
});

/**
 * 6b：**后端不可达的 transient outage 恢复后，同一进程能不能自愈**（主验收）。
 *
 * ## ⚠️ 两个场景必须分开，别混（2026-09-13 的教训）
 *
 * | 场景 | 上游有没有被碰到 | 用在 |
 * |---|---|---|
 * | **fail-before-upstream**（请求到代理为止，**不转发**） | 否 —— token 没被消费 | ⭐ **主 6b** |
 * | `slow`（延迟 12s **后照常转发**，上游 200） | **是** —— 属于 response-loss | 6c（独立诊断，fixme） |
 *
 * 早先把 `slow` 当成主 6b，得到的现象（heal 后仍不恢复）**不能**归给"后端不可达" ——
 * 那里面混着"上游已经成功处理、客户端没收到"这个**另一类**故障。
 *
 * ---
 *
 * （下面是 2026-09-13 的旧记录，保留作依据）
 *
 * ## ⚠️ 2026-09-13 更正：先前那条证据作废
 *
 * 上一轮写在这里的"代理命中数恢复后冻住（3 → 3）⇒ SDK 不再访问网络"**是错的**。
 * 那个数取自 `failingHits`，而它**只在 `failing === true` 时增长** ——
 * `setFailing(false)` 之后它本来就**必然**冻住，它压根不观察 heal 之后的事。
 * 用一个必然冻结的计数器去证明"没有请求"，是拿定义当结论。
 * `auth-fault-proxy.ts` 已补 `totalHits` / `healthyHits`（到达即计数、与 phase 无关）。
 *
 * ## 隔离实验（合成 token + 本地代理，不碰真实凭证）反而证伪了"永久中毒"
 *
 *   1. 失败期一次 `getUser()` 会连发 **8 个** `/token?grant_type=refresh_token`
 *      （auth-js 自己的 200/400/800… 退避，`GoTrueClient.js:4025-4041`），
 *      最终返回 `AuthRetryableFetchError`，并**把失败写进实例缓存**
 *      （`GoTrueClient.js:4319-4323`）。
 *   2. heal 之后 **T+2s** 再 `getUser()`：**0ms、0 个请求** —— 缓存命中
 *      （`GoTrueClient.js:4206-4211`）。**这一条是真的**。
 *   3. 但 heal 之后 **T+65s**（> `REFRESH_FAILURE_COOLDOWN_MS` = 60s）再 `getUser()`：
 *      **真的发了 2 个请求**（`/token` + `/user`），刷新**成功**、`lastRefreshFailure`
 *      被清空（`:4286`），会话恢复。
 *   ⇒ 那个"0ms 不请求"是 **60 秒串行失败冷却**，**不是永久状态**。
 *     新 client 天然没有这个字段（`:119` 构造为 `null`），重建确实能绕过 ——
 *     但**不需要**绕过，等够 60 秒它自己就绕过了。
 *
 * 源码事实（`@supabase/auth-js@2.116.0`，`dist/main/GoTrueClient.js`）：
 *   - 短路条件 = 实例字段 `lastRefreshFailure`，**按 refresh token 字符串**为键
 *   - 清除条件 = 冷却到期 / 传入**不同**的 refresh token / 刷新**成功**
 *   - `refreshSession()` 走**同一条** `_callRefreshToken`（`:3229`），**不绕过**冷却
 *
 * ## ⇒ 真正还没答的问题（下一轮）
 *
 * 原来那个"永久中毒"的结论倒了，**6b 仍然没证成**，但问题变成了：
 *
 *   > heal 之后**到底有没有** probe 落在冷却窗口**之外**？
 *
 * `AUTH_RETRY_BACKOFF_MS` 的累计时点是 2 / 7 / 22 / 52 / 112 / 172 秒。
 * 冷却从**每次真实失败**起算 60 秒，而缓存命中**不续期**。所以理论上
 * T+112s 那次就该发真实请求 —— 除非它之前每次都在**续期**。
 * 另外本场景注入的是**"慢"**（12s 后照常成功）而不是 503：那种形状下底层刷新
 * **最终会成功**、缓存根本不会被写入，行为可能与上面的 503 实验不同。
 * 这条**必须用新 telemetry 在打包态实测**，不能再靠推理。
 */
test('场景 6b：会话检查**暂时**失败后网络恢复 ⇒ 不重启客户端也能自愈（端到端）', async () => {
  test.setTimeout(30 * 60_000);
  test.skip(!provision, '同上');
  await stopAll();

  const proxy = await startAuthFaultProxy(provision!.supabaseUrl);
  // ⭐ 主 6b 用 **fail-before-upstream**：请求到代理为止，**绝不转发上游**。
  //    这才是"后端不可达/网络瞬断"的忠实模型 —— 上游没被碰到 ⇒ token 不会被消费。
  //    （默认的 `slow` 会转发并让上游成功，那是 response-loss，属于独立的 6c。）
  proxy.setMode('fail-before-upstream');
  // ⭐ 会话落盘的**外部**观察器（不解密、只记"写了几次、什么时候"）。
  //    它回答的是 2B 最后一个没证成的分支：heal 之后 SDK 到底有没有把新会话写下去。
  //    必须在 provision 之后、app 启动之前建立基线，所以走 `afterProvision`。
  let store: SessionStoreWatcher | null = null;
  // ⚠️ 必须包一层函数再读：`store` 是在 `afterProvision` **回调里**赋值的，
  //    直接 `if (store)` 会被 TS 的控制流分析判成 `never`（它看不到回调里的赋值）。
  const printStore = (label: string): void => {
    if (!store) return;
    console.log(`[6b] ======== ${label} ========`);
    console.log(store.report());
  };
  const stopStore = (): void => {
    store?.stop();
  };
  /** 观察到的持久化写入次数（只说明"写没写"，不说明写的是哪个 token）。 */
  const storeChanges = (): number => store?.changes().length ?? 0;
  try {
    const { userDataDir, browser, page } = await bootConfigured('selfheal', {
      supabaseUrlOverride: proxy.url,
      afterProvision: (dir) => {
        store = watchSessionStore(dir);
      },
    });
    try {
      // ---- 身份：恢复前后必须是**同一个 app 进程**（否则"自愈"可能是靠重启蒙的）
      const appPidBefore = app?.proc.pid ?? null;
      const procsBefore = nodeProcesses().map((p) => p.pid);
      console.log(`\n[6b] app PID=${appPidBefore}  userData=${userDataDir}`);

      // ---- 阶段一：确认真的进入了"暂时问不出来"
      // ⚠️ 用**轮询**而不是 sleep：注入的是"慢"（12s 才回），客户端自己的 8s 窗口
      //    先到 ⇒ 我们判 transient。这一步只观察，不替产品做任何事。
      await expect
        .poll(
          () => {
            const probes = authProbes(userDataDir);
            return probes.some((p) => String(p.data?.verdict ?? '') === 'transient');
          },
          { timeout: 240_000, intervals: [2_000] },
        )
        .toBe(true);

      // 起点以「最后一次**真实失败**的刷新请求」为准 ——
      // lastRefreshFailure.expiresAt 就是那一刻写下的，不从进程启动算。
      const failedEvents = proxy.events().filter((e) => e.phase === 'failing');
      expect(failedEvents.length, `注入点没被真的打到过；${proxy.timeline()}`).toBeGreaterThan(0);

      // ⭐⭐ failing 相的 **invariant**：请求到了本地代理，但**一次都没转发给上游**。
      //     这一条钉死了"这是纯后端不可达，不是 ambiguous completion"。
      expect(proxy.totalHits(), 'failing 相没有任何请求到达代理').toBeGreaterThan(0);
      expect(proxy.failingHits(), 'failing 相计数为 0').toBeGreaterThan(0);
      expect(
        proxy.forwardedHits(),
        `failing 相竟然转发了 ${proxy.forwardedHits()} 次给上游 ⇒ 注入实现错误（模式=${proxy.mode()}）；${proxy.timeline()}`,
      ).toBe(0);
      expect(proxy.upstreamSuccessHits(), 'failing 相上游不该有成功').toBe(0);
      const lastFailed = failedEvents.at(-1)!;
      const healAt = Date.now();
      console.log(
        `[6b] 最后失败请求: #${lastFailed.seq} t=${lastFailed.tMs}ms ${lastFailed.method} ${lastFailed.pathname}`,
      );

      // ---- 阶段二：heal。之后**什么都不触发**，只观察产品自己的 bounded retry
      const atHeal = {
        total: proxy.totalHits(),
        failing: proxy.failingHits(),
        healthy: proxy.healthyHits(),
        tMs: Date.now(),
      };
      expect(atHeal.healthy, 'heal 当下不该已经有 healthy 请求').toBe(0);
      proxy.setFailing(false);
      console.log(
        `[6b] HEAL: total=${atHeal.total} failing=${atHeal.failing} healthy=${atHeal.healthy}（之后测试不主动触发任何 auth 调用）`,
      );

      // ---- 决定性断言（§8）：heal 之后**真的又有网络请求**
      //   ⚠️ 只用 totalHits / healthyHits。**永远不要**用 failingHits 推断 heal 后行为
      //   —— 它只在 failing 期间增长，heal 后必然冻住（旧结论就是被这个口径带偏的）。
      await expect
        .poll(() => proxy.totalHits() > atHeal.total && proxy.healthyHits() > 0, {
          timeout: 420_000,
          intervals: [2_000],
        })
        .toBe(true);

      const firstHealthy = proxy.events().find((e) => e.phase === 'healthy')!;
      const lastFailureToFirstHealthyMs = firstHealthy.tMs - lastFailed.tMs;
      console.log(
        `[6b] 第一个 healthy 请求: #${firstHealthy.seq} ${firstHealthy.method} ${firstHealthy.pathname}` +
          `（最后一次真实失败之后 ${(lastFailureToFirstHealthyMs / 1000).toFixed(1)}s；heal 之后 ${((Date.now() - atHeal.tMs) / 1000).toFixed(1)}s）`,
      );

      // ---- §7：双时间线 —— **先打证据再断言**，失败报告里也已经有完整时间线。
      const logEvents = readLogEvents(userDataDir);
      const t0 = new Date(logEvents[0] ? logEvents[0].ts : new Date().toISOString()).getTime();
      console.log('[6b] ======== 双时间线（probe × proxy）========');
      for (const p of authProbes(userDataDir)) {
        const t = ((new Date(p.ts).getTime() - t0) / 1000).toFixed(1);
        const d = p.data ?? {};
        console.log(
          '  T+' + t.padStart(7) + 's  probe  ' + String(d.verdict) + '  elapsed=' + String(d.elapsedMs) + 'ms',
        );
      }
      console.log(proxy.timeline());
      printStore('会话落盘（外部观察，未解密）');

      // ⭐ 光"代理看到了请求"还不够 —— 必须证明**真的转发到了上游、且上游成功了**。
      //    否则"自愈"可能只是代理自己在回话。等 SDK 内部重试跑完再断言。
      await expect
        .poll(() => proxy.forwardedHits() > 0 && proxy.upstreamSuccessHits() > 0, {
          timeout: 240_000,
          intervals: [2_000],
        })
        .toBe(true);
      console.log(
        `[6b] upstream 边界: forwarded=${proxy.forwardedHits()} upstreamSuccess=${proxy.upstreamSuccessHits()}`,
      );

      // ⭐ 稳定不变量：**只要观察到一次真实的健康刷新成功（upstream 2xx 的 /token），
      //    持久会话就必须留下写入证据**。
      //    ⚠️ 只断言"有写入"，**不断言次数、不断言内容、不断言是哪个 token**：
      //    「恰好写 1 次」「恰好 models=13」「恰好第 177 秒成功」都是环境值，不是产品契约。
      //    加 `healthyTokenOk` 前置条件是因为：若这次会话压根不需要刷新，就不会有写入。
      const healthyTokenOk = proxy
        .events()
        .some(
          (e) =>
            e.phase === 'healthy' &&
            e.pathname.includes('/auth/v1/token') &&
            e.upstreamStatus !== null &&
            e.upstreamStatus >= 200 &&
            e.upstreamStatus < 300,
        );
      if (healthyTokenOk) {
        await expect.poll(() => storeChanges(), { timeout: 30_000, intervals: [500] }).toBeGreaterThan(0);
        console.log(`[6b] 会话落盘证据: 观察到 ${storeChanges()} 次写入（只证明"有写入"，不证明是哪个 token）`);
      } else {
        console.log('[6b] 本次没有观察到健康刷新成功 ⇒ 不要求落盘证据');
      }

      // 健康的刷新至少打到过 /token **与** /user —— ⚠️ 必须**轮询等**，不能在第一个
      // healthy 请求刚出现时就查：`/token` 先到、`/user` 要等刷新回来才发。
      // 不绑死请求次数（SDK 内部重试次数未来可能变），只认"发生过"。
      await expect
        .poll(() => proxy.events().some((e) => e.phase === 'healthy' && e.pathname.includes('/auth/v1/token')), {
          timeout: 120_000,
          intervals: [2_000],
        })
        .toBe(true);
      await expect
        .poll(() => proxy.events().some((e) => e.phase === 'healthy' && e.pathname.includes('/auth/v1/user')), {
          timeout: 240_000,
          intervals: [2_000],
        })
        .toBe(true);

      // ---- §9：全程**不得**把"暂时问不出来"降级成"未登录"
      const allEvents = readLogEvents(userDataDir).map((e) => e.event);
      expect(allEvents, `把暂时失败说成了未登录：${allEvents.join(' → ')}`).not.toContain(
        'relay.bootstrap.unauthenticated',
      );

      // ---- §10：产品目标 —— relay 落地 + models 非空（不能只验"SDK 发了请求"）
      await expect
        .poll(
          () => {
            const evs = readLogEvents(userDataDir).map((e) => e.event);
            return evs.includes('relay.bootstrap.applied') || evs.includes('relay.bootstrap.already-applied');
          },
          { timeout: 240_000, intervals: [2_000] },
        )
        .toBe(true);

      const models = await waitForRelayModels(page, 1, 240_000);
      expect(models.relay.length, '网络恢复后商业模型仍然为空').toBeGreaterThan(0);

      // ---- §4：同一个进程 —— 没有偷偷靠重启恢复
      expect(app?.proc.pid ?? null, 'app 进程换了 ⇒ 恢复可能是靠重启蒙的').toBe(appPidBefore);
      const procsAfter = nodeProcesses().map((p) => p.pid);
      console.log(
        `[6b] 进程核对: app ${appPidBefore} → ${app?.proc.pid}；node ${procsBefore.length} → ${procsAfter.length}`,
      );

      console.log(
        `\n[6b] ✅ 自愈成立：代理总请求 ${atHeal.total} → ${proxy.totalHits()}（healthy ${proxy.healthyHits()}）；` +
          `models=${models.relay.length}；app 进程未变；全程无 unauthenticated`,
      );
      void healAt;
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    // ⭐ 无论 PASS / FAIL / 超时，**一定**把完整时间线打出来 ——
    //    上一轮就是只在"看到第一个 healthy"时打印，导致 #18/#19 之后发生了什么没留下证据。
    try {
      console.log('[6b] ======== FINAL proxy timeline ========');
      console.log(proxy.timeline());
      const ud = currentUserData;
      if (ud) {
        const evs = readLogEvents(ud);
        const t0 = new Date(evs[0] ? evs[0].ts : new Date().toISOString()).getTime();
        console.log('[6b] ======== FINAL probe/bootstrap timeline ========');
        for (const e of evs) {
          const isProbe = e.event === 'commercial.auth.probe';
          if (!isProbe && !e.event.startsWith('relay.bootstrap')) continue;
          const t = ((new Date(e.ts).getTime() - t0) / 1000).toFixed(1);
          let extra = '';
          if (isProbe && e.data) {
            const d = e.data;
            extra =
              '  ' +
              String(d.verdict) +
              ' ' +
              String(d.elapsedMs) +
              'ms ' +
              String(d.errorName) +
              '(' +
              String(d.errorStatus) +
              ')';
          }
          console.log('  T+' + t.padStart(7) + 's  ' + e.event + extra);
        }
      }
      console.log(
        '[6b] 计数: total=' +
          proxy.totalHits() +
          ' failing=' +
          proxy.failingHits() +
          ' healthy=' +
          proxy.healthyHits() +
          ' forwarded=' +
          proxy.forwardedHits() +
          ' upstreamSuccess=' +
          proxy.upstreamSuccessHits(),
      );
      printStore('FINAL 会话落盘');
    } catch (e) {
      console.warn('[6b] finally 打时间线失败（不影响结果）:', e);
    }
    stopStore();
    await stopAll();
    await proxy.close();
  }
});

// ---------------------------------------------------------------- 场景 6c（独立诊断）

/**
 * 6c：**ambiguous refresh completion / lost refresh response** —— 独立可靠性场景，
 * **不是**主 2B 的验收（那个是 6b）。
 *
 * 形状：`slow` 模式 —— 请求**到达并成功**了上游（Supabase 真的处理了这次 refresh），
 * 但客户端 8 秒窗口先到、**没收到成功响应**。之后客户端仍持有本地那份（可能已被
 * 上游 rotate 掉的）refresh token 继续重试。
 *
 * ## 为什么单拎出来
 *
 * 早先把它当主 6b 用，得到的"heal 后仍不恢复"被误读成"后端不可达恢复不了"。
 * 但它多了一层：**上游已经消费/轮换了那个 token**，客户端却不知道 —— 这是
 * response-loss 语义，与"请求压根没到"是两回事。现实网络里两者**都会**发生，
 * 所以留着它有意义，只是不能混进 2B 的验收口径。
 *
 * ## 已知的实测现象（2026-09-13，两轮）
 *
 *   - failing 相代理侧 **6 个请求全部 `→ 200 (12s)`** ⇒ 上游每次都成功。
 *   - heal 后**确有真实请求**（最后失败后 74.3s / 94.6s，越过 60s 冷却），
 *     但 `/auth/v1/user` 从未出现、`relay.bootstrap.applied` 从未出现。
 *
 * ## ⚠️ 还没证明的事（所以先 fixme，别下结论）
 *
 *   - upstream 每次 200 是否真的 rotate 出了**不同**的 refresh token？
 *   - Supabase 的 reuse window 在这个环境里实际是什么行为？
 *   - 当前 session 是否**真的**因此不可恢复，还是只是恢复得更慢？
 *
 * 回答这三个问题需要 token 的 **SHA-256 指纹**（只记指纹，绝不记原文），
 * 以及 Supabase 服务端的 rotation/reuse 语义（属 backend semantic，需官方依据）。
 */
test.fixme('场景 6c：刷新响应丢失（上游已处理、客户端超时）—— 独立可靠性诊断，非主 2B 验收', async () => {
  test.setTimeout(30 * 60_000);
  test.skip(!provision, '同上');
  // 形状：proxy.setMode('slow')（默认）→ 注入 → 判 transient → heal → **不重启**
  // 取证：记录每次请求/响应里 refresh token 的 sha256 前 12 位（**不记原文**）
  // 判据：heal 后是否出现 healthy + forwarded + upstreamSuccess，以及是否最终 applied
});

// ---------------------------------------------------------------- 场景 3
//
// ⚠️ 两条刻意的安排：
//   ① **排在最后** —— 这条依赖最脆的 UI 结构（Radix 二级菜单），而 `describe` 是
//      serial 的，它失败会**中止后面所有用例**；放末尾就不会带走 4/5 的结论。
//   ② **自带 profile**（走 `bootConfigured`），不复用场景 2 那个 ——
//      依赖别人的临时目录会让"单独跑这一条"变得不可能，上一版就是栽在这里
//      （中间隔着 4/5a/5b 三次换 profile，重启那步一直等不到网关，撞满超时）。

test('场景 3：UI 里**看得见并选得中**真模型（不是只有列表）', async () => {
  test.setTimeout(12 * 60_000);
  test.skip(!provision, '同上');
  await stopAll();

  const { browser, page } = await bootConfigured('ui', {});
  try {
    const models = await waitForRelayModels(page, 1, 180_000);
    expect(models.relay.length).toBeGreaterThan(0);
    // ⚠️ 每个动作都显式给 timeout：playwright 的 actionTimeout 默认是 **0（不超时）**，
    //    元素一旦不出现就会一直等到用例超时 —— 上一版就是这样拿到一个
    //    "Test timeout exceeded"，完全看不出卡在哪一步。
    await shot(page, 'stage2-03-boot.png');

    // 打开新任务 → 输入区（模型选择器在这里）
    await page.locator('button[aria-label="新任务"]').click({ timeout: 30_000 });
    await expect
      .poll(async () => (await page.locator('body').innerText()).includes('main'), { timeout: 30_000 })
      .toBe(true);

    // 模型下拉的触发器：里面那个 `span.max-w-36.truncate` 是它独有的形状
    const trigger = page.locator('button:has(span.max-w-36)').first();
    await trigger.waitFor({ state: 'visible', timeout: 30_000 });
    const before = (await trigger.innerText()).trim();

    await trigger.click({ timeout: 15_000 });

    // ⚠️ 菜单**是异步挂上去的**（Radix 有进出场动画）。这里必须**等元素出现**，
    //    不能只 `sleep(800)` —— 实测那个点上 `menuitem` 数还是 0，于是下面的
    //    展开循环一次都不跑，最后拿到一个"模型名没出现"的假失败。
    const subs = page.locator('[role="menuitem"][aria-haspopup="menu"]');
    await subs.first().waitFor({ state: 'visible', timeout: 20_000 });

    // 目标模型：**必须和当前不同**，否则"选中生效"验的就是个恒真命题。
    // ⚠️ 这里踩过一次：catalog 里 `name === id`，我加了个 `m.name !== m.id` 的过滤，
    //    结果把所有候选都筛掉了、悄悄 fallback 回 `relay[0]`（正好等于当前模型），
    //    用例"通过"了但什么都没证。所以下面**显式断言两者不同**，堵死这条路。
    // 不看下标（排序会变），按 name 找。
    const target = models.relay.find((m) => m.name !== before);
    if (!target) {
      // 「只有一个模型」本身就无法证明"切换"，这是**合理的失败**，不是环境问题。
      throw new Error(`中转目录里只有 "${before}" 一个模型，无法验证模型切换（需要一个不同的目标）`);
    }
    expect(target.name).not.toBe(before);
    console.log(`\n[2A] 场景3 before="${before}" target.id="${target.id}" target.name="${target.name}"`);

    // ⚠️ 菜单是**两级**的，叶子模型在二级里 —— Radix 不展开就**根本不渲染**。
    //    一级的分组名是**模型家族**（`modelFamilyLabel`：DeepSeek/Qwen/…），
    //    不是 provider —— 我第一版按 `clawrouter` 找，白等 15s。
    //    这里不猜组名：逐个展开一级，**用 aria-expanded 断言**它真的开了，
    //    再用 role 找叶子 —— 全程不看 `body.innerText`（会被 portal/重复文本骗）。
    const leaf = (): ReturnType<typeof page.getByRole> => page.getByRole('menuitem').filter({ hasText: target.name });
    let opened = false;
    const subCount = await subs.count();
    for (let i = 0; i < subCount; i++) {
      await subs.nth(i).hover({ timeout: 10_000 });
      await expect(subs.nth(i)).toHaveAttribute('aria-expanded', 'true', { timeout: 5_000 });
      if ((await leaf().count()) > 0) {
        opened = true;
        break;
      }
    }
    expect(opened, `展开了所有分组都没找到模型 ${target.name}`).toBe(true);

    // ⚠️ `animations: 'disabled'` **不是装饰**：菜单开着的时候 `page.screenshot()`
    //    会一直等页面"稳定"，实测直接挂满 30s —— 上一版用例超时就是它吃的。
    await expect(leaf().first()).toBeVisible({ timeout: 10_000 });
    await shot(page, 'stage2-03-picker.png');

    // ⭐ 叶子项文本**不是干净的模型名** —— 实测是 `"deepseek-v4-pro\nR\n1M"`
    //    （带 reasoning / 上下文徽章），所以 `getByText(name, {exact:true})` 必然点不中。
    //    用 role + hasText。
    await leaf().first().click({ timeout: 15_000 });
    await expect(leaf().first()).toBeHidden({ timeout: 15_000 }); // 菜单关掉了

    const after = (await trigger.innerText()).trim();
    console.log(`[2A] 场景3 选中后 trigger="${after}"`);
    // ⭐ 不是"列表出现了"，是**选中生效了**：输入区的模型标签变成目标模型
    await expect(trigger).toContainText(target.name, { timeout: 15_000 });
    await shot(page, 'stage2-03-selected.png');

    // ⭐⭐ 最后一块证据：**真的发一次请求**，证明用的是 B。
    //
    // 上面所有断言都只证明"按钮上写着 B"。按钮写着 B、请求却打到别处，是完全可能
    // 的（`presetModel` 没传下去 / 被 `agents.defaults.model` 盖掉 / 静默回落）。
    // 所以这里要**发一条真消息**，然后看**网关自己怎么记这次会话**。
    //
    // 证据取 `sessions.list`（`window.clawwork.listSessions` → 网关的 `sessions.list`
    // RPC）。它的每一行是 `GatewaySessionRow`，带 `model` / `modelProvider` /
    // `inputTokens` / `outputTokens`。选它而不是取客户端自己的 task metadata：
    // 后者是**我们写进去的**（写什么读什么，恒真），前者是**网关报的**。
    //
    // 一条会话模型同时排除两种假象：
    //   - **Default**：网关的默认模型是 `clawrouter/qwen3.5-27b`，它**不在** UI 的
    //     13 条中转目录里 —— 真回落到默认，这里读出来就是它。
    //   - **fallback 回 A**：会话模型会原样留着 A。
    //
    // ⚠️ **不验回答的自然语言内容**（用户点名）—— 只认「状态 done + 产出了 token」，
    //    那才是"请求真的成功"，而且不依赖任何文案。
    //
    // ⚠️ 也**刻意不看 `chat.history` 的回包**（虽然它里面确实有 assistant 回复）：
    //    实测在消息刚发出的窗口里它可能长时间不回，而会话本身的状态/用量已经足够。
    //    证据取更稳的那一个。
    /**
     * 带超时的 `page.evaluate`。
     *
     * ⚠️ **不是装饰**。踩过一次：消息发出去之后主进程不再回应 RPC，`page.evaluate`
     * 于是**永远 pending**，`expect.poll` 只能干等到用例超时；而当时给 poll 传的
     * 自定义 `message` 又把真实错误盖住了，最后报出来的是"一直没有 assistant 回复"
     * —— 完全指错方向（真实原因在别处）。有了护栏，卡住会**当场**报成"卡住"。
     */
    const evaluateWithin = async <T>(fn: () => Promise<T>, what: string, ms = 60_000): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const guard = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}：${ms}ms 没返回（主进程或网关卡住）`)), ms);
      });
      try {
        return (await Promise.race([page.evaluate(fn), guard])) as T;
      } catch (e) {
        // ⚠️ **必须把"抛异常"和"超时"分开报**。踩过一次：IPC/求值直接抛
        //    （浏览器里 `ReferenceError: xxx is not defined`）被我自己的 catch
        //    吞成"卡住"，于是往"网关挂了"的方向白查了好几轮。
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(msg.startsWith(`${what}：`) ? msg : `${what} 抛出异常：${msg}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const PROMPT = '你好';
    const composer = page.locator('textarea').first();
    await composer.waitFor({ state: 'visible', timeout: 30_000 });
    await composer.fill(PROMPT);
    const send = page.getByRole('button', { name: '发送', exact: true });
    // 发送键在 canSend 为假时是 disabled 的（`onInput` 才会更新）——
    // 直接点会静默什么都不做，所以先等它真的可点。
    await expect(send, '输入了内容发送键却不可点').toBeEnabled({ timeout: 15_000 });
    await send.click({ timeout: 15_000 });

    // 这次发出去的是**新建的任务**（上面点过"新任务"），profile 又是全新的
    // ⇒ 本地任务表里只会有这一条，不用去猜哪个是"刚发的"。
    const tasks = await evaluateWithin(async () => {
      const api = (window as unknown as { clawwork: { loadTasks: () => Promise<unknown> } }).clawwork;
      return (await api.loadTasks()) as { rows?: Array<{ id: string; sessionKey: string }> };
    }, 'loadTasks');
    const task = tasks.rows?.[0];
    if (!task?.sessionKey) throw new Error(`本地任务表里没有刚建的任务：${JSON.stringify(tasks)}`);

    // 网关自己记的这次会话：模型 + **这个模型是哪来的** + 真实用量。
    interface GwSession {
      key?: string;
      model?: string;
      modelProvider?: string;
      modelOverrideSource?: string;
      inputTokens?: number;
      outputTokens?: number;
      status?: string;
    }

    const sessionState = async (): Promise<GwSession | undefined> => {
      const res = await evaluateWithin(async () => {
        const api = (window as unknown as { clawwork: { listSessions: (gw: string) => Promise<unknown> } }).clawwork;
        return (await api.listSessions('local-runtime')) as { result?: { sessions?: GwSession[] } };
      }, 'listSessions');
      return res.result?.sessions?.find((s) => s.key === task.sessionKey);
    };

    // 等这一轮**真的跑完**：状态 done 且产出了 token。
    // 只等"模型字段变成 B"是不够的 —— 那只证明配置写进去了，没证明调用发生过。
    //
    // ⚠️ **刻意不用 `expect.poll`**。实测它会和 `page.evaluate` 打架：发送之后
    //    第一次求值就**根本没进渲染进程**（应用日志里那段时间 `sessions.list`
    //    一条都没有，而 `chat.send` 的回包是正常的）—— 于是 poll 干等到超时，
    //    报出来却像"网关卡死"。同样动作、同样时序，手写轮询没这个问题。
    //    断言强度不变：3 分钟等不到照样失败，且把**最后读到的状态**带出来。
    const waitDeadline = Date.now() + 180_000;
    let lastSeen = '（一次都没读到）';
    for (;;) {
      const s = await sessionState();
      lastSeen = s
        ? `model=${s.model ?? '(空)'} out=${s.outputTokens ?? 0} status=${s.status ?? '(空)'}`
        : '（网关的 sessions.list 里还没这个会话）';
      if (s && s.model && (s.outputTokens ?? 0) > 0 && s.status === 'done') break;
      if (Date.now() >= waitDeadline) throw new Error(`等了 3 分钟这次请求还没跑完；最后读到：${lastSeen}`);
      await new Promise((r) => setTimeout(r, 2_000));
    }

    const final = await sessionState();
    if (!final) throw new Error(`网关的 sessions.list 里没有这个会话 ${task.sessionKey}`);

    const usedModel = String(final.model ?? '');
    console.log(
      `[2A] 场景3 真实请求：gatewaySession model="${usedModel}" provider="${final.modelProvider ?? ''}" ` +
        `override=${final.modelOverrideSource ?? '?'} in=${final.inputTokens ?? 0} out=${final.outputTokens ?? 0} ` +
        `status=${final.status ?? '?'}`,
    );

    // 归一化去掉 provider 前缀（网关报的是 `clawrouter/<id>` 这种 ref）。
    const bare = usedModel.replace(/^[^/]+\//, '');
    expect(bare, `实际用的是 "${usedModel}"，不是选中的 "${target.id}"（Default 或回落都会长这样）`).toBe(target.id);
    expect(usedModel).not.toBe(before);
    // ⭐ `modelOverrideSource === 'user'`：这个模型是**用户选的那个覆盖**上来的，
    //    不是 `agents.defaults.model` 兜的 —— 这就是"不是 Default"的直接证据
    //    （网关的默认是 `clawrouter/qwen3.5-27b`，压根不在 UI 的 13 条里）。
    expect(final.modelOverrideSource, '会话模型不是用户覆盖来的（那就是默认值兜的）').toBe('user');
    // 真的调用了上游 —— 有输出 token 才说明这次不是空跑。
    expect(final.outputTokens ?? 0).toBeGreaterThan(0);

    await shot(page, 'stage2-03-request.png');
  } finally {
    await browser.close().catch(() => {});
    await stopAll();
  }
});
