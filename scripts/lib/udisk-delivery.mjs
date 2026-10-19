import fs from 'node:fs';
import path from 'node:path';

import { launcherOutputName } from './portable-launcher-build.mjs';

export const APP_DIR_NAME = '\u8363\u76c8\u9b54\u65b9';
export const EXE_NAME = '\u8363\u76c8\u9b54\u65b9.exe';
export const README_NAME = '\u4f7f\u7528\u8bf4\u660e.txt';
export const LAUNCHER_EXE_NAME = launcherOutputName;
export const LAUNCHER_BAT_NAME = '\u2460\u53cc\u51fb\u8fd9\u91cc\u542f\u52a8.bat';
export const INSTALLER_DIR_PREFIX = '\u26a0\ufe0f\u88c5\u5230\u7535\u8111\u624d\u7528';
export const RUNTIME_MANIFEST_NAME = 'openclaw-runtime-manifest.json';
export const RUN_DATA_DIR_NAME = '\u8363\u76c8\u9b54\u65b9-\u8fd0\u884c\u6570\u636e';
export const WORKSPACE_DIR_NAME = '\u8363\u76c8\u9b54\u65b9\u5de5\u4f5c\u533a';
export const UPDATE_DIR_NAME = '.\u8363\u76c8\u9b54\u65b9\u66f4\u65b0';
export const EXE_REL = path.join(APP_DIR_NAME, EXE_NAME);
export const ASAR_REL = path.join(APP_DIR_NAME, 'resources', 'app.asar');
export const BUNDLED_RUNTIME_MANIFEST_REL = path.join(APP_DIR_NAME, 'resources', 'runtime', RUNTIME_MANIFEST_NAME);
export const INSTANCE_BUSY_TITLE = '\u8363\u76c8\u9b54\u65b9\u5df2\u7ecf\u5728\u8fd0\u884c';
export const REMOVED_DIR_PREFIX = '_U\u76d8\u4ea4\u4ed8-\u5df2\u79fb\u9664';

export function bufferHasString(buffer, value) {
  if (!buffer || !value) return false;
  if (buffer.includes(Buffer.from(value, 'utf8'))) return true;
  const escaped = (uppercase) =>
    [...value]
      .map((character) => {
        const code = character.charCodeAt(0);
        if (code <= 127) return character;
        const hex = code.toString(16).padStart(4, '0');
        return `\\u${uppercase ? hex.toUpperCase() : hex}`;
      })
      .join('');
  return buffer.includes(Buffer.from(escaped(true), 'utf8')) || buffer.includes(Buffer.from(escaped(false), 'utf8'));
}

export function readmeProblems(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ');
  const problems = [];
  if (flat.includes(LAUNCHER_BAT_NAME) || flat.includes('\u53cc\u51fb\u8fd9\u91cc\u542f\u52a8')) {
    problems.push(`README still points to ${LAUNCHER_BAT_NAME}`);
  }
  if (!flat.includes(LAUNCHER_EXE_NAME)) problems.push(`README does not name ${LAUNCHER_EXE_NAME}`);
  if (!flat.includes('\u53cc\u51fb')) problems.push('README does not tell the user to double-click the launcher');
  if (!flat.includes(RUN_DATA_DIR_NAME)) problems.push(`README does not name ${RUN_DATA_DIR_NAME}`);
  if (!flat.includes('\u76d8\u7b26')) problems.push('README does not warn that the drive letter must remain stable');
  return problems;
}

function finding(id, title, detail, fix) {
  return {
    id,
    level: 'error',
    title,
    detail,
    ...(fix === undefined ? {} : { fix }),
  };
}

/**
 * 递归列出交付夹内的相对路径。
 *
 * 真实 U 盘根下一定有 `System Volume Information`（以及可能存在的回收站目录），
 * 普通权限读它会抛 EPERM。体检工具的目标是"这个包能不能发"，不是"整块盘读得全"——
 * 读不动的子树按"未知"跳过（它不在交付内容里），绝不能把工具本身崩掉。
 * `readDir` 可注入，便于用测试模拟 EPERM。
 */
export function walkTreeNames(root, readDir = (directory, options) => fs.readdirSync(directory, options)) {
  const names = [];
  const walk = (directory, prefix) => {
    let entries;
    try {
      entries = readDir(directory, { withFileTypes: true });
    } catch (error) {
      // 盘根自带的这几个目录普通权限一定读不了（`System Volume Information` 实测 EPERM）。
      // 它们不属于交付内容 ⇒ 跳过。**其余读不动的目录必须让体检失败** ——
      // 静默跳过等于把"读不到"当成"没问题"，交付包里藏着什么就谁都不知道了。
      if (SYSTEM_UNREADABLE_DIRECTORIES.has(path.basename(directory).toLowerCase())) return;
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
      throw new Error(`无法读取目录（${code}）：${directory} —— 权限不足时不能判定交付包完整`);
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      names.push(relative);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path.join(directory, entry.name), relative);
    }
  };
  walk(String(root), '');
  return names;
}

/** 盘根自带的、普通权限读不了且不属于交付内容的目录（小写比较）。 */
const SYSTEM_UNREADABLE_DIRECTORIES = new Set(['system volume information', '$recycle.bin', 'recycler', 'recycled']);

function relativeTreeEntries(io, root) {
  if (typeof io.walkNames === 'function') return io.walkNames(root);
  return io.listNames(root);
}

export function auditDelivery(io, root) {
  const findings = [];
  const at = (...parts) => path.join(root, ...parts);
  const rootNames = io.listNames(root);
  const allNames = relativeTreeEntries(io, root).map((entry) => String(entry).replace(/\\/g, '/'));

  if (!io.exists(at(LAUNCHER_EXE_NAME))) {
    findings.push(
      finding(
        'missing-launcher',
        `Missing ${LAUNCHER_EXE_NAME}`,
        'The root launcher is the only supported entry point.',
      ),
    );
  }
  if (!io.exists(at(EXE_REL))) {
    findings.push(finding('missing-exe', `Missing ${EXE_REL}`, 'The replaceable program directory is incomplete.'));
  }
  if (!io.exists(at(ASAR_REL))) {
    findings.push(finding('missing-asar', `Missing ${ASAR_REL}`, 'The replaceable program directory is incomplete.'));
  }
  if (!io.exists(at(BUNDLED_RUNTIME_MANIFEST_REL))) {
    findings.push(
      finding('missing-bundled-runtime', 'Bundled runtime is missing', `Expected ${BUNDLED_RUNTIME_MANIFEST_REL}.`),
    );
  }

  // 2026-10-19：随包 npm 自带的 node-gyp 里有一个 `gyp.bat`。这条规则的本意是
  // "盘根不许放 .bat 启动器"，不是"vendor 工具链里一个文件都不许有"——只在这一个
  // 精确前缀下放行；其余任何位置的 .bat 照旧报错（"嵌套 .bat 必须拒绝"那条测试不变）。
  const bundledNpmPrefix = `${APP_DIR_NAME}/resources/runtime/node/node_modules/npm/`.toLowerCase();
  const batchFiles = allNames
    .filter((name) => name.toLowerCase().endsWith('.bat'))
    .filter((name) => !name.toLowerCase().startsWith(bundledNpmPrefix));
  for (const name of batchFiles) {
    findings.push(
      finding(
        'launcher-bat',
        `Batch launcher is forbidden: ${name}`,
        'The portable base package uses only the signed EXE launcher.',
        {
          kind: 'move-out',
          name,
        },
      ),
    );
  }

  if (rootNames.some((name) => name.startsWith(INSTALLER_DIR_PREFIX))) {
    findings.push(
      finding(
        'installer-folder',
        'Installer content is forbidden',
        'Portable delivery must not invite installation on the host computer.',
      ),
    );
  }
  for (const name of rootNames) {
    if (name.toLowerCase().endsWith('.exe') && name !== LAUNCHER_EXE_NAME) {
      findings.push(
        finding(
          'extra-root-executable',
          `Unexpected root executable: ${name}`,
          'Portable delivery has one entry point: the root launcher. Keep desktop installers outside it.',
        ),
      );
    }
  }
  if (io.exists(at(APP_DIR_NAME, LAUNCHER_EXE_NAME))) {
    findings.push(
      finding(
        'launcher-inside-program',
        'Launcher is inside the replaceable program directory',
        'The launcher must remain at the drive root so it survives a directory swap.',
      ),
    );
  }

  for (const [name, id] of [
    [RUN_DATA_DIR_NAME, 'prepopulated-data'],
    [WORKSPACE_DIR_NAME, 'prepopulated-workspace'],
    [UPDATE_DIR_NAME, 'prepopulated-update'],
    ['runtime', 'prepopulated-legacy-runtime'],
  ]) {
    if (io.exists(at(name))) {
      findings.push(
        finding(
          id,
          `Pre-populated directory is forbidden: ${name}`,
          'A base package must contain no user, workspace, or update state.',
        ),
      );
    }
  }

  const readme = io.exists(at(README_NAME)) ? io.readFile(at(README_NAME))?.toString('utf8') : null;
  if (readme === null) {
    findings.push(
      finding('readme-missing', `Missing ${README_NAME}`, 'The base package must include exact launch instructions.'),
    );
  } else {
    const problems = readmeProblems(readme);
    if (problems.length > 0) {
      findings.push(finding('readme-stale', `${README_NAME} does not match the package`, problems.join('\n')));
    }
  }

  return findings;
}

export function planFixes(findings, root, stamp) {
  return findings
    .filter((entry) => entry.fix?.kind === 'move-out')
    .map((entry) => ({
      kind: 'move-out',
      from: path.join(root, ...entry.fix.name.split('/')),
      to: path.join(root, '..', `${REMOVED_DIR_PREFIX}-${stamp}`, ...entry.fix.name.split('/')),
      why: entry.title,
    }));
}

export function versionFromFolderName(folderName) {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/.exec(String(folderName ?? ''));
  return match ? match[1] : null;
}
