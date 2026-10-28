#!/usr/bin/env node
/**
 * 发版前的**签名门禁**（2026-10-19，360 误报治理）。
 *
 * 用户真实反馈："被 360 拦截说木马，不敢用"。签名不能 100% 消除误报，但
 * **未签名的 exe 在 SmartScreen / 360 的信誉系统里几乎是默认可疑**；而"忘了签"
 * 这种事故只会在客户机器上暴露。所以把它变成一条显式门禁：发行目录里**我们自己
 * 构建的**可执行文件必须全部有效签名，否则退出码 1。
 *
 * 用法：
 *   node scripts/check-release-signatures.mjs <目录或exe> [--report-only]
 *   --report-only  只报告不失败（证书还没到位时用；正式发版不要加）
 *
 * 退出码：0 = 通过；1 = 有必需文件未签名。
 *
 * ⚠️ 当前证书还没到位时，这个脚本**会红**——这是故意的：红代表"现在不该发版"。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const OUR_EXECUTABLES = new Set(['Partner-W启动器.exe', 'Partner-W.exe']);
const INSTALLER_PATTERN = /^Partner-W-.*-win-x64\.exe$/u;

function parseArgs(argv) {
  const reportOnly = argv.includes('--report-only');
  const targets = argv.filter((value) => !value.startsWith('--'));
  if (targets.length === 0) {
    console.error('用法：node scripts/check-release-signatures.mjs <目录或exe> [--report-only]');
    process.exit(2);
  }
  return { reportOnly, targets };
}

function collectExecutables(target, out) {
  const resolved = path.resolve(target);
  if (!existsSync(resolved)) {
    console.error(`目标不存在：${resolved}`);
    process.exit(2);
  }
  const stats = statSync(resolved);
  if (stats.isFile()) {
    if (resolved.toLowerCase().endsWith('.exe')) out.push(resolved);
    return;
  }
  for (const entry of readdirSync(resolved, { withFileTypes: true })) {
    const child = path.join(resolved, entry.name);
    if (entry.isDirectory()) collectExecutables(child, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe')) out.push(child);
  }
}

function classify(file) {
  const name = path.basename(file);
  if (OUR_EXECUTABLES.has(name) || INSTALLER_PATTERN.test(name)) return 'required';
  // 随包第三方：node.exe（OpenJS 已签）与 electron-builder / win-ca 自带的工具。
  // 它们不是我们签的，缺失只告警；真正要消灭的是"我们的 exe 没签"。
  return 'third-party';
}

function probeWithPowerShell(files) {
  const workDir = mkdtempSync(path.join(tmpdir(), 'partner-w-signatures-'));
  const inputPath = path.join(workDir, 'input.json');
  const outputPath = path.join(workDir, 'output.json');
  writeFileSync(inputPath, JSON.stringify(files), 'utf8');
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$files = Get-Content -Raw -Encoding UTF8 '${inputPath.replaceAll("'", "''")}' | ConvertFrom-Json`,
    '$rows = foreach ($file in $files) {',
    '  $sig = Get-AuthenticodeSignature -LiteralPath $file',
    '  [pscustomobject]@{',
    '    path = $file',
    '    status = [string]$sig.Status',
    '    subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { "" }',
    '  }',
    '}',
    `$rows | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 '${outputPath.replaceAll("'", "''")}'`,
  ].join('\n');
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'pipe',
    });
    const parsed = JSON.parse(readFileSync(outputPath, 'utf8').replace(/^﻿/u, ''));
    return Array.isArray(parsed) ? parsed : [parsed];
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

const { reportOnly, targets } = parseArgs(process.argv.slice(2));
const files = [];
for (const target of targets) collectExecutables(target, files);
if (files.length === 0) {
  console.error('没有找到任何 .exe；确认传入的是发行目录或单个 exe。');
  process.exit(2);
}

const firstTarget = path.resolve(targets[0]);
const displayBase = statSync(firstTarget).isDirectory() ? firstTarget : path.dirname(firstTarget);
const results = probeWithPowerShell(files);
let failed = 0;
let warned = 0;
for (const row of results) {
  const kind = classify(row.path);
  const relative = path.relative(displayBase, row.path) || row.path;
  if (row.status === 'Valid') {
    console.log(`✅ ${kind.padEnd(10)} ${relative}  ←  ${row.subject}`);
    continue;
  }
  if (kind === 'required') {
    failed += 1;
    console.log(`❌ ${kind.padEnd(10)} ${relative}  ←  ${row.status}（必须签名才能发版）`);
  } else {
    warned += 1;
    console.log(`⚠️  ${kind.padEnd(10)} ${relative}  ←  ${row.status}（第三方，仅告警）`);
  }
}

console.log(
  `\n小计：必需 ${results.filter((row) => classify(row.path) === 'required').length} 个，未签 ${failed} 个；第三方告警 ${warned} 个。`,
);
if (failed > 0) {
  if (reportOnly) {
    console.log('（--report-only：只报告，不作为失败。）');
    process.exit(0);
  }
  console.error('签名门禁未通过：先对安装器 / 启动器 / 主 exe 做 Authenticode 签名（含时间戳）再发版。');
  process.exit(1);
}
process.exit(0);
