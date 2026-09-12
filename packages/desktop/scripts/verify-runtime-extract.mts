#!/usr/bin/env tsx
/**
 * 用**我们自己的解压器**解真运行时包，并与 7-Zip 的结果逐字节对拍。
 *
 *   npx tsx packages/desktop/scripts/verify-runtime-extract.mts
 *   npx tsx packages/desktop/scripts/verify-runtime-extract.mts --against <7zip解出的目录>
 *
 * 为什么是脚本而不是单测：真包 128MB / 35,047 个文件，解一次 1–3 分钟 ——
 * 这与 `pack-runtime.test.mjs` 的既定边界一致（重活归脚本，单测只钉纯函数）。
 *
 * ⚠️ **会话安全**：本脚本只在 `os.tmpdir()` 下建目录，**绝不触碰**
 * 真实 `%APPDATA%` / `openclaw-state` / `.state-*`（见 junction 事故）。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractArchive } from '../src/main/runtime/unzip.js';
import { CLAWROUTER_ENTRY } from '../src/main/runtime/deploy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');

/** manifest 声明的东西（若显式给了 --manifest 则以它为准）。 */
const DEFAULT_ARCHIVE = path.join(REPO, 'runtime-out/win32-x64/openclaw-runtime-2026.9.3.7z');
const DEFAULT_MANIFEST = path.join(REPO, 'runtime-out/openclaw-runtime-manifest.json');

interface Counts {
  files: number;
  dirs: number;
}

function countTree(root: string): Counts {
  let files = 0;
  let dirs = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) {
      dirs++;
      const sub = countTree(p);
      files += sub.files;
      dirs += sub.dirs;
    } else {
      files++;
    }
  }
  return { files, dirs };
}

function sha256File(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** 逐字节比两棵树；返回第一处不同（没有则 null）。 */
function firstDifference(a: string, b: string, rel = ''): string | null {
  const ea = fs.readdirSync(a, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name));
  const eb = fs.readdirSync(b, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name));
  if (ea.length !== eb.length) return `${rel || '.'}: 条目数不同（${ea.length} vs ${eb.length}）`;

  for (let i = 0; i < ea.length; i++) {
    if (ea[i].name !== eb[i].name) return `${rel || '.'}: 条目名不同（${ea[i].name} vs ${eb[i].name}）`;
    const pa = path.join(a, ea[i].name);
    const pb = path.join(b, eb[i].name);
    const child = path.posix.join(rel, ea[i].name);

    if (ea[i].isDirectory() !== eb[i].isDirectory()) return `${child}: 一边是目录一边是文件`;
    if (ea[i].isDirectory()) {
      const diff = firstDifference(pa, pb, child);
      if (diff) return diff;
    } else if (!fs.readFileSync(pa).equals(fs.readFileSync(pb))) {
      return `${child}: 内容不同`;
    }
  }
  return null;
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main(): Promise<void> {
  const archive = argValue('--archive') ?? DEFAULT_ARCHIVE;
  const manifestPath = argValue('--manifest') ?? DEFAULT_MANIFEST;
  const against = argValue('--against');

  if (!fs.existsSync(archive)) {
    console.error(`找不到归档：${archive}\n先跑 node scripts/pack-runtime.mjs --version <ver>`);
    process.exit(2);
  }

  const manifest = fs.existsSync(manifestPath)
    ? (JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
        runtimes?: Array<{ fileCount?: number; sha256?: string }>;
      })
    : null;
  const declared = manifest?.runtimes?.[0] ?? null;

  console.log(`归档   ${archive}`);
  console.log(`  大小   ${(fs.statSync(archive).size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  sha256 ${sha256File(archive)}`);
  if (declared?.sha256) console.log(`  manifest 声明 ${declared.sha256}`);

  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-real-extract-'));
  console.log(`\n解压目标 ${dest}`);
  const started = Date.now();
  let lastLogged = 0;
  const res = await extractArchive({
    archivePath: archive,
    destDir: dest,
    onProgress: (done, total) => {
      if (done - lastLogged >= 5000 || done === total) {
        lastLogged = done;
        console.log(`  ${done}/${total}  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
      }
    },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const counts = countTree(dest);
  const nodeModules = path.join(dest, 'node_modules');
  const treeCounts = fs.existsSync(nodeModules)
    ? { files: countTree(nodeModules).files, dirs: countTree(nodeModules).dirs + 1 }
    : { files: 0, dirs: 0 };

  console.log(`\n解压完成：${seconds}s`);
  console.log(`  extractArchive 报告  files=${res.fileCount} dirs=${res.dirCount} entries=${res.entryCount}`);
  console.log(`  实测（含根）        files=${counts.files} dirs=${counts.dirs}`);
  console.log(`  实测 node_modules/  files=${treeCounts.files} dirs=${treeCounts.dirs}`);

  let ok = true;
  if (declared?.fileCount !== undefined) {
    const match = declared.fileCount === treeCounts.files;
    console.log(
      `\n[${match ? ' OK ' : 'FAIL'}] 文件数与 manifest 一致：${treeCounts.files} vs 声明 ${declared.fileCount}`,
    );
    ok &&= match;
  }

  // 两个**必须存在**的入口：cliPath（拉起网关）与 clawrouter（中转计量唯一入口）
  for (const rel of ['node_modules/openclaw/openclaw.mjs', CLAWROUTER_ENTRY]) {
    const p = path.join(dest, rel);
    const exists = fs.existsSync(p);
    console.log(`[${exists ? ' OK ' : 'FAIL'}] ${rel}${exists ? `  sha256=${sha256File(p).slice(0, 16)}…` : ' 缺失'}`);
    ok &&= exists;
  }

  if (against) {
    console.log(`\n与 7-Zip 结果对拍：${against}`);
    const diff = firstDifference(path.join(against, 'node_modules'), nodeModules);
    console.log(`[${diff ? 'FAIL' : ' OK '}] 逐字节对拍${diff ? `：${diff}` : '：35k 个文件全部一致'}`);
    ok &&= !diff;
  }

  console.log(`\n${ok ? '✅ 通过' : '❌ 未通过'}`);
  console.log(`（临时目录保留在 ${dest}，需要清理请手动删）`);
  process.exit(ok ? 0 : 1);
}

await main();
