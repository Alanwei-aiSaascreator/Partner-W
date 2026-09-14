# Demo main path (real activation) E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one packaged-mode Playwright spec that walks the demo main path — real OTP login → real licence-code entry in the UI → models appear without restart → one real message round trip with real model provenance.

**Architecture:** One small edit to `e2e/packaged/provision.ts` (make the licence key withholdable and read an extra optional dev-profile field), plus one new spec file that drives the app through its own UI. No product code changes.

**Tech Stack:** Playwright (CDP against a packaged Electron app), TypeScript, Node `fs`, the project's own packaged-E2E harness.

**Spec:** `docs/superpowers/specs/2026-09-14-demo-main-path-e2e-design.md` (commit `e851588`)

---

## File structure

| File                                           | Responsibility                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `e2e/packaged/provision.ts` (modify)           | Add `testLicenseKey` (optional dev-profile field) and `withoutLicenseKey` (option). Nothing else. |
| `e2e/packaged/demo-main-path.spec.ts` (create) | The whole rehearsal: login → activation → models → round trip → provenance.                       |

No new helpers: `harness.ts`, `provision.ts` and `../helpers/temp-root.ts` already cover launching, isolation and cleanup.

---

### Task 0: Owner prerequisite (blocking, human-only)

**Files:** none — this is a manual step in the owner's own profile.

- [ ] **Step 1: Mint one dedicated card**

```bash
cd "D:/Desktop/new project/mofang-compass"
export SUPABASE_URL="https://qiprqsdfolcffjawkrsm.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<值由本人持有>"
node scripts/gen-licenses.mjs --count 1 --sku "USB-标准版" --quota-points 5000 --max-activations 1
```

Expected: a `licenses-2026-09-14.csv` in the repo root containing one key. The agent must **not** be given this value in chat.

- [ ] **Step 2: Put the key into the local dev profile**

Edit `%APPDATA%\@clawwork\desktop\clawwork-config.json`, inside the existing `commercial` object, add:

```json
"testLicenseKey": "<那张卡的 key>"
```

Leave `testPhone` / `testOtp` as they are (already present and verified).

⚠️ The first run **permanently binds this card** to the test phone account's personal org. Never use a real customer card.

**Verification (no secret printed):**

```bash
node -e "const c=require(process.env.APPDATA+'/@clawwork/desktop/clawwork-config.json');console.log(JSON.stringify({hasTestLicenseKey:Boolean(c.commercial&&c.commercial.testLicenseKey)},null,2))"
```

Expected: `{ "hasTestLicenseKey": true }`

---

### Task 1: `provision.ts` — withholdable licence key + optional demo key

**Files:**

- Modify: `e2e/packaged/provision.ts`

- [ ] **Step 1: Add the optional field to the interface**

In `CommercialProvision` (currently ends with `testPhone?: string; testOtp?: string;`), add after `testOtp`:

```ts
  /**
   * Demo 主路径 E2E 专用：一张**专用的、未绑定的**测试卡（`gen-licenses.mjs` 产出）。
   *
   * ⚠️ 与 `testPhone` / `testOtp` **同一套纪律** —— 只存在于本机 dev profile，
   * **绝不进仓库**；缺了就让用例 **skip 并写明原因**，绝不当成 PASS。
   *
   * ⚠️ 别填正式客户卡：第一次跑会把这张卡**永久绑到测试手机号账号的个人 org**
   * （之后每次跑都是幂等的，不会重复占名额）。
   *
   * 正式产品代码**不依赖**这个字段（全仓只在 `e2e/packaged/` 里被读）。
   */
  testLicenseKey?: string;
```

- [ ] **Step 2: Read it in `readDevProvision()`**

Replace the destructuring line:

```ts
const { supabaseUrl, supabaseAnonKey, licenseKey, testPhone, testOtp } = cfg.commercial ?? {};
```

with:

```ts
const { supabaseUrl, supabaseAnonKey, licenseKey, testPhone, testOtp, testLicenseKey } = cfg.commercial ?? {};
```

Then extend the inline `cfg` type annotation so `testLicenseKey` type-checks — inside `let cfg: { … commercial?: { … } }`, add one line after `testOtp?: string;`:

```ts
      testLicenseKey?: string;
```

Then extend the returned object — replace:

```ts
    // 可选：没配就是 undefined ⇒ positive late-login 用例 skip（见 late-login.spec.ts）
    ...(testPhone && testOtp ? { testPhone, testOtp } : {}),
```

with:

```ts
    // 可选：没配就是 undefined ⇒ positive late-login 用例 skip（见 late-login.spec.ts）
    ...(testPhone && testOtp ? { testPhone, testOtp } : {}),
    // 可选：没配就是 undefined ⇒ 真实激活彩排用例 skip（见 demo-main-path.spec.ts）
    ...(testLicenseKey ? { testLicenseKey } : {}),
```

- [ ] **Step 3: Add the `withoutLicenseKey` option**

In `ProvisionOptions`, after `skipSession?: boolean;`, add:

```ts
  /**
   * 不写 `commercial.licenseKey` —— 让 App 起来时**名下没有卡**。
   *
   * 这是「真实激活」用例的地基：`provisionProfile()` 默认会把 dev profile 里
   * 那张卡写进去，那样 App 一启动就已经是"已授权"，`ActivationSection` 直接渲染
   * 已绑定态，**输入框根本不出现** —— 测的就不是激活了。
   */
  withoutLicenseKey?: boolean;
```

- [ ] **Step 4: Honour it in `provisionProfile()`**

Replace the `commercial` block of the written config:

```ts
    commercial: {
      supabaseUrl: opts.supabaseUrlOverride ?? p.supabaseUrl,
      supabaseAnonKey: p.supabaseAnonKey,
      licenseKey: p.licenseKey,
    },
```

with:

```ts
    commercial: {
      supabaseUrl: opts.supabaseUrlOverride ?? p.supabaseUrl,
      supabaseAnonKey: p.supabaseAnonKey,
      // ⚠️ `withoutLicenseKey` 只少这一个字段。supabaseUrl / anonKey / deviceId
      //    仍然照写 —— 客户端**没有内置** Supabase 地址（全仓只有
      //    `config?.commercial?.supabaseUrl ?? ''` 一处读取，且 `commercial:set-config`
      //    没有界面调用方），那是产品本身的带外配置，不是"绕过激活"。
      //    licenseKey 是**唯一**一个能替代激活的东西，所以只收它。
      ...(opts.withoutLicenseKey ? {} : { licenseKey: p.licenseKey }),
    },
```

- [ ] **Step 5: Report its presence in `describeProvision()`**

After `lateLoginTestAccount: p.testPhone && p.testOtp ? 'configured' : 'missing',` add:

```ts
    demoLicenceKey: p.testLicenseKey ? 'configured' : 'missing',
```

(Boolean only — never the value.)

- [ ] **Step 6: Type-check**

Run:

```bash
cd "D:/Desktop/new project/mofang-compass/mofang-compass-desktop"
pnpm typecheck:e2e
```

Expected: exits 0, no output. If it reports errors, check whether any are in `e2e/packaged/provision.ts` — errors elsewhere are pre-existing; report them, do not fix them.

- [ ] **Step 7: Commit**

```bash
git add e2e/packaged/provision.ts
git commit -m "test(e2e): let provisioning withhold the licence key

Adds an optional commercial.testLicenseKey read from the local dev
profile, and a withoutLicenseKey option so a spec can start the app with
commercial configured but no card. Without it the app boots already
licensed and the activation form never renders."
```

---

### Task 2: the rehearsal spec

**Files:**

- Create: `e2e/packaged/demo-main-path.spec.ts`

- [ ] **Step 1: Write the file**

Create `e2e/packaged/demo-main-path.spec.ts` with exactly this content:

```ts
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

test.beforeAll(() => {
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
    // ⚠️ 不勾这个，提交键**永远是 disabled**（实测过：点了静默什么都不做）
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

    // ---- ⑦ 新任务 + 一条真实消息
    await page.locator('button[aria-label="新任务"]').click({ timeout: 30_000 });
    const composer = page.locator('textarea').first();
    await composer.waitFor({ state: 'visible', timeout: 30_000 });
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

    // ---- ⑧ ⭐ 真实往返：网关侧这一轮真的跑完了、真的产出了 token
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

    // ---- ⑨ ⭐ 真实 provenance：网关 ↔ UI 徽章 ↔ sqlite，三处对齐
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

    // ---- ⑩ 收尾：卡真的落到了本地配置（还是**产品自己**写的）
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
```

- [ ] **Step 2: Type-check**

```bash
cd "D:/Desktop/new project/mofang-compass/mofang-compass-desktop"
pnpm typecheck:e2e
```

Expected: exits 0, no output.

- [ ] **Step 3: Lint**

```bash
pnpm exec eslint e2e/packaged/demo-main-path.spec.ts --max-warnings 0
```

Expected: exits 0, no output.

- [ ] **Step 4: Format**

```bash
pnpm exec prettier --write e2e/packaged/demo-main-path.spec.ts
```

Expected: `e2e/packaged/demo-main-path.spec.ts <n>ms` (rewritten). Run this **before** committing, so the pre-commit `lint-staged` hook rewrites nothing afterwards.

- [ ] **Step 5: Commit**

```bash
git add e2e/packaged/demo-main-path.spec.ts
git commit -m "test(e2e): rehearse the demo main path end to end

Drives real OTP login, real licence-code entry in the activation form,
and proves models appear without an app or gateway restart, followed by
one real message round trip whose model provenance agrees across the
gateway, the UI badge and sqlite.

Skips with an explicit message when the dev profile has no
commercial.testLicenseKey."
```

---

### Task 3: run the rehearsal

**Files:** none.

- [ ] **Step 1: Make sure nothing is holding gateway port 18789**

```bash
cd "D:/Desktop/new project/mofang-compass/mofang-compass-desktop"
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue | Select-Object OwningProcess"
```

Expected: no output. If a PID is listed, kill **that PID** (`taskkill //PID <pid> //T //F`) — never kill by image name; this machine runs other unrelated `node.exe` processes, and a leftover dev client's gateway outlives the app.

- [ ] **Step 2: Rebuild the packaged app only if product source changed**

Skip unless source was touched. This spec changes **no** product code, so a previously built `dist/win-unpacked` is fine. If you do need to rebuild:

```bash
pnpm --filter @clawwork/desktop build && npx electron-builder --win --dir
```

⚠️ `dist/win-unpacked` is a **snapshot of the last build** — testing after a source change without rebuilding silently tests the old code.

- [ ] **Step 3: Run just this spec**

```bash
pnpm test:e2e:packaged demo-main-path
```

Expected on success (read the console, not just the exit code):

```
[demo-path] 已请求验证码（target=+86…）
[demo-path] 登录成功，主界面已就绪
[demo-path] 激活前：网关目录 31 条，其中中转 0 条
[demo-path] 激活成功：sku=…，额度微积分=…
[demo-path] 模型出现：中转 13 条 / 目录 …
[demo-path] ✅ 主路径通过：…
[demo-path] ======== 激活/中转时间线 ========
  … relay.config-write-start …
  … relay.config-write-done {"attempt":1,"verified":true}
[demo-path] 主路径：真实 OTP 登录 → … → 真实往返  (PASS)
```

Duration: 10–15 minutes.

- [ ] **Step 4: If it reports `SKIPPED`**

Read the printed reason. `missing demo E2E licence key` means Task 0 was not done — **this is not a pass**. Fix Task 0 and re-run.

---

### Task 4: if it fails — triage, do not work around

**Files:** none.

- [ ] **Step 1: Never restart the app to "make it work"**

A restart makes the startup bootstrap re-apply the relay config and will _hide_ the very bug this rehearsal exists to find (`license.ts:196` — the activation path has no second safety net).

- [ ] **Step 2: Classify from the printed timeline**

| Symptom in the printed timeline                                   | Meaning                                                                                                                     |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| RPC succeeded, models stayed 0, `relay.config-no-gateway` present | At activation time no gateway client was connected (`getAllGatewayClients()` had no `isConnected` entry)                    |
| `relay.config-write-failed` with `kind=transport`                 | WS write failed (network/transport)                                                                                         |
| `relay.config-write-failed` with `kind=rejected`                  | Gateway rejected the patch (schema)                                                                                         |
| `relay.config-write-failed` with `kind=hash-conflict`             | Optimistic-lock conflict, retried up to 3 times                                                                             |
| `relay.config-write-done` with `verified:false`                   | `providerApplied()` read-back failed; the note at `relay-config.ts:214` explains the redaction trap that used to cause this |
| No `relay.*` events at all                                        | Activation never reached `configureRelay` — check `commercialLicenseStatus` and the UI bound state                          |

- [ ] **Step 3: Report the root cause and stop**

Report the failing step, the timeline excerpt and the classification. **Do not** fix product code on this branch — the spec says `feat/demo-main-path` ships tests only.

- [ ] **Step 4: Leave the evidence in place**

A failed run calls `markFailure()`, so `cleanupProfiles()` keeps the profile (session ciphertext, ndjson logs, gateway state, sqlite). Do not delete it by hand; the next run's `sweepStaleProfiles` handles retention. If the profile must be removed manually, use `safeRemoveTree` semantics only — `rm -rf` follows directory junctions inside the profile and has destroyed real directories in this project before.

---

## Self-review

**Spec coverage:** every section of `2026-09-14-demo-main-path-e2e-design.md` maps to a step — prerequisites → Task 0; `provision.ts` three edits → Task 1 Steps 1–5; selectors table → Task 2 Step 1; assertion matrix rows 1–10 → Task 2 Steps 1 (flow) and its inline comments; failure triage → Task 4; discipline (secrets, isolation, PID teardown, no product changes) → Task 2 code + Task 3 Step 1 + Task 4 Steps 1/3/4; acceptance criteria → Task 3 Steps 3–4.

**Placeholder scan:** no TBD/TODO; every code step carries complete code; every command carries its expected output.

**Type consistency:** `ModelSummary` and `sleep` are exported from `harness.ts` (verified at `harness.ts:20`, `harness.ts:291`); `readModels` returns `{ total, relay }`; `freshTrackedProfile` and `gatewayPid` are exported; `provisionProfile(userDataDir, p, opts)` matches the call; `ProvisionOptions.withoutLicenseKey` is defined in Task 1 Step 3 and used in Task 2 Step 1; `CommercialProvision.testLicenseKey` is defined in Task 1 Step 1 and read in Task 2 Step 1.

**Known judgement calls, flagged rather than hidden:**

- `commercialLicenseStatus` and `loadTasks` / `listSessions` are called over IPC. They are **read-only observations**, never substitutes for the behaviours under test — the activation itself goes through the form, and the login through the login page.
- `sqlite3` must be on `PATH` (the existing `provenance-live.spec.ts` already depends on it).
- The Supabase-side OTP rate limit could refuse an immediate re-run after a failed attempt; the printed `errorCode` distinguishes that from a real failure.
- `expect(baseline.total).toBeGreaterThan(0)` is a **deliberate** premise check, not decoration. Pre-activation `relay === 0` is only meaningful if the gateway was actually reachable and returning a catalogue; a bare `0` would also be produced by a gateway that never connected. If this assertion ever fails with `total: 0`, that is itself the finding (the gateway produced no catalogue at all before activation) — report it, and do **not** delete the check to make the run go green.
