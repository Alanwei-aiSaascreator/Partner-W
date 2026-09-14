import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  ARTIFACTS,
  cleanupProfiles,
  connect,
  ensureArtifacts,
  freshUserData,
  gatewayPid,
  launchApp,
  markFailure,
  nodeProcesses,
  portHasGateway,
  readModels,
  stopEverything,
  waitForGateway,
  waitForRelayModels,
  type LaunchedApp,
} from './harness.js';
import { sweepStaleProfiles } from '../helpers/temp-root.js';
import { readDevProvision, provisionProfile, maskPhone } from './provision.js';

/**
 * Stage 2C：**登录发生在 App 启动之后** ⇒ 不重启客户端也要把中转配置落下去。
 *
 * ## 要证的洞
 *
 * 启动路径只在 `main/index.ts` 里 bootstrap **一次**。启动时没登录 ⇒ 结论
 * `unauthenticated`，而按设计「明确没登录」**不重试**（等多久都一样，这是 2B 的
 * 既有语义，2C 不动它）。可用户随后就在登录页完成了 OTP —— 那一刻如果不主动
 * 重新调度，中转配置永远不会落到网关，模型列表一直是空的，**用户必须重启客户端**。
 *
 * ## 这一轮的三条证据
 *
 * | 场景 | 证什么 |
 * |---|---|
 * | ① 负对照 A+B | 未登录是**终态**：不反复 bootstrap、不靠 2B 退避刷服务端；`verifyOtp` 失败**不**触发 |
 * | ② positive | 真实 OTP 登录成功 ⇒ **不重启** ⇒ 补跑一次 ⇒ applied ⇒ models > 0，且 APP_PID 不变 |
 *
 * ## ⚠️ 测试账号纪律
 *
 * ②需要 Supabase 控制台里配的**测试手机号 + 固定验证码**（Supabase 的
 * "Test phone numbers" 功能）。它只存在于**本机** dev profile
 * （`%APPDATA%\@clawwork\desktop\clawwork-config.json` 的 `commercial.testPhone` /
 * `commercial.testOtp`），**不进仓库、不进源码**。没配 ⇒ ② **skip 并写明
 * "missing late-login E2E test account"**，**绝不当成 PASS**。
 *
 * **绝不打印**：手机号全文、OTP、access/refresh token、Authorization、session JSON。
 * 日志里要标识手机号时只允许 `maskPhone()`。
 */

const provision = readDevProvision();
const CDP = 9401;
const WORKSPACE = path.join(ARTIFACTS, 'e2e-workspace');

let app: LaunchedApp | null = null;
let currentUserData = '';

async function stopAll(): Promise<void> {
  await stopEverything(app, currentUserData);
  app = null;
}

/** 起一个**没有会话**的隔离 profile（=「配了商业层但没登录」）。 */
async function bootWithoutSession(tag: string) {
  const userDataDir = freshUserData(tag);
  provisionProfile(userDataDir, provision!, { workspacePath: WORKSPACE, skipSession: true });
  currentUserData = userDataDir;
  app = launchApp(userDataDir, CDP);
  expect(await waitForGateway(), '网关没起来').toBe(true);
  const { browser, page } = await connect(CDP);
  return { userDataDir, browser, page };
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
        const d = JSON.parse(line) as { ts?: string; event?: string; data?: Record<string, unknown> };
        if (d.ts && d.event) out.push({ ts: d.ts, event: String(d.event), data: d.data });
      } catch {
        /* 半行/坏行跳过 */
      }
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** `relay.bootstrap.trigger` 的 reason 列表（调度器每次被触发都会记一条）。 */
function triggerReasons(userDataDir: string): string[] {
  return readLogEvents(userDataDir)
    .filter((e) => e.event === 'relay.bootstrap.trigger')
    .map((e) => String(e.data?.reason ?? ''));
}

function eventNames(userDataDir: string): string[] {
  return readLogEvents(userDataDir).map((e) => e.event);
}

/** `relay.bootstrap.unauthenticated` 出现过几次（用来证明登录**之后**没有再来一次）。 */
function unauthenticatedCount(userDataDir: string): number {
  return eventNames(userDataDir).filter((e) => e === 'relay.bootstrap.unauthenticated').length;
}

/** 走产品自己的 IPC（= 登录页按的那些入口），不直接调主进程函数。 */
async function callIpc<T>(page: Page, fn: string, args: unknown[]): Promise<T> {
  return (await page.evaluate(
    async ({ fn: name, args: a }) => {
      const api = (window as unknown as { clawwork: Record<string, (...xs: unknown[]) => Promise<unknown>> }).clawwork;
      return await api[name]!(...a);
    },
    { fn, args },
  )) as T;
}

type IpcResult = { ok: boolean; result?: unknown; error?: string; errorCode?: string };

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  ensureArtifacts();
  const swept = sweepStaleProfiles({ log: (m) => console.log(m) });
  if (swept.removed.length > 0) console.log(`[e2e-clean] 启动清扫：删了 ${swept.removed.length} 个旧 profile`);
  fs.mkdirSync(WORKSPACE, { recursive: true });
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

// ---------------------------------------------------------------- ① 负对照

/**
 * A：未登录是**终态** —— 不反复 bootstrap、不靠 2B 退避反复打服务端。
 * B：`verifyOtp` **失败** ⇒ **不触发** `notifyCommercialSignedIn` ⇒ 不补跑 bootstrap。
 */
test('场景 2C-A/B：未登录不反复 bootstrap；verifyOtp 失败也不触发补跑', async () => {
  test.setTimeout(25 * 60_000);
  test.skip(!provision, '开发机上没有可搬运的商业身份（%APPDATA%\\@clawwork\\desktop）');

  const { userDataDir, browser, page } = await bootWithoutSession('late-neg');
  try {
    const appPidBefore = app?.proc.pid ?? null;

    // ---- 前置：确实进到了「配了商业层但没登录」
    await expect
      .poll(() => eventNames(userDataDir).includes('relay.bootstrap.unauthenticated'), { timeout: 240_000 })
      .toBe(true);
    expect(await portHasGateway(), '网关照常，不该被商业层拖死').toBe(true);

    const modelsBefore = await readModels(page);
    expect(modelsBefore.relay.length, '没登录就不该有中转模型').toBe(0);

    // ⭐ 负对照 A：明确没登录 ⇒ 一次就够，不许反复 bootstrap、也不许靠 2B 退避刷服务端
    expect(triggerReasons(userDataDir), '启动只该触发一次').toEqual(['startup']);
    expect(eventNames(userDataDir), '「明确没登录」不该进 2B 退避重试').not.toContain('relay.bootstrap.retry');

    // 静置一段时间，再看它有没有偷偷重来
    await page.waitForTimeout(45_000);
    expect(triggerReasons(userDataDir), '未登录期间不该冒出新的 bootstrap').toEqual(['startup']);
    expect((await readModels(page)).relay.length, '未登录期间 models 必须始终为 0').toBe(0);

    // ---- 负对照 B：**失败**的 verifyOtp 不许触发补跑
    // ⚠️ 用的是一个**合成的不存在号码** + 错验证码，只为逼出失败；它不是什么凭证，
    //    也不会真的发短信（不调 send-otp）。断言的是"失败 ⇒ 不调度"。
    const failed = await callIpc<IpcResult>(page, 'commercialVerifyOtp', ['+8613800000000', '000000']);
    expect(failed.ok, `根本不存在的号码不该验成功：${failed.errorCode ?? ''}`).toBe(false);

    await page.waitForTimeout(20_000);
    expect(triggerReasons(userDataDir), 'verifyOtp 失败却触发了补跑').toEqual(['startup']);
    expect(eventNames(userDataDir)).not.toContain('relay.bootstrap.applied');
    expect((await readModels(page)).relay.length).toBe(0);

    expect(app?.proc.pid ?? null, 'app 进程换了').toBe(appPidBefore);
    console.log(
      `\n[2C] 负对照通过：unauthenticated 为终态（trigger=${JSON.stringify(triggerReasons(userDataDir))}）` +
        `；verifyOtp 失败未触发补跑；models 始终 0；app PID=${appPidBefore} 未变`,
    );
  } finally {
    await browser.close().catch(() => {});
    await stopAll();
  }
});

// ---------------------------------------------------------------- ② positive

/**
 * ⭐ 主验收：**同一个 App 进程内**从「没登录」走到「模型可用」。
 *
 * 全程走**真实产品入口**：`commercial:send-otp` → `commercial:verify-otp`
 * → `verifyLoginOtp()` → `notifyCommercialSignedIn()` → `bootstrapCommercialRelay()`。
 * **不允许**测试直接调 `notifyCommercialSignedIn()` 来冒充登录。
 */
test('场景 2C：启动时未登录 ⇒ 用户 OTP 登录 ⇒ **不重启** 自动 applied + models > 0', async () => {
  test.setTimeout(30 * 60_000);
  test.skip(!provision, '开发机上没有可搬运的商业身份（%APPDATA%\\@clawwork\\desktop）');
  // ⚠️ 没配测试账号就**跳过**，并把原因写死在这里 —— skip 绝不能被读成 PASS。
  //    单靠 `test.skip(reason)` 只在 HTML 报告里看得见，控制台只剩一行 "skipped"，
  //    太容易被误读成"通过" ⇒ 额外显式打一行，让跑的人一眼看见。
  const hasTestAccount = Boolean(provision?.testPhone && provision?.testOtp);
  if (!hasTestAccount) {
    console.log(
      '\n[2C] ⚠️ SKIPPED（**不是 PASS**）：missing late-login E2E test account —— ' +
        '本机 dev profile 未配置 commercial.testPhone / commercial.testOtp（Supabase 的 Test phone numbers）。' +
        '配好之后重跑本文件即可。\n',
    );
  }
  test.skip(
    !hasTestAccount,
    'missing late-login E2E test account：本机 dev profile 未配置 commercial.testPhone / commercial.testOtp',
  );

  const phone = provision!.testPhone!;
  const otp = provision!.testOtp!;

  const { userDataDir, browser, page } = await bootWithoutSession('late-pos');
  try {
    const appPidBefore = app?.proc.pid ?? null;
    // ⭐ 网关 PID 也要在**登录前后**都记：2C 的整个卖点是"不重启就能把配置落下去"，
    //    而"重启"最直接的铁证就是网关 PID 变了。app PID 不变**不足以**排除
    //    "app 把网关杀掉重拉一遍"这种恢复路径。
    const gwPidBefore = gatewayPid();

    // ---- ① 登录前：未登录、models = 0、网关正常
    await expect
      .poll(() => eventNames(userDataDir).includes('relay.bootstrap.unauthenticated'), { timeout: 240_000 })
      .toBe(true);
    expect(await portHasGateway()).toBe(true);
    const modelsBefore = await readModels(page);
    expect(modelsBefore.relay.length, '登录前不该有中转模型').toBe(0);
    console.log(`[2C] 登录前：models=${modelsBefore.relay.length}（target=${maskPhone(phone)}）`);

    // ⚠️ 登录**之前**记一笔基线：启动那次 bootstrap 的结论就是 `unauthenticated`，
    //    它是**正确**的、且会永久留在 ndjson 里。所以登录后不能断言"它没出现过"
    //    （那条断言与本文件上面"等 unauthenticated 出现"的前提自相矛盾）。
    //    要证的是：登录**没有**再产生一次未登录结论 ⇒ 数量不涨。
    const unauthBefore = unauthenticatedCount(userDataDir);

    // ---- ② 走真实登录入口（和登录页按的是同一对 IPC）
    const sent = await callIpc<IpcResult>(page, 'commercialSendOtp', [phone]);
    expect(sent.ok, `sendOtp 失败：${sent.errorCode ?? ''}`).toBe(true);

    const verified = await callIpc<IpcResult>(page, 'commercialVerifyOtp', [phone, otp]);
    expect(verified.ok, `verifyOtp 失败：${verified.errorCode ?? ''}`).toBe(true);

    // ---- ③ 不重启、不做任何手工拼装：等产品自己补跑
    await expect.poll(() => triggerReasons(userDataDir).includes('signed-in'), { timeout: 60_000 }).toBe(true);
    await expect
      .poll(
        () =>
          eventNames(userDataDir).includes('relay.bootstrap.applied') ||
          eventNames(userDataDir).includes('relay.bootstrap.already-applied'),
        { timeout: 240_000 },
      )
      .toBe(true);

    const evs = eventNames(userDataDir);
    expect(evs, `把已登录说成未登录：${evs.join(' → ')}`).toContain('relay.bootstrap.authenticated');
    // 登录**之后**没有被判成未登录（启动那一次不算：它本来就没登录）
    expect(unauthenticatedCount(userDataDir), '登录之后又判了一次未登录').toBe(unauthBefore);

    // ⭐ 决定性：模型真的出现了，且**没有重启**
    const models = await waitForRelayModels(page, 1, 240_000);
    expect(models.relay.length, '登录后中转模型仍然为空').toBeGreaterThan(0);
    expect(app?.proc.pid ?? null, 'app 进程换了 ⇒ 恢复可能是靠重启蒙的').toBe(appPidBefore);
    // ⭐ 网关也没被重启过（app PID 不变挡不住"杀网关重拉"这条路）
    expect(gatewayPid(), '网关被重启了 ⇒ 配置可能是靠重启网关才生效的').toBe(gwPidBefore);
    expect((await readModels(page)).relay.length, '登录后网关仍应连着').toBeGreaterThan(0);

    const procsAfter = nodeProcesses().length;
    console.log(
      `\n[2C] ✅ late-login 自愈成立：models ${modelsBefore.relay.length} → ${models.relay.length}；` +
        `trigger=${JSON.stringify(triggerReasons(userDataDir))}；app PID=${appPidBefore} 未变；` +
        `gateway PID=${gwPidBefore} 未变；node 进程 ${procsAfter} 个`,
    );
    console.log('[2C] ======== bootstrap 时间线 ========');
    for (const e of readLogEvents(userDataDir)) {
      if (!e.event.startsWith('relay.bootstrap') && e.event !== 'commercial.relay.bootstrap') continue;
      console.log(`  ${e.ts}  ${e.event}  ${JSON.stringify(e.data ?? {})}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await stopAll();
  }
});
