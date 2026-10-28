import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LANGUAGE_CODES } from '@clawwork/shared';

import { UNSAFE_TARGET_REASON } from '../src/main/repair/safe-fs.js';

/**
 * 修复码 ↔ 词表**一致性守卫**（2026-10-16，T35 残留）。
 *
 * ## 它挡的是什么
 *
 * 引擎（`src/main/repair/**`）只回**机器码**（`RepairMessage.code`）；界面用
 * `t(`settings.repair.code.${item.code}`)`（`features/repair/RepairPanel.tsx:66`）
 * 拼出人话。**引擎能产出的码**与**词表里的键**是两份独立的东西：
 *
 * - `check:i18n` 只走「词表 → 代码」方向，而 `t(`…${code}`)` 这种模板写法会被
 *   当成一个**动态前缀** `settings.repair.code.`（`scripts/lib/i18n-usage.mjs:35`），
 *   于是前缀下面**每个键**都被判成"有人用" —— 引擎新加一个码、词表没同步，
 *   门禁一点反应都没有，界面上就是一句机器话（`settings.repair.code.x.y`）。
 * - 这份守卫走的是**反方向**：把引擎**真的能产出**的码全枚举出来，逐个断言
 *   9 语言词表里都能查到它 —— 缺一个就红。
 *
 * ## 码的"真实来源"是**读源码**，不是凭印象列
 *
 * 引擎的码有三种来路，这里都从源码**推导**（不写死清单，否则清单自己会漂）：
 *   ① 字面量 `code: '...'`（含三元 `code: a ? 'x' : 'y'`）—— 逐行扫；
 *   ② 模板拼接：`` `lock.${verdict.kind}.${verdict.reason}` `` /
 *      `` `capability.${verdict.reason}` `` / `` `capability.block-${verdict.kind}` ``
 *      —— 把**判别联合类型**里的 kind/reason 抠出来展开；
 *   ③ `outcome()` 的 `` `apply.${reason}` `` —— reason 是三个 apply 函数
 *      `return { reason: '...' }` 里的字符串。
 *
 * ⚠️ 刻意**不**扫 `reason:` 的泛匹配：`classifyGatewayLock` 里 `reason: 'not-json'`
 *    是**锁**的 reason（拼进 `lock.*.*`），不是 apply 的 reason；只看 apply 函数体。
 *
 * ## 第二个方向：词表里**不该有**"孤儿键"
 *
 * 上面那条只挡「引擎产得出、词表没有」；反过来的漏洞是「**词表里有、引擎永远产不出**」
 * ——改码 / 删路径后留下的死键（例如曾经存在的 `apply.stale-plan`：`apply()` 对不在本轮
 * 计划里的动作是**直接过滤丢掉**，根本不回这个码）。这类键 `check:i18n` 同样抓不到
 * （`settings.repair.code.` 是动态前缀，下面**每个键**都被判成"有人用"），界面也不会上屏，
 * 于是只会在词表里长期腐烂。这一半断言 `词表键 ⊆ 引擎能产出的码`：两边的集合都从
 * **源码 / 词表**现场推导（不写死清单），任何一侧漂了就红。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const REPAIR_DIR = path.join(DESKTOP, 'src/main/repair');
const LOCALE_DIR = path.join(DESKTOP, 'src/renderer/i18n/locales');

const SOURCE_FILES = [
  'engine.ts',
  'safe-fs.ts',
  'skill-records.ts',
  'items/gateway-locks.ts',
  'items/plugin-paths.ts',
  'items/capability-block.ts',
  'items/environment.ts',
  'items/diagnostics-pack.ts',
].map((rel) => path.join(REPAIR_DIR, rel));

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** 所有会**上屏**的码的命名空间（修复工具只认这几个根）。 */
const CODE_ROOTS = /^(?:live|lock|plugin|capability|env|diagnostics|apply|skill)\./;

/** 抠出 `code: …` 行里所有字面量码（含三元里那两个）。 */
function literalCodes(source: string): string[] {
  const found: string[] = [];
  for (const line of source.split('\n')) {
    if (!/\bcode:/.test(line)) continue;
    for (const match of line.matchAll(/'([^']+)'/g)) {
      if (CODE_ROOTS.test(match[1])) found.push(match[1]);
    }
  }
  return found;
}

/** 从判别联合/返回语句里抠 `kind: 'X' … reason: 'a' | 'b'` 的配对。 */
function kindReasonPairs(source: string): Array<{ kind: string; reasons: string[] }> {
  const pairs: Array<{ kind: string; reasons: string[] }> = [];
  for (const match of source.matchAll(/kind:\s*'([\w-]+)'[^\n]*?reason:\s*([^\n}]+)/g)) {
    const reasons = [...match[2].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    if (reasons.length > 0) pairs.push({ kind: match[1], reasons });
  }
  return pairs;
}

/** 抠出某个函数的函数体（到下一个顶层 `export` 或文件末尾）。 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}`);
  if (start < 0) throw new Error(`找不到函数 ${name}（是不是改名/移文件了？）`);
  const rest = source.slice(start + 1);
  const next = rest.indexOf('\nexport ');
  return next < 0 ? rest : rest.slice(0, next);
}

/** 抠出某个 `export type X = …` 判别联合体（到下一个顶层 `export` 或文件末尾）。 */
function typeUnionBody(source: string, typeName: string): string {
  const start = source.indexOf(`export type ${typeName} =`);
  if (start < 0) throw new Error(`找不到类型 ${typeName}（是不是改名/移文件了？）`);
  const rest = source.slice(start + 1);
  const next = rest.indexOf('\nexport ');
  return next < 0 ? rest : rest.slice(0, next);
}

/** apply 家族：`apply.<reason>` 里的 reason 来自三个 apply 函数的 `return { reason: … }`。 */
function applyReasons(): string[] {
  const specs: Array<{ file: string; fn: string }> = [
    { file: 'items/gateway-locks.ts', fn: 'applyGatewayLockQuarantine' },
    { file: 'items/plugin-paths.ts', fn: 'applyPluginRebase' },
    { file: 'items/capability-block.ts', fn: 'applyCapabilityRewrite' },
  ];
  const reasons = new Set<string>();
  for (const { file, fn } of specs) {
    const body = functionBody(read(path.join(REPAIR_DIR, file)), fn);
    for (const match of body.matchAll(/reason:\s*'([^']+)'/g)) reasons.add(match[1]);
    // 主进程里 `reason: UNSAFE_TARGET_REASON`（safe-fs 的常量）也算一条产出。
    if (/reason:\s*UNSAFE_TARGET_REASON/.test(body)) reasons.add(UNSAFE_TARGET_REASON);
  }
  return [...reasons];
}

/** 引擎能产出的**全部**码（真实来源 = 源码）。 */
function emittedCodes(): Set<string> {
  const codes = new Set<string>();

  for (const file of SOURCE_FILES) {
    const source = read(file);
    for (const code of literalCodes(source)) codes.add(code);
    // ② lock.*.*（判别联合里的 kind+reason）
    if (file.endsWith('gateway-locks.ts')) {
      for (const { kind, reasons } of kindReasonPairs(typeUnionBody(source, 'GatewayLockVerdict'))) {
        for (const reason of reasons) codes.add(`lock.${kind}.${reason}`);
      }
    }
    // ② capability.<reason> 与 capability.block-<kind>
    if (file.endsWith('capability-block.ts')) {
      const verdict = typeUnionBody(source, 'CapabilityVerdict');
      // `capability.${verdict.reason}` —— reason 取 unavailable 那一支
      for (const match of verdict.matchAll(/kind:\s*'unavailable'[^\n]*?reason:\s*([^\n}]+)/g)) {
        for (const reason of match[1].matchAll(/'([^']+)'/g)) codes.add(`capability.${reason[1]}`);
      }
      // `capability.block-${verdict.kind}` —— 取 CapabilityVerdict 里**没被显式分支吃掉**的 kind
      const allKinds = new Set([...verdict.matchAll(/\bkind:\s*'([\w-]+)'/g)].map((m) => m[1]));
      const planBody = functionBody(source, 'planCapabilityBlocks');
      const handled = new Set([...planBody.matchAll(/verdict\.kind\s*===\s*'([\w-]+)'/g)].map((m) => m[1]));
      for (const kind of allKinds) {
        if (handled.has(kind)) continue;
        codes.add(`capability.block-${kind}`);
      }
    }
  }

  // ③ apply.<reason>
  if (read(path.join(REPAIR_DIR, 'engine.ts')).includes('`apply.${reason}`')) {
    for (const reason of applyReasons()) codes.add(`apply.${reason}`);
  }

  return codes;
}

function readLocale(lang: string): Record<string, unknown> {
  return JSON.parse(read(path.join(LOCALE_DIR, `${lang}.json`))) as Record<string, unknown>;
}

/** 按 `.` 逐段下钻取字符串叶（键里带 `.` 也照拆，与 i18next 的 keySeparator 一致）。 */
function lookupString(resource: Record<string, unknown>, key: string): string | null {
  let node: unknown = resource;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : null;
}

/**
 * 词表里 `settings.repair.code` 下的**全部叶键**（相对该前缀，如 `apply.rewritten`）。
 * 与引擎侧的 `emittedCodes()` 用同一套 `.` 分段口径，两边才能直接比。
 */
function vocabCodeKeys(resource: Record<string, unknown>): Set<string> {
  const settings = resource.settings as Record<string, unknown> | undefined;
  const repair = settings?.repair as Record<string, unknown> | undefined;
  const code = repair?.code as Record<string, unknown> | undefined;
  const keys = new Set<string>();
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object') walk(value as Record<string, unknown>, path);
      else keys.add(path);
    }
  };
  if (code) walk(code, '');
  return keys;
}

const LANGS = [...SUPPORTED_LANGUAGE_CODES];

describe('修复码一致性：引擎能产出的码 ⊆ 词表键（9 语言全覆盖）', () => {
  const codes = [...emittedCodes()].sort();

  it('守卫本身有效：真的把码枚举出来了（不是空集空转通过）', () => {
    expect(codes.length).toBeGreaterThanOrEqual(40);
    // 三种来路各点名一条，防止某一路提取器静默失效。
    for (const anchor of [
      'lock.stale.pid-gone', // ② 判别联合展开
      'capability.block-corrupt', // ② 另一支模板
      'apply.unsafe-target-link', // ③ apply 家族
      'env.mode-portable', // ① 字面量（三元里的第二个）
      'diagnostics.export', // ① 动作码
    ]) {
      expect(codes, `枚举里少了 ${anchor}（某一路提取器失效了）`).toContain(anchor);
    }
  });

  it(`⭐ 每个码在全部 ${LANGS.length} 个语言里都能查到 settings.repair.code.<码>`, () => {
    const missing: string[] = [];
    for (const lang of LANGS) {
      const resource = readLocale(lang);
      for (const code of codes) {
        if (lookupString(resource, `settings.repair.code.${code}`) === null) {
          missing.push(`${lang} → settings.repair.code.${code}`);
        }
      }
    }
    expect(missing, `引擎能产出、但词表里没有的码（会直接上屏成机器话）：\n${missing.join('\n')}`).toEqual([]);
  });

  it('反向对照：把码改坏一个，上面的断言必须能判出来（不是空转）', () => {
    const resource = readLocale('zh');
    expect(lookupString(resource, 'settings.repair.code.lock.stale.pid-gone')).not.toBeNull();
    expect(lookupString(resource, 'settings.repair.code.lock.stale.pid-goneX')).toBeNull();
  });
});

/**
 * 第二个方向：词表键 ⊆ 引擎能产出的码（无"孤儿键"）。
 *
 * 键的"可达性"同样**从源码推导**（复用 `emittedCodes()`）—— 不写死一份"允许的键"清单，
 * 否则清单自己会漂，等于没守。
 */
describe('修复码一致性：词表键 ⊆ 引擎能产出的码（无孤儿键）', () => {
  it('守卫本身有效：真的读到词表了（不是空集空转通过）', () => {
    const vocab = vocabCodeKeys(readLocale('zh'));
    expect(vocab.size).toBeGreaterThanOrEqual(60);
    // 点名几条不同命名空间的键，防止整片读空后静默通过。
    for (const anchor of ['lock.stale.pid-gone', 'capability.rewrite-block', 'apply.rewritten', 'env.mode-portable']) {
      expect(vocab, `词表里少了 ${anchor}（是不是读错层了？）`).toContain(anchor);
    }
  });

  it('zh 词表里每个键都能被引擎某条路径产出（9 语言键位对等由 check:i18n 兜底）', () => {
    const vocab = vocabCodeKeys(readLocale('zh'));
    const emitted = emittedCodes();
    const orphans = [...vocab].filter((key) => !emitted.has(key)).sort();
    expect(
      orphans,
      `词表里有、但引擎任何路径都产不出的孤儿键（要么删键、要么证明它可达）：\n${orphans.join('\n')}`,
    ).toEqual([]);
  });

  it('反向对照：多出来的键必须被判成孤儿（提取器不是空转）', () => {
    const vocab = vocabCodeKeys(readLocale('zh'));
    const emitted = emittedCodes();
    const withFake = [...vocab, 'apply.this-code-cannot-be-emitted'];
    const orphans = withFake.filter((key) => !emitted.has(key)).sort();
    expect(orphans).toEqual(['apply.this-code-cannot-be-emitted']);
  });
});
