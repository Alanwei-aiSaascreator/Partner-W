#!/usr/bin/env node

/**
 * 产出「飞书可信安装」所需的随包 npm 负载（BUG-171）。
 *
 * 背景：内核 2026.9.3 只给 `origin=bundled` 或 `trustedOfficialInstall=true` 的插件
 * 开放 channel ingress；目录复制没有安装记录 ⇒ 飞书只能发、不能收。唯一可信路径是
 * 跑真正的 `openclaw plugins install @openclaw/feishu@<版本>`，而便携运行时只有
 * node.exe，没有 npm。所以构建前要把：
 *
 *   <runtime-out>/node/npm.cmd
 *   <runtime-out>/node/node_modules/npm/**
 *   <runtime-out>/node/npm-cache/**          ← 最小离线缓存（约 25MB）
 *
 * 准备好。应用首次接入飞书时会把它们惰性复制到已部署的 node 目录，并用
 * `NPM_CONFIG_OFFLINE=true` 离线安装（实测 4 秒）。
 *
 * 用法：
 *   node packages/desktop/scripts/prepare-feishu-npm.mjs [--out <dir>] [--version 2026.9.3]
 *
 * 需要构建机上有可用的 `npm`（首次生成缓存会访问 registry；命中缓存后不会）。
 */

import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const outDir = path.resolve(flag('out', path.join(repoRoot, 'runtime-out', 'node')));
const pluginVersion = flag('version', '2026.9.3');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function findBundledNpm() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm'),
    path.resolve(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm'),
  ];
  return candidates.find((dir) => existsSync(path.join(dir, 'bin', 'npm-cli.js'))) ?? null;
}

async function main() {
  const npmDir = findBundledNpm();
  if (!npmDir) throw new Error('找不到 Node 自带的 npm 包（请用官方 Node 安装包构建）');

  await mkdir(path.join(outDir, 'node_modules'), { recursive: true });
  await cp(npmDir, path.join(outDir, 'node_modules', 'npm'), { recursive: true, force: true });
  if (process.platform === 'win32') {
    await writeFile(
      path.join(outDir, 'npm.cmd'),
      '@ECHO off\r\n"%~dp0node.exe" "%~dp0node_modules\\npm\\bin\\npm-cli.js" %*\r\n',
      'utf8',
    );
  }

  // 用**全新**的最小缓存离线能力：先在线装一次把 packument + tarball 写进缓存。
  const cacheDir = path.join(outDir, 'npm-cache');
  await mkdir(cacheDir, { recursive: true });
  const stage = await mkdtemp(path.join(tmpdir(), 'mofang-feishu-npm-'));
  try {
    const result = spawnSync(
      npmCommand,
      [
        'install',
        `@openclaw/feishu@${pluginVersion}`,
        '--prefix',
        stage,
        '--cache',
        cacheDir,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      { stdio: 'inherit', shell: true },
    );
    if (result.status !== 0) throw new Error(`npm install failed with exit ${result.status}`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  console.log(`feishu npm payload ready: ${outDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
