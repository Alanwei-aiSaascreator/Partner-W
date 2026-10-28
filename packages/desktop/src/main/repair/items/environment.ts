/**
 * 修复项 #4 · 运行环境自查（SPEC 二·MVP 4）。
 *
 * SPEC 原话：**只报告 + 指引**（不自动"修"环境；被杀软拦截类给出说明书对应章节指引）。
 * 所以本模块 `actions` **恒为空** —— 界面不会给出任何勾选框，只出一份体检单。
 *
 * ## 为什么"不修"是对的
 *
 * 这一项覆盖的现场（BUG-064 首扫拦截）是**杀毒软件 / SAC / 盘只读 / 缺运行时**。
 * 这些没有一个是"改一个文件就能好"的：自动改权限、自动放行杀软，比坏着更危险。
 * 工具能做的、也是最有价值的一件事是**把"哪儿不对"说清楚**，让客服和用户有下一步。
 *
 * ## 一条纪律：探测**不写盘**
 *
 * 可写性用 `fs.accessSync(dir, W_OK)` 判，**不**创建-删除探针文件。
 * 理由：SPEC 四的对照试验要求"无故障盘全检 = **零修改**"。一个会瞬时创建文件的探针
 * 让这条验收变成"基本零修改"，而 `access` 足够回答"这个目录现在能不能写"。
 * （如实记下代价：Windows 上 `access` 对 ACL 偏乐观；它说能写不代表一定能写。）
 */

import fs from 'node:fs';
import path from 'node:path';
import type { RepairMessage } from '@clawwork/shared';
import { CURRENT_POINTER_FILE, DEPLOYED_DIR_NAME, DEPLOYED_NODE_DIR, RUNTIME_CACHE_DIR_NAME } from '../../runtime/deploy.js';
import type { RepairTargets } from '../targets.js';

export interface EnvironmentReport {
  findings: RepairMessage[];
  /** 需要用户/客服做什么（指引，不是动作）。 */
  guidance: RepairMessage[];
  /** 有没有把哪一项判成"不对"。 */
  unhealthy: boolean;
}

/** 目录现在能不能写（**不创建探针文件** —— 见文件头"探测不写盘"那条）。 */
function writable(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function existsFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 本机运行时缓存里那份被 `current.json` 指着的部署（没有 ⇒ null）。 */
export function activeDeploymentNode(dataRoot: string): string | null {
  const pointer = path.join(dataRoot, RUNTIME_CACHE_DIR_NAME, CURRENT_POINTER_FILE);
  let key: unknown;
  try {
    key = (JSON.parse(fs.readFileSync(pointer, 'utf8')) as Record<string, unknown>).key;
  } catch {
    return null;
  }
  if (typeof key !== 'string' || key.length === 0) return null;
  const root = path.join(dataRoot, RUNTIME_CACHE_DIR_NAME, DEPLOYED_DIR_NAME, key);
  const node = path.join(root, DEPLOYED_NODE_DIR, 'node.exe');
  return existsFile(node) ? node : null;
}

/**
 * 体检。**不抛、不写盘**。
 *
 * `bundledRuntimeRoot` = 随包运行时目录（盘上形态是盘上的那份；打包态由调用方给）。
 */
export function inspectEnvironment(opts: {
  targets: RepairTargets;
  bundledRuntimeRoot: string | null;
  isPackaged: boolean;
}): EnvironmentReport {
  const { targets } = opts;
  const findings: RepairMessage[] = [];
  const guidance: RepairMessage[] = [];
  let unhealthy = false;

  findings.push({
    code: targets.portable ? 'env.mode-portable' : 'env.mode-installed',
    params: { root: targets.portable ? (targets.volumeRoot ?? targets.dataRoot) : targets.dataRoot },
  });

  // ① 运行数据目录可写性 —— 写不进去，后面所有修复都做不成
  if (writable(targets.dataRoot)) {
    findings.push({ code: 'env.data-root-writable', params: { path: targets.dataRoot } });
  } else {
    unhealthy = true;
    findings.push({ code: 'env.data-root-not-writable', params: { path: targets.dataRoot } });
    guidance.push({ code: 'env.guide-readonly-drive' });
  }

  // ② 随包运行时（这一项决定"能不能起本机服务"）
  if (opts.bundledRuntimeRoot && fs.existsSync(opts.bundledRuntimeRoot)) {
    findings.push({ code: 'env.runtime-media-present', params: { path: opts.bundledRuntimeRoot } });
  } else if (opts.isPackaged) {
    unhealthy = true;
    findings.push({ code: 'env.runtime-media-missing' });
    guidance.push({ code: 'env.guide-antivirus-quarantine' });
  } else {
    findings.push({ code: 'env.runtime-media-dev-skip' });
  }

  // ③ 本机运行时缓存（首跑要在这里部署一份；没有 ≠ 坏，只是"还没跑过"）
  const node = activeDeploymentNode(targets.dataRoot);
  if (node) findings.push({ code: 'env.runtime-deployed', params: { path: node } });
  else findings.push({ code: 'env.runtime-not-deployed' });

  // ④ state 目录（有没有一份可以被修的配置）
  if (targets.stateDirs.length > 0) {
    findings.push({ code: 'env.state-found', params: { count: targets.stateDirs.length, path: targets.stateDirs[0] ?? '' } });
  } else {
    findings.push({ code: 'env.state-missing', params: { path: targets.candidateStateRoots[0] ?? targets.dataRoot } });
    guidance.push({ code: 'env.guide-never-started' });
  }

  // ⑤ 盘上形态：用户资料工作区
  if (targets.portable && targets.workspaceRoot) {
    const ok = fs.existsSync(targets.workspaceRoot) && writable(targets.workspaceRoot);
    findings.push({
      code: ok ? 'env.workspace-ok' : 'env.workspace-unusable',
      params: { path: targets.workspaceRoot },
    });
    if (!ok) {
      unhealthy = true;
      guidance.push({ code: 'env.guide-workspace' });
    }
  }

  return { findings, guidance, unhealthy };
}
