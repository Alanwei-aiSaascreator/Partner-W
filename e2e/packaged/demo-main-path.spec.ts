import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ARTIFACTS,
  cleanupProfiles,
  connect,
  ensureArtifacts,
  freshTrackedProfile,
  gatewayPid,
  launchApp,
  markFailure,
  portHasGateway,
  readModels,
  sleep,
  stopEverything,
  waitForGateway,
  waitForRelayModels,
  type LaunchedApp,
  type ModelSummary,
} from './harness.js';
import { sweepStaleProfiles } from '../helpers/temp-root.js';
import { maskPhone, provisionProfile, readDevProvision } from './provision.js';

/**
 * Demo 主路径彩排：**真实激活**。
 *
 * ## 为什么需要这一条（主路径上唯一没验证过的一环）
 *
 * 此前所有打包态用例都是 `provisionProfile()` 把 `commercial.licenseKey`
 * **带外写进配置** —— App 一启动就已经"已授权"，于是整条激活链从没被走过：
 *
 *   ActivationSection.submit()
 *     → IPC commercial:license-activate
 *     → activateLicense()
 *         → RPC activate_license
 *         → configureRelay(relayKey)
 *             → applyRelayConfig() → 网关 config.patch + **回读校验**
 *
 * ⚠️ 关键事实（`license.ts:196`）：激活路径**不调** `notifyCommercialSignedIn()`。
 * 模型出现**完全依赖 `configureRelay` 这一次写入**，没有第二道保险。
 * 它一旦静默失败（已观测到的形态是 `relay.config-no-gateway`，即激活那一刻
 * 没有连上的网关客户端），用户看到的就是「激活成功但一个模型都没有」，
 * 而且**必须重启客户端**才能恢复（重启后的 startup bootstrap 才会找到卡）。
 * 这正是本用例要排除的失败。
 *
 * ## 全程走真实 UI
 *
 * 不调 `commercialSendOtp` / `commercialVerifyOtp` / `commercialLicenseActivate`
 * 这些 IPC，不写 `clawwork-config.json` 的 `licenseKey`，不碰网关配置。
 * 测试只做两件事：**点界面** + **读证据**。
 *
 * ## 隐私纪律
 *
 * **绝不打印**：完整卡密、手机号（只许 `maskPhone()`）、OTP、token、session JSON。
 *
 * ## 前置（缺了就 skip，且**必须显式打印**）
 *
 * 本机 dev profile（`%APPDATA%\@clawwork\desktop\clawwork-config.json`）里要有
 * `commercial.testPhone` / `commercial.testOtp` / `commercial.testLicenseKey`。
 * 前两个是 Supabase 的 "Test phone numbers"；第三个是一张**专用未绑定的**测试卡。
 * 三者**都不进仓库**。
 */

const provision = readDevProvision();
const licenceKey = provision?.testLicenseKey ?? '';
const hasTestAccount = Boolean(provision?.testPhone && provision?.testOtp);

const CDP = 9412;
/** 固定中性文本：**不问"你是什么模型"** —— 模型自述会被历史回声带偏，不是证据。 */
const PROMPT = '只回复：收到';

let app: LaunchedApp | null = null;
let profileDir = '';
let workspaceDir = '';

async function stopAll(): Promise<void> {
  await stopEverything(app, profileDir);
  app = null;
}

/**
 * 截图。**永远走这个函数**，别直接 `page.screenshot()`。
 *
 * ⚠️ 三条实测教训（与 commercial-activation.spec.ts 同源）：
 *   ① `page.screenshot()` 会等页面"稳定"，而 `actionTimeout` 默认是 **0（不超时）**
 *      —— 页面只要有持续动画，它会一直等下去。
 *   ② 所以必须给 `timeout`。
 *   ③ **截图是产物，不是断言** ⇒ 失败只告警。让一张诊断图把整套用例带走不值。
 */
async function shot(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({ path: path.join(ARTIFACTS, name), animations: 'disabled', timeout: 20_000 });
  } catch (error) {
    console.warn(
      `[demo-path] 截图 ${name} 没拍成（**不影响成败**）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface LogEvent {
  ts: string;
  event: string;
  data?: Record<string, unknown>;
}

/** 读这个 profile 的结构化日志（按时间升序）。⚠️ 日志里不含任何密钥。 */
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

/** 走产品自己的 IPC（只用于**读证据**，不用于替代任何被验证的行为）。 */
async function callIpc<T>(page: Page, fn: string, args: unknown[]): Promise<T> {
  return (await page.evaluate(
    async ({ fn: name, args: a }) => {
      const api = (window as unknown as { clawwork: Record<string, (...xs: unknown[]) => Promise<unknown>> }).clawwork;
      return await api[name]!(...a);
    },
    { fn, args },
  )) as T;
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
  outputTokens?: number;
  status?: string;
}

/**
 * 等**网关目录真的连上了**（`total > 0`）。
 *
 * ⚠️ 这一步不能省：没激活时 `relay` 本来就是 0，直接断言"0"是**空的 0** ——
 *    网关还没连上时它同样是 0。只有先确认 `total > 0`（网关返回了 openclaw
 *    的全量目录），"relay === 0" 才真的等价于「没有中转模型」。
 */
async function waitForGatewayCatalog(page: Page, timeoutMs = 180_000): Promise<ModelSummary> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const summary = await readModels(page);
    if (summary.total > 0) return summary;
    if (Date.now() >= deadline) return summary;
    await sleep(5_000);
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  // ⚠️ 起测前 18789 必须是**空的**。实测：dev 客户端的网关会**活过 app 变成孤儿**，
  //    而端口被占时 `waitForGateway()` 会**立刻**返回 true —— 但那是**别人的**网关。
  //    于是后面每一步都在跟一个不属于本 profile 的网关打交道：
  //    「激活前 relay=0」可能假成立、「模型出现」可能来自别人的配置 ——
  //    这种失败**看起来像通过**，所以宁可在这里直接失败。
  expect(await portHasGateway(), '起测前 18789 被占用：先关掉占用它的客户端/网关（按 PID 杀，别按名全杀）').toBe(false);

  ensureArtifacts();
  const swept = sweepStaleProfiles({ log: (m) => console.log(m) });
  if (swept.removed.length > 0) console.log(`[e2e-clean] 启动清扫：删了 ${swept.removed.length} 个旧 profile`);
});

// eslint-disable-next-line no-empty-pattern -- Playwright 要求第一个参数是解构模式，这里不需要任何 fixture
test.afterEach(({}, testInfo) => {
  if (testInfo.status !== 'passed' && testInfo.status !== 'skipped') markFailure();
});

test.afterAll(async () => {
  await stopAll();
  const res = cleanupProfiles();
  console.log(`[e2e-clean] ${res.reason}：删了 ${res.removed.length} 个，留了 ${res.kept.length} 个`);
});

test('Demo 主路径：真实 OTP 登录 → UI 输入真卡密 → 激活成功 → 模型出现 → 真实往返', async () => {
  test.setTimeout(30 * 60_000);
  test.skip(!provision, '开发机上没有可搬运的商业身份（%APPDATA%\\@clawwork\\desktop）');

  // ⚠️ 缺卡就**跳过**，并把原因写死在这里 —— skip 绝不能被读成 PASS。
  //    单靠 `test.skip(reason)` 只在 HTML 报告里看得见，控制台只剩一行 "skipped"。
  if (!licenceKey) {
    console.log(
      '\n[demo-path] ⚠️ SKIPPED（**不是 PASS**）：missing demo E2E licence key —— ' +
        '本机 dev profile 未配置 commercial.testLicenseKey（用 scripts/gen-licenses.mjs 出一张专用卡后填进去）。' +
        '配好之后重跑本文件即可。\n',
    );
  }
  test.skip(!licenceKey, 'missing demo E2E licence key：本机 dev profile 未配置 commercial.testLicenseKey');
  if (!hasTestAccount) {
    console.log(
      '\n[demo-path] ⚠️ SKIPPED（**不是 PASS**）：missing demo E2E test account —— ' +
        '本机 dev profile 未配置 commercial.testPhone / commercial.testOtp。\n',
    );
  }
  test.skip(!hasTestAccount, 'missing demo E2E test account：本机 dev profile 未配置 commercial.testPhone / testOtp');

  const phone = provision!.testPhone!;
  const otp = provision!.testOtp!;

  // ⚠️ 登录页把国家码**写死成 +86**，并把输入规整成 11 位（`Login/index.tsx` 的
  //    `normalizePhone` 会 `slice(0, 11)`）。直接填 E.164 的 "+86…" 会被截成
  //    一串错号码 —— 必须先剥掉国家码再填。这不是产品 bug，是登录页只面向大陆号。
  const national = phone.replace(/^\+?86/, '').replace(/\D/g, '');
  expect(national, `testPhone 不是中国大陆号码（登录页写死 +86）：${maskPhone(phone)}`).toMatch(/^1[3-9]\d{9}$/);

  profileDir = freshTrackedProfile('demo-main');
  // ⚠️ **本 run 独占 workspace** —— 共享 workspace 会带上一次跑的任务，
  //    曾把"正向样本没建起来"误读成 bug。
  workspaceDir = path.join(ARTIFACTS, `e2e-workspace-demo-${process.pid}-${Date.now().toString(36)}`);

  // 商业层配好但**不给卡、不给会话** —— 这就是用户刚装完、还没登录没激活的状态
  provisionProfile(profileDir, provision!, {
    workspacePath: workspaceDir,
    skipSession: true,
    withoutLicenseKey: true,
  });

  const configPath = path.join(profileDir, 'clawwork-config.json');
  const readConfigFile = (): { commercial?: { licenseKey?: string } } =>
    JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { commercial?: { licenseKey?: string } };

  // ---- 前置①：起测时**没有**卡（否则 App 一启动就已授权，测的就不是激活）
  expect(readConfigFile().commercial?.licenseKey ?? '', '起测前 profile 里就不该有 licenseKey').toBe('');

  app = launchApp(profileDir, CDP);
  expect(await waitForGateway(), '网关没起来').toBe(true);
  const { browser, page } = await connect(CDP);
  const appPidBefore = app.proc.pid ?? null;
  const gwPidBefore = gatewayPid();
  expect(gwPidBefore, '拿不到网关 PID ⇒ PID 不变这条断言会退化').not.toBeNull();

  try {
    // ---- ① 真实登录页 + 真实 OTP（不 provision session 绕过）
    const phoneInput = page.locator('input[type="tel"]');
    await phoneInput.waitFor({ state: 'visible', timeout: 240_000 });
    await shot(page, 'demo-01-login.png');

    const agree = page.locator('input[type="checkbox"]');
    await expect(agree, '登录页没有同意勾选框').toBeVisible({ timeout: 30_000 });
    // ⚠️ 不勾这个，提交键**永远是 disabled**（点了静默什么都不做）
    await agree.check({ timeout: 15_000 });

    await phoneInput.fill(national);
    const sendCode = page.getByRole('button', { name: '获取验证码', exact: true });
    await expect(sendCode, '填了合法号码并勾了同意，发送键仍不可点').toBeEnabled({ timeout: 15_000 });
    await sendCode.click({ timeout: 15_000 });
    console.log(`[demo-path] 已请求验证码（target=${maskPhone(phone)}）`);

    const codeInput = page.locator('input[placeholder="验证码"]');
    await codeInput.waitFor({ state: 'visible', timeout: 90_000 });
    await codeInput.fill(otp);
    const signIn = page.getByRole('button', { name: '登录', exact: true });
    await expect(signIn, '填了验证码登录键仍不可点').toBeEnabled({ timeout: 15_000 });
    await signIn.click({ timeout: 15_000 });

    // ⚠️ 判据用「新任务」按钮 = LeftNav 渲染出来了，**不用** "Gateway 已重连"
    //    —— 那是个**瞬时 toast**，等它等于赌时机。
    await page.locator('button[aria-label="新任务"]').waitFor({ state: 'visible', timeout: 180_000 });
    console.log('[demo-path] 登录成功，主界面已就绪');
    await shot(page, 'demo-02-signed-in.png');

    // ---- 前置②：登录了但**还没激活** ⇒ 网关连上了，然而一个中转模型都没有
    const baseline = await waitForGatewayCatalog(page);
    expect(baseline.total, '网关目录一直为空 ⇒ 网关连接没起来，后面的"0"没有意义').toBeGreaterThan(0);
    expect(baseline.relay.length, '还没激活就有中转模型 ⇒ 前置不成立').toBe(0);
    console.log(`[demo-path] 激活前：网关目录 ${baseline.total} 条，其中中转 ${baseline.relay.length} 条`);

    // ---- ② 设置页 → 激活授权（**Settings 默认落在 general，必须点这个页签**）
    // ⚠️ 设置按钮的 aria-label 可能被"有新版本可用"顶掉（`hasUpdate` 三元），两个都认。
    const settingsBtn = page.locator('button[aria-label="应用设置"], button[aria-label="有新版本可用"]').first();
    await expect(settingsBtn, '左侧栏找不到设置按钮').toBeVisible({ timeout: 30_000 });
    await settingsBtn.click({ timeout: 15_000 });

    const activationTab = page.getByRole('button', { name: '激活授权', exact: true });
    await expect(activationTab, '设置页没有"激活授权"页签').toBeVisible({ timeout: 30_000 });
    await activationTab.click({ timeout: 15_000 });

    const keyInput = page.getByPlaceholder('授权码');
    await expect(keyInput, '激活表单没出现（是不是已经处于已绑定态？）').toBeVisible({ timeout: 30_000 });
    await shot(page, 'demo-03-activation-form.png');

    // ---- ③ 走真实输入框 + 真实按钮提交
    await keyInput.fill(licenceKey);
    const activateBtn = page.getByRole('button', { name: '激活', exact: true });
    await expect(activateBtn, '填了卡密激活键却不可点').toBeEnabled({ timeout: 15_000 });
    await activateBtn.click({ timeout: 15_000 });

    // ⭐ 成功判据 = **表单变成只读态**（`ActivationSection` 的 `licence?.activated`）
    //    它要求 `commercialAccountOverview` 真从服务端把绑定读回来 ——
    //    比"toast 闪一下"硬得多。
    await expect(page.getByText('已绑定授权'), '激活后没进到已绑定态').toBeVisible({ timeout: 180_000 });
    const boundDesc = (await page.getByText('当前账户已绑定').innerText()).trim();
    expect(boundDesc, '已绑定文案里没有 sku ⇒ 只渲染了本地缓存').toMatch(/当前账户已绑定\s*\S/);
    await shot(page, 'demo-04-activated.png');

    // 结构性旁证（**只读**）：服务端回来的状态里 sku / 额度都在
    const status = await callIpc<{
      ok: boolean;
      result?: { activated?: boolean; sku?: string | null; tokenQuotaMicros?: number };
    }>(page, 'commercialLicenseStatus', []);
    expect(status.ok, 'commercialLicenseStatus 读失败').toBe(true);
    expect(status.result?.activated, 'IPC 说没激活').toBe(true);
    expect(status.result?.sku ?? '', 'IPC 回来的 sku 是空的').not.toBe('');
    expect(Number(status.result?.tokenQuotaMicros ?? 0), '额度是 0 ⇒ 卡没真的生效').toBeGreaterThan(0);
    console.log(
      `[demo-path] 激活成功：sku=${String(status.result?.sku)}，额度微积分=${String(status.result?.tokenQuotaMicros)}`,
    );

    // ---- ④ ⭐ 模型出现，且**没有重启**
    const models = await waitForRelayModels(page, 1, 240_000);
    expect(models.relay.length, '激活后 4 分钟仍没有中转模型').toBeGreaterThan(0);
    expect(app?.proc.pid ?? null, 'app 进程换了 ⇒ 恢复可能是靠重启蒙的').toBe(appPidBefore);
    expect(gatewayPid(), '网关被重启了 ⇒ 配置可能是靠重启网关才生效的').toBe(gwPidBefore);
    console.log(`[demo-path] 模型出现：中转 ${models.relay.length} 条 / 目录 ${models.total} 条`);

    // ---- ⑤ 旁证：网关配置里真的写了 clawrouter，且指向 /relay
    const gwConfigPath = path.join(profileDir, 'openclaw-state', 'openclaw.json');
    await expect
      .poll(
        () => {
          try {
            const cfg = JSON.parse(fs.readFileSync(gwConfigPath, 'utf-8')) as {
              models?: { providers?: Record<string, { baseUrl?: string }> };
            };
            return String(cfg.models?.providers?.clawrouter?.baseUrl ?? '');
          } catch {
            return '';
          }
        },
        { timeout: 60_000 },
      )
      .toContain('/relay');

    // ---- ⑥ 侧证据：中转配置这条链**一路是通的**，没有静默失败
    const events = readLogEvents(profileDir);
    const names = events.map((e) => e.event);
    expect(names, '激活时没有连上的网关（配置根本没写机会）').not.toContain('relay.config-no-gateway');
    expect(names, '中转配置写入失败').not.toContain('relay.config-write-failed');
    expect(names, '中转配置读回失败 ⇒ 无法确认是否生效').not.toContain('relay.config-verify-read-failed');
    expect(
      events.some((e) => e.event === 'relay.config-write-done' && e.data?.verified === true),
      '没有任何一次**回读校验通过**的配置写入',
    ).toBe(true);

    // ---- ⑦ 专业任务模板：只填草稿，绝不偷偷发送
    await page.locator('button[aria-label="新任务"]').click({ timeout: 30_000 });

    // 主路径显式选内容助手，后面两个 preset 才有业务语义。
    const contentAssistant = page
      .getByRole('list', { name: '我的助手', exact: true })
      .getByRole('button', { name: '内容创作', exact: true });
    await expect(contentAssistant, '七个内置助手中没有内容创作').toBeVisible({ timeout: 180_000 });
    await contentAssistant.click({ timeout: 30_000 });

    const composer = page.locator('textarea').first();
    await composer.waitFor({ state: 'visible', timeout: 30_000 });

    const tasksBeforeTemplates = await callIpc<{
      ok: boolean;
      rows?: Array<{ id: string; sessionKey: string }>;
      error?: string;
    }>(page, 'loadTasks', []);
    expect(tasksBeforeTemplates.ok, '模板操作前 loadTasks IPC 失败').toBe(true);
    expect(Array.isArray(tasksBeforeTemplates.rows), '模板操作前 loadTasks 没有返回 rows').toBe(true);
    expect(tasksBeforeTemplates.rows, '全新工作区在发送前不应有已落库任务').toEqual([]);
    const taskWorkbench = page.getByRole('region', { name: '内容创作', exact: true });
    const shortVideoPreset = taskWorkbench.getByRole('button', { name: /^短视频脚本\s*设计开场/ });
    await expect(shortVideoPreset, '内容助手没有短视频脚本入口').toBeVisible({ timeout: 30_000 });
    await shortVideoPreset.click({ timeout: 15_000 });
    await expect(composer, '短视频脚本模板没有写入草稿').toHaveValue(/短视频/);

    await composer.fill('必须保留的用户草稿');
    const rewritePreset = taskWorkbench.getByRole('button', { name: /^改写润色\s*保留原意/ });
    await expect(rewritePreset, '内容助手没有改写润色入口').toBeVisible({ timeout: 30_000 });
    await rewritePreset.click({ timeout: 15_000 });
    await page.getByRole('button', { name: '取消', exact: true }).click({ timeout: 15_000 });
    await expect(composer, '取消模板冲突后用户草稿被改动').toHaveValue('必须保留的用户草稿');

    await rewritePreset.click({ timeout: 15_000 });
    await page.getByRole('button', { name: '追加模板', exact: true }).click({ timeout: 15_000 });
    await expect(composer, '追加模板没有保留原草稿或没有加入改写指令').toHaveValue(/必须保留的用户草稿[\s\S]+请优化/);

    const currentSession = await page.evaluate(async () => {
      const session = await window.clawwork.commercialSession();
      return {
        ok: session.ok,
        signedIn: Boolean(session.result?.signedIn),
        hasUserId: Boolean(session.result?.profile?.userId.trim()),
      };
    });
    expect(currentSession.ok, '读取当前商业会话失败').toBe(true);
    expect(currentSession.signedIn, '当前商业会话未登录').toBe(true);
    expect(currentSession.hasUserId, '当前商业会话缺少 userId').toBe(true);

    const storedHistory = await page.evaluate(async () => {
      const prefix = 'partner-w:assistant-task-history:v1:';
      const session = await window.clawwork.commercialSession();
      const userId = session.result?.profile?.userId.trim() ?? '';
      const authReady = Boolean(session.ok && session.result?.signedIn && userId);
      if (!authReady) {
        return {
          authReady: false,
          matchingKeyCount: 0,
          hasOnlyExpectedKey: false,
          parseOk: false,
          isArray: false,
          recent: null as unknown,
        };
      }

      const expectedKey = `${prefix}${userId}`;
      const matchingKeys = Object.keys(window.localStorage).filter((candidate) => candidate.startsWith(prefix));
      const raw = window.localStorage.getItem(expectedKey);
      let parsed: unknown = null;
      let parseOk = false;
      if (raw !== null) {
        try {
          parsed = JSON.parse(raw) as unknown;
          parseOk = true;
        } catch {
          parseOk = false;
        }
      }

      return {
        authReady: true,
        matchingKeyCount: matchingKeys.length,
        hasOnlyExpectedKey: matchingKeys.length === 1 && matchingKeys[0] === expectedKey,
        parseOk,
        isArray: Array.isArray(parsed),
        recent: parsed,
      };
    });
    expect(storedHistory.authReady, '验证历史记录时商业会话已失效').toBe(true);
    expect(storedHistory.matchingKeyCount, '全新 profile 出现了多个账号的任务历史 key').toBe(1);
    expect(storedHistory.hasOnlyExpectedKey, '任务历史没有写入当前登录账号的精确 key').toBe(true);
    expect(storedHistory.parseOk, '当前账号的任务历史不是合法 JSON').toBe(true);
    expect(storedHistory.isArray, '当前账号的任务历史不是数组').toBe(true);

    const recent = storedHistory.recent as unknown[];
    const latestRecent = recent[0];
    expect(
      latestRecent !== null && typeof latestRecent === 'object' && !Array.isArray(latestRecent),
      '最近使用的第一项不是对象',
    ).toBe(true);
    const latestRecentRecord = latestRecent as Record<string, unknown>;
    expect(typeof latestRecentRecord.presetId, '最近使用的 presetId 不是字符串').toBe('string');
    expect(typeof latestRecentRecord.usedAt, '最近使用的 usedAt 不是字符串').toBe('string');
    expect(
      typeof latestRecentRecord.usedAt === 'string' && Number.isFinite(Date.parse(latestRecentRecord.usedAt)),
      '最近使用的 usedAt 不是有效时间',
    ).toBe(true);
    expect(latestRecentRecord, '最近使用的第一项不是刚选的改写润色').toEqual({
      presetId: 'content:rewrite-polish',
      usedAt: expect.any(String),
    });
    expect(Object.keys(latestRecentRecord).sort(), '最近使用记录泄露了 prompt/草稿等多余字段').toEqual([
      'presetId',
      'usedAt',
    ]);

    // 模板点击只改输入框：任务未落库，页面也没有用户消息气泡。
    // 下面的 send.click() 仍是整条用例唯一一次真实/付费模型调用。
    const tasksAfterTemplates = await callIpc<{
      ok: boolean;
      rows?: Array<{ id: string; sessionKey: string }>;
      error?: string;
    }>(page, 'loadTasks', []);
    expect(tasksAfterTemplates.ok, '模板操作后 loadTasks IPC 失败').toBe(true);
    expect(Array.isArray(tasksAfterTemplates.rows), '模板操作后 loadTasks 没有返回 rows').toBe(true);
    expect(tasksAfterTemplates.rows, '点击任务模板意外创建了任务/触发了发送').toEqual([]);
    await expect(page.getByText('必须保留的用户草稿', { exact: true }), '草稿意外出现在消息区').toHaveCount(0);

    // ---- ⑧ 一条真实消息（本用例唯一的付费模型调用）
    await composer.fill(PROMPT);
    const send = page.getByRole('button', { name: '发送', exact: true });
    await expect(send, '输入了内容发送键却不可点').toBeEnabled({ timeout: 15_000 });
    await send.click({ timeout: 15_000 });

    // ⚠️ 点"新任务"**不落库**：tasks 行要等第一条消息发出去才有 ⇒
    //    id / sessionKey 只能在这之后轮询取。
    const waitForTask = async (): Promise<{ id: string; sessionKey: string }> => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const res = await callIpc<{ rows?: Array<{ id: string; sessionKey: string }> }>(page, 'loadTasks', []);
        const row = res.rows?.[0];
        if (row?.sessionKey) return row;
        if (Date.now() >= deadline) throw new Error('发出去 60 秒了，tasks 表里还是没有这个任务');
        await sleep(1_000);
      }
    };
    const task = await waitForTask();

    // ---- ⑨ ⭐ 真实往返：网关侧这一轮真的跑完了、真的产出了 token
    const waitTurnDone = async (): Promise<GwSession> => {
      const deadline = Date.now() + 180_000;
      let last = '（一次都没读到）';
      for (;;) {
        const res = await callIpc<{ result?: { sessions?: GwSession[] } }>(page, 'listSessions', ['local-runtime']);
        const s = (res.result?.sessions ?? []).find((x) => x.key === task.sessionKey);
        last = s
          ? `model=${s.model ?? '(空)'} out=${s.outputTokens ?? 0} status=${s.status ?? '(空)'}`
          : '（还没这个会话）';
        if (s && s.model && (s.outputTokens ?? 0) > 0 && s.status === 'done') return s;
        if (Date.now() >= deadline) throw new Error(`等了 3 分钟这轮还没跑完；最后读到：${last}`);
        await sleep(2_000);
      }
    };
    const session = await waitTurnDone();
    const gatewayModel = String(session.model).replace(/^[^/]+\//, '');

    // ---- ⑩ ⭐ 真实 provenance：网关 ↔ UI 徽章 ↔ sqlite，三处对齐
    const badges = page.getByTestId('model-badge');
    await expect(badges.first(), '消息上没有 model 徽章').toBeVisible({ timeout: 60_000 });
    // ⚠️ 徽章的**展示名**可能不等于 id ⇒ 用 `title`（原始 id）做铁证
    const badgeTitle = await badges.first().getAttribute('title');
    expect(badgeTitle, '徽章上没有 title ⇒ 拿不到真实模型 id').toBeTruthy();
    expect(badgeTitle, '徽章上的模型 != 网关记的模型').toBe(gatewayModel);

    const rows = queryDb<{ model: string | null }>(
      `SELECT model FROM messages WHERE task_id='${task.id}' AND role='assistant' ORDER BY timestamp`,
    );
    expect(rows.length, 'sqlite 里没有 assistant 行').toBeGreaterThan(0);
    expect(
      rows.map((r) => r.model),
      '库里存的模型和 UI / 网关对不上',
    ).toEqual(rows.map(() => gatewayModel));

    // ---- ⑪ 收尾：卡真的落到了本地配置（还是**产品自己**写的）
    expect(readConfigFile().commercial?.licenseKey ?? '', '激活成功后 licenseKey 没落盘').toBe(licenceKey);

    console.log(
      `\n[demo-path] ✅ 主路径通过：登录(真实 OTP) → 激活(${String(status.result?.sku)}) → ` +
        `中转模型 ${models.relay.length} 条 → 真实往返(model=${gatewayModel}, out=${session.outputTokens})；` +
        `app PID=${appPidBefore} 未变；gateway PID=${gwPidBefore} 未变`,
    );
    console.log('[demo-path] ======== 激活/中转时间线 ========');
    for (const e of events) {
      if (!e.event.startsWith('relay.') && !e.event.startsWith('commercial.')) continue;
      console.log(`  ${e.ts}  ${e.event}  ${JSON.stringify(e.data ?? {})}`);
    }
  } catch (error) {
    // 失败要能**一眼看出是哪一段**：把激活/中转这条链的日志整条打出来。
    console.error('[demo-path] ❌ 失败。relay / commercial 时间线：');
    for (const e of readLogEvents(profileDir)) {
      if (!e.event.startsWith('relay.') && !e.event.startsWith('commercial.')) continue;
      console.error(`  ${e.ts}  ${e.event}  ${JSON.stringify(e.data ?? {})}`);
    }
    throw error;
  } finally {
    await browser.close().catch(() => {});
    await stopAll();
    // ⚠️ 这里**只能告警，不能断言**：`finally` 里抛出的错误会**顶掉**原始失败，
    //    把"激活失败"变成"收摊后端口没空出来"，排查方向直接被带偏。
    if (await portHasGateway()) {
      console.warn('[demo-path] ⚠️ 收摊后 18789 仍被占用（**不影响本条结果**，但下次跑前要按 PID 清掉）');
    }
  }
});
