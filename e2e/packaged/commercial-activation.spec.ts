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

async function bootConfigured(tag: string, opts: { supabaseUrlOverride?: string; skipSession?: boolean }) {
  // `freshUserData` 自己就把目录登记进收摊台账了 —— 别在这里再补 `trackProfile`
  // （登记只有一处，见 harness 里 `freshTrackedProfile` 的说明）。
  const userDataDir = freshUserData(tag);
  provisionProfile(userDataDir, provision!, { workspacePath: WORKSPACE, ...opts });
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
    console.log(`\n[2A] 场景5b 商业后端不可达：relayModels=${models.relay.length} gateway=up`);
  } finally {
    await browser.close().catch(() => {});
    await stopAll();
  }
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
