import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupProfiles, freshTrackedProfile, freshUserData, markFailure, resetProfileLedger } from './harness.js';
import { resetE2ETempRootCache, safeRemoveTree } from '../helpers/temp-root.js';

/**
 * profile **收摊台账**（ledger）的回归测试。
 *
 * 跑法：`pnpm test:e2e:ledger`（或 `npx playwright test --project=packaged profile-ledger`）
 *
 * ## 为什么有这个文件（2026-09-13 真实漏网，不是假想）
 *
 * packaged suite 建了 **6** 个 profile，收摊只删掉 **5** 个。漏网的
 * `clawwork-2a-clean-WRtSp4`（634 MB / 36392 个文件）是**唯一**绕开 `bootConfigured`、
 * 自己手写创建流程的场景 1 —— 它调了 `freshUserData('clean')`，却**没有**跟一句
 * `trackProfile`，于是那个目录压根不在台账里，`cleanupProfiles()` 根本不知道有它。
 *
 * ⚠️ 这个 bug 的形状很坏：**它不会报错**。suite 全绿，只是盘上悄悄多 634 MB。
 * 所以修法不是"在场景 1 补一句 trackProfile"（下次换个场景还会忘），而是把 invariant
 * 收口进 helper —— `freshUserData` / `freshTrackedProfile` **创建即登记**。本文件钉住这条。
 *
 * ## ⚠️ 跑在 `node --test` 里不行（踩过，别再试）
 *
 * 两个独立的坑：① `node --test` 只做类型擦除，不把 `temp-root.js` 映射回 `temp-root.ts`
 * （`ERR_MODULE_NOT_FOUND`）；② 就算改成显式 `.ts`，`harness.ts` 里的 `__dirname` 在 ESM
 * 作用域下也不存在（`ReferenceError`）。所以本文件走 **Playwright** —— 与真实 suite
 * 同一个 transform、同一个模块实例，测的就是真跑的那份代码。
 *
 * ## ⚠️ 它会动**共享的**模块状态（`workers: 1` ⇒ 全 suite 同一个进程）
 *
 * 台账是 `harness.ts` 里的模块级数组，**跨 spec 文件存活**。所以本文件：
 *   - 每个用例前 `resetProfileLedger()`；跑完再清一次 —— 不给别的 spec 留脏状态
 *   - 全程只在 `CLAWWORK_E2E_TEMP_ROOT` 指向的 scratch 里建删，
 *     **绝不碰 `D:\clawwork-e2e-temp` 的真实 profile**、`%APPDATA%`、真实 runtime
 */

let scratch = '';
let prevRoot: string | undefined;

test.beforeAll(() => {
  // 把统一临时根临时指到一个 scratch：本文件建的 profile 只落在这里。
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-ledger-spec-'));
  prevRoot = process.env.CLAWWORK_E2E_TEMP_ROOT;
  process.env.CLAWWORK_E2E_TEMP_ROOT = scratch;
  resetE2ETempRootCache();
});

test.beforeEach(() => {
  // ⚠️ 不能省：别的 spec 失败会把 `anyTestFailed` 留成 true，而它是**跨文件**的模块状态，
  //    那会让 `cleanupProfiles()` 走"保留现场"分支、让本文件的断言无辜变红。
  resetProfileLedger();
});

test.afterAll(() => {
  resetProfileLedger();
  if (prevRoot === undefined) delete process.env.CLAWWORK_E2E_TEMP_ROOT;
  else process.env.CLAWWORK_E2E_TEMP_ROOT = prevRoot;
  resetE2ETempRootCache();
  if (scratch) safeRemoveTree(scratch);
});

/** 落在 scratch 里才算数（防止误指到真实根）。 */
function inScratch(p: string): boolean {
  return path.resolve(p).startsWith(path.resolve(scratch) + path.sep);
}

// ---------------------------------------------------------------- L1：漏网形状

test('L1. ⭐ 漏网形状：freshUserData("clean") 创建即登记 ⇒ 收摊删得掉', () => {
  // 这一行与 `commercial-activation.spec.ts` 场景 1 里那句**逐字相同** ——
  // 漏网的就是它：当时它后面没有 `trackProfile`。
  const dir = freshUserData('clean');

  expect(fs.existsSync(dir), 'profile 应当被创建出来').toBe(true);
  expect(inScratch(dir), `必须落在统一根下，实际：${dir}`).toBe(true);

  const res = cleanupProfiles();

  expect(res.removed, `收摊没删掉它（原因：${res.reason}）—— 这正是漏 634MB 的形状`).toEqual([dir]);
  expect(fs.existsSync(dir), '收摊后 profile 必须已经不在盘上').toBe(false);
});

test('L2. 多个场景 profile 一起建 ⇒ 收摊全部删掉（一个都不许漏）', () => {
  const dirs = ['active', 'authtransient', 'clean'].map((tag) => freshUserData(tag));
  for (const d of dirs) expect(fs.existsSync(d)).toBe(true);

  const res = cleanupProfiles();

  expect(res.removed.length, `应当删掉全部 ${dirs.length} 个，实际 ${res.removed.length}`).toBe(dirs.length);
  for (const d of dirs) {
    expect(fs.existsSync(d), `⛔ ${path.basename(d)} 没被删掉`).toBe(false);
  }
});

test('L3. freshTrackedProfile 同样创建即登记（packaged-runtime 走的入口）', () => {
  const dir = freshTrackedProfile('packaged');
  expect(path.basename(dir).startsWith('clawwork-packaged-')).toBe(true);
  expect(inScratch(dir)).toBe(true);

  const res = cleanupProfiles();

  expect(res.removed).toEqual([dir]);
  expect(fs.existsSync(dir)).toBe(false);
});

// ---------------------------------------------------------------- L4：失败要留现场

test('L4. 有失败 ⇒ 保留现场（不能把证据误删）', () => {
  const dir = freshUserData('authtransient');
  markFailure();

  const res = cleanupProfiles();

  expect(res.removed, '失败时一个都不该删').toEqual([]);
  expect(res.kept, '失败现场必须在保留清单里').toEqual([dir]);
  expect(fs.existsSync(dir), '⛔ 失败现场被删了').toBe(true);

  // 这条是测试自己的产物，不能留给磁盘；台账也要还给下一个用例干净状态。
  resetProfileLedger();
  safeRemoveTree(dir);
});

// ---------------------------------------------------------------- L5：防回归守卫

test('L5. 守卫：packaged 的 spec 不许绕过登记入口直接 freshProfile', () => {
  const dir = path.join(__dirname);
  const offenders: string[] = [];

  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.spec.ts')) continue;
    const src = fs.readFileSync(path.join(dir, file), 'utf-8');
    src.split('\n').forEach((line, i) => {
      // 只看代码行：注释里提到这个函数名不算违规。
      const code = line.split('//')[0] ?? '';
      if (/^\s*\*/.test(line)) return; // 块注释正文
      if (/\bfreshProfile\s*\(/.test(code)) offenders.push(`${file}:${i + 1}`);
    });
  }

  // 绕过 `freshUserData` / `freshTrackedProfile` 直接开目录 ⇒ 不会进台账 ⇒ 必然漏。
  expect(offenders, `这些地方绕过了登记入口（会漏 profile）：${offenders.join(', ')}`).toEqual([]);
});
