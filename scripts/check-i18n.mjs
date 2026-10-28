#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, extname, resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { createI18nUsageMatcher, findMissingLiteralKeys } from './lib/i18n-usage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const PACKAGES = [
  {
    name: 'desktop',
    localeDir: join(ROOT, 'packages/desktop/src/renderer/i18n/locales'),
    sourceDirs: [join(ROOT, 'packages/desktop/src/renderer'), join(ROOT, 'packages/core/src')],
  },
  {
    name: 'pwa',
    localeDir: join(ROOT, 'packages/pwa/src/i18n/locales'),
    sourceDirs: [join(ROOT, 'packages/pwa/src'), join(ROOT, 'packages/core/src')],
  },
];

const SHARED_CONSTANTS = join(ROOT, 'packages/shared/src/constants.ts');
const QUICK_LAUNCH = join(ROOT, 'packages/desktop/src/renderer/quick-launch.html');

let exitCode = 0;

/**
 * `SUPPORTED_LANGUAGE_CODES` 是语言集合的唯一定义。locale 目录与 quick-launch.html
 * 都按它比对 —— 否则**整个删掉 `de.json` 不会响**（少一个文件时，键位对照循环根本
 * 遍历不到它，未用键检查也只认 en.json，于是"德语没了"看起来跟"全绿"一模一样）。
 */
function readSupportedLanguageCodes() {
  if (!existsSync(SHARED_CONSTANTS)) return null;
  const sharedSrc = readFileSync(SHARED_CONSTANTS, 'utf-8');
  const codesMatch = sharedSrc.match(/SUPPORTED_LANGUAGE_CODES\s*=\s*\[([^\]]+)\]/);
  if (!codesMatch) return null;
  return codesMatch[1]
    .split(',')
    .map((s) => s.trim().replace(/['"]/g, ''))
    .filter(Boolean);
}

function flatten(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...flatten(v, path));
    } else {
      keys.push(path);
    }
  }
  return keys.sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function collectFiles(dir, exts) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, exts));
    } else if (exts.includes(extname(entry.name))) {
      results.push(full);
    }
  }
  return results;
}

for (const pkg of PACKAGES) {
  if (!existsSync(pkg.localeDir)) continue;

  console.log(`\n══ ${pkg.name} ══`);

  // ── Key parity check ──────────────────────────────────────────────
  console.log('── i18n key parity check ──');

  const localeFiles = readdirSync(pkg.localeDir).filter((f) => f.endsWith('.json'));
  const enKeys = flatten(readJson(join(pkg.localeDir, 'en.json')));
  const enSet = new Set(enKeys);

  // ── Locale file set check ─────────────────────────────────────────
  const supportedCodes = readSupportedLanguageCodes();
  if (supportedCodes === null) {
    console.error('  ERROR could not parse SUPPORTED_LANGUAGE_CODES from shared/constants.ts');
    exitCode = 1;
  } else {
    const dirCodes = new Set(localeFiles.map((f) => f.replace('.json', '')));
    const supportedSet = new Set(supportedCodes);
    const missingFiles = supportedCodes.filter((code) => !dirCodes.has(code));
    const extraFiles = [...dirCodes].filter((code) => !supportedSet.has(code));

    if (missingFiles.length > 0) {
      console.error(`  ERROR locale files missing for supported codes: ${missingFiles.join(', ')}`);
      exitCode = 1;
    }
    if (extraFiles.length > 0) {
      console.error(`  ERROR locale files without a supported code: ${extraFiles.join(', ')}`);
      exitCode = 1;
    }
    if (missingFiles.length === 0 && extraFiles.length === 0) {
      console.log('  OK — locale files match SUPPORTED_LANGUAGE_CODES');
    }
  }

  for (const file of localeFiles) {
    if (file === 'en.json') continue;
    const lang = file.replace('.json', '');
    const langKeys = flatten(readJson(join(pkg.localeDir, file)));
    const langSet = new Set(langKeys);

    const missing = enKeys.filter((k) => !langSet.has(k));
    const extra = langKeys.filter((k) => !enSet.has(k));

    if (missing.length > 0) {
      console.error(
        `  ERROR [${lang}] missing ${missing.length} keys: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`,
      );
      exitCode = 1;
    }
    if (extra.length > 0) {
      console.error(
        `  ERROR [${lang}] extra ${extra.length} keys: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? '...' : ''}`,
      );
      exitCode = 1;
    }
    if (missing.length === 0 && extra.length === 0) {
      console.log(`  OK [${lang}]`);
    }
  }

  // ── Unused key check ──────────────────────────────────────────────
  console.log('\n── i18n unused key check ──');

  const sourceFiles = pkg.sourceDirs.flatMap((d) => collectFiles(d, ['.ts', '.tsx']));
  const sourceText = sourceFiles.map((f) => readFileSync(f, 'utf-8')).join('\n');
  const isUsed = createI18nUsageMatcher(sourceText);

  const unreferenced = [];
  for (const key of enKeys) {
    if (isUsed(key)) continue;
    unreferenced.push(key);
  }

  if (unreferenced.length > 0) {
    console.error(
      `  ERROR ${unreferenced.length} unused keys (remove from all locale files, or use a scanner-visible pattern like t(\`prefix.\${var}\`)):`,
    );
    for (const k of unreferenced) {
      console.error(`    - ${k}`);
    }
    exitCode = 1;
  } else {
    console.log('  OK — no unused keys detected');
  }

  // ── Missing key check (code → locale word list) ────────────────────
  // ⚠️ 上一条只走「词表 → 代码」方向：它从 en.json 出发，所以**代码引用了、9 个
  //    locale 全缺**的键永远不在它的视野里（例：`mainArea.welcomeSubtitle` 渲染出
  //    裸键、`common.edit` / `common.remove` 的 aria-label 变成键名）。这里反向兜底。
  console.log('\n── i18n missing key check (referenced in code) ──');

  const missingKeys = new Map(); // key -> files referencing it
  for (const file of sourceFiles) {
    const missing = findMissingLiteralKeys(readFileSync(file, 'utf-8'), enSet);
    for (const key of missing) {
      if (!missingKeys.has(key)) missingKeys.set(key, []);
      missingKeys.get(key).push(relative(ROOT, file).split('\\').join('/'));
    }
  }

  if (missingKeys.size > 0) {
    console.error(`  ERROR ${missingKeys.size} keys referenced in code but missing from en.json:`);
    for (const [key, files] of [...missingKeys].sort(([a], [b]) => (a < b ? -1 : 1))) {
      console.error(`    - ${key}  (${files.join(', ')})`);
    }
    exitCode = 1;
  } else {
    console.log('  OK — every literal key in code exists in the locale files');
  }

  // ── defaultValue anti-pattern check ───────────────────────────────
  console.log('\n── i18n defaultValue check ──');

  const defaultValueRe = /\bt\(\s*['"][^'"]+['"]\s*,\s*\{[^}]*defaultValue/g;
  const violations = [];
  for (const file of sourceFiles) {
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (defaultValueRe.test(lines[i])) {
        violations.push(`${file.replace(ROOT + '/', '')}:${i + 1}`);
      }
      defaultValueRe.lastIndex = 0;
    }
  }

  if (violations.length > 0) {
    console.error(`  ERROR ${violations.length} t() calls use defaultValue — add the key to en.json instead:`);
    for (const v of violations) {
      console.error(`    - ${v}`);
    }
    exitCode = 1;
  } else {
    console.log('  OK — no defaultValue usage detected');
  }
}

// ── quick-launch.html drift check (desktop only) ───────────────────
if (existsSync(QUICK_LAUNCH) && existsSync(SHARED_CONSTANTS)) {
  console.log('\n── quick-launch.html locale drift check ──');

  const supportedCodes = readSupportedLanguageCodes();
  if (supportedCodes === null) {
    console.error('  ERROR could not parse SUPPORTED_LANGUAGE_CODES from shared/constants.ts');
    exitCode = 1;
  } else {
    const sharedCodes = new Set(supportedCodes);

    const qlHtml = readFileSync(QUICK_LAUNCH, 'utf-8');
    const messagesMatch = qlHtml.match(/var\s+messages\s*=\s*\{([\s\S]*?)\};/);
    if (!messagesMatch) {
      console.error('  ERROR could not parse messages object from quick-launch.html');
      exitCode = 1;
    } else {
      const qlCodes = new Set([...messagesMatch[1].matchAll(/['"]?([a-zA-Z-]+)['"]?\s*:\s*\{/g)].map((m) => m[1]));

      const missingInQl = [...sharedCodes].filter((c) => !qlCodes.has(c));
      const extraInQl = [...qlCodes].filter((c) => !sharedCodes.has(c));

      if (missingInQl.length > 0) {
        console.error(`  ERROR quick-launch.html missing locales: ${missingInQl.join(', ')}`);
        exitCode = 1;
      }
      if (extraInQl.length > 0) {
        console.error(`  ERROR quick-launch.html has extra locales: ${extraInQl.join(', ')}`);
        exitCode = 1;
      }
      if (missingInQl.length === 0 && extraInQl.length === 0) {
        console.log('  OK — locale keys match SUPPORTED_LANGUAGE_CODES');
      }
    }
  }
}

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\ni18n check ${exitCode === 0 ? 'passed' : 'FAILED'}`);
process.exit(exitCode);
