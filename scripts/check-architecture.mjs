import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

const root = process.cwd();
const violations = [];

function walk(relativeDir, predicate = () => true) {
  const absoluteDir = path.join(root, relativeDir);
  let entries;
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const next = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(next, predicate));
      continue;
    }
    if (predicate(next)) out.push(next);
  }
  return out;
}

function getLineCol(content, index) {
  const before = content.slice(0, index);
  const lines = before.split('\n');
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

function record(rule, filePath, content, rawMatch, message, match) {
  const offset = rawMatch[0].startsWith('\n') ? 1 : 0;
  const { line, column } = getLineCol(content, rawMatch.index + offset);
  violations.push({ rule, filePath, line, column, message, match });
}

const isCodeFile = (p) => /\.(ts|tsx|mts|cts)$/.test(p);

// 捕获组 2 = 模块说明符；组 1 = 语句里的 `type` 关键字（`import type {...}`），
// 未定义表示**值导入**。
//
// ⚠️ 组 1 是**可选**组：`import 'x'`（无 from）也匹配，此时组 1 是 undefined 而不是
//    空串 —— 判断一律写成 `m[1] === undefined`，别用 falsy 判断。
// ⚠️ 已知局限：`import` 与 `type` 分行写时组 1 捕不到，会被当成值导入报出来。
//    方向是**偏严**（只误报、不放过），且现有代码没有这种写法。
const importRE = /(?:^|\n)\s*(?:import|export)\s+(?:(type)\s+)?(?:[^'"`]*?\sfrom\s+)?['"]([^'"`]+)['"]/g;

function ruleSessionKey() {
  const RULE = 'session-key';
  const files = [
    ...walk('packages/shared/src', isCodeFile),
    ...walk('packages/core/src', isCodeFile),
    ...walk('packages/desktop/src', isCodeFile),
    ...walk('packages/pwa/src', isCodeFile),
  ].filter((p) => p !== 'packages/shared/src/constants.ts');

  for (const filePath of files) {
    const content = readFileSync(path.join(root, filePath), 'utf8');
    for (const m of content.matchAll(/clawwork:task:/g)) {
      record(RULE, filePath, content, m, 'Construct session keys via buildSessionKey() in @clawwork/shared.', m[0]);
    }
  }
}

const NODE_BUILTINS = new Set(builtinModules);

function ruleRendererBoundary() {
  const RULE = 'renderer-boundary';
  const files = walk('packages/desktop/src/renderer', isCodeFile);
  for (const filePath of files) {
    const content = readFileSync(path.join(root, filePath), 'utf8');
    for (const m of content.matchAll(importRE)) {
      const spec = m[2];
      if (spec === 'electron' || spec.startsWith('electron/')) {
        record(RULE, filePath, content, m, 'Renderer must not import "electron" — use the preload bridge.', spec);
        continue;
      }
      const bare = spec.replace(/^node:/, '');
      if (spec.startsWith('node:') || NODE_BUILTINS.has(bare)) {
        record(RULE, filePath, content, m, `Renderer must not import Node builtin "${spec}".`, spec);
        continue;
      }
      if (spec.startsWith('../main/') || /(?:\.\.\/)+main(?:\/|$)/.test(spec)) {
        record(RULE, filePath, content, m, 'Renderer must not import from main process — use IPC.', spec);
        continue;
      }
      if (spec.startsWith('../preload/') || /(?:\.\.\/)+preload(?:\/|$)/.test(spec)) {
        // `import type` 放行：类型在编译期擦除，不产生任何运行时依赖，
        // 越不了界。preload/clawwork 就是一份纯 .d.ts（零运行时导出），
        // renderer 引它的类型是**合法**的。
        // ⚠️ 只放行显式 `import type` —— 写成值导入（哪怕只引类型）仍然报，
        //    因为那种写法在运行时真的会去加载 preload 模块。
        if (m[1] !== undefined) continue;
        record(
          RULE,
          filePath,
          content,
          m,
          'Renderer must not import preload directly — use window.clawwork API.',
          spec,
        );
      }
    }
  }
}

const FORBIDDEN_DEPS = {
  'packages/shared/src': ['@clawwork/core', '@clawwork/desktop', '@clawwork/pwa'],
  'packages/core/src': ['@clawwork/desktop', '@clawwork/pwa'],
};

function ruleDepDirection() {
  const RULE = 'dep-direction';
  for (const [pkgDir, forbidden] of Object.entries(FORBIDDEN_DEPS)) {
    const pkgName = pkgDir.split('/')[1];
    const files = walk(pkgDir, isCodeFile);
    for (const filePath of files) {
      const content = readFileSync(path.join(root, filePath), 'utf8');
      for (const m of content.matchAll(importRE)) {
        const spec = m[2];
        for (const f of forbidden) {
          if (spec === f || spec.startsWith(f + '/')) {
            record(RULE, filePath, content, m, `Forbidden dependency: @clawwork/${pkgName} cannot import ${f}.`, spec);
          }
        }
      }
    }
  }
}

function ruleCrossPackageRelative() {
  const RULE = 'cross-package-relative';
  const files = [
    ...walk('packages/shared/src', isCodeFile),
    ...walk('packages/core/src', isCodeFile),
    ...walk('packages/desktop/src', isCodeFile),
    ...walk('packages/pwa/src', isCodeFile),
  ];
  for (const filePath of files) {
    const content = readFileSync(path.join(root, filePath), 'utf8');
    const pkgMatch = filePath.match(/^(packages\/[^/]+)\//);
    if (!pkgMatch) continue;
    const sourcePkgRoot = path.join(root, pkgMatch[1]);

    for (const m of content.matchAll(importRE)) {
      const spec = m[2];
      if (!spec.startsWith('.')) continue;
      const fromAbs = path.dirname(path.join(root, filePath));
      const targetAbs = path.resolve(fromAbs, spec);
      const relToPkg = path.relative(sourcePkgRoot, targetAbs);
      if (!relToPkg.startsWith('..')) continue;

      const otherPkg = path
        .relative(root, targetAbs)
        .replace(/\\/g, '/')
        .match(/^packages\/([^/]+)/);
      if (otherPkg) {
        record(
          RULE,
          filePath,
          content,
          m,
          `Cross-package relative import lands in packages/${otherPkg[1]}/. Use @clawwork/${otherPkg[1]} instead.`,
          spec,
        );
      }
    }
  }
}

const rules = [
  { name: 'session-key', run: ruleSessionKey },
  { name: 'renderer-boundary', run: ruleRendererBoundary },
  { name: 'dep-direction', run: ruleDepDirection },
  { name: 'cross-package-relative', run: ruleCrossPackageRelative },
];

for (const r of rules) r.run();

if (violations.length > 0) {
  console.error('Architecture guardrail violations found:\n');
  const byRule = new Map();
  for (const v of violations) {
    if (!byRule.has(v.rule)) byRule.set(v.rule, []);
    byRule.get(v.rule).push(v);
  }
  for (const [rule, list] of byRule) {
    console.error(`[${rule}] (${list.length})`);
    for (const v of list) {
      console.error(`  ${v.filePath}:${v.line}:${v.column}  ${v.message}`);
      console.error(`    ${v.match}`);
    }
    console.error();
  }
  process.exit(1);
}

console.log(`Architecture guardrails passed (${rules.length} rules, 0 violations).`);
