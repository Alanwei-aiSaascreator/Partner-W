/**
 * 修复项 #2 · 失效插件路径（SPEC 二·MVP 2，事故背书 BUG-036「换盘符砖盘」）。
 *
 * ## 现场
 *
 * 盘在 `G:` 下跑过一次之后，`openclaw.json` 的 `plugins.load.paths` 里就写死了
 * `G:\Partner-W-运行数据\state\<id>\policies\partner-w-inbox-readonly`。换插到 `E:` 后：
 * 那台机器上 `G:` 不存在 ⇒ 网关把"任一 load path 不存在"判成 **Invalid config** ⇒
 * **拒绝启动** ⇒ 整盘卡在"本机服务"。而配置里那份死条目**永远不会自己走掉**
 * （提前返回的判据只认"当前盘这一条在不在"，历史盘符那些不在它视野里）。
 *
 * ## 修法（SPEC 原话：按当前盘符重新归并）
 *
 * 复用**应用自己那条**每次启动都跑的合并链（`mergeInboxReadonlyGuard` →
 * `mergeRelaySearchProvider` → `mergeRetryGuardPolicy`）。这不是"另写一套替换逻辑"：
 * 那三个纯函数本来就负责"把死盘符条目剔掉、把当前盘那条并进来"，
 * 应用启动时也是它们在做这件事 —— 修复工具只是**在应用起不来的时候**替它跑一遍。
 *
 * ## 界线（**只动我们自己的插件条目**）
 *
 * 只处理 `basename` 命中三个自家插件 id 的死条目。其它任何死路径（用户自己装的、
 * 别的产品留下的）**一律只报告不动手** —— 我们没有资格替用户删他的插件配置。
 *
 * ## 幂等
 *
 * 合并结果是"当前盘条目在、历史盘条目不在"，第二次跑时 `plugins` 段已经完全一致
 * ⇒ 不产生任何动作、不写盘。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RepairAction, RepairMessage } from '@clawwork/shared';
import { writeJsonAtomic } from '../../util/json-file.js';
import {
  INBOX_READONLY_PLUGIN_ID,
  ensureInboxReadonlyPolicy,
  inboxReadonlyPolicyDir,
} from '../../guard/inbox-readonly.js';
import {
  RELAY_SEARCH_PLUGIN_ID,
  ensureRelaySearchPlugin,
  relaySearchPluginDir,
} from '../../runtime/relay-search-plugin.js';
import {
  RETRY_GUARD_PLUGIN_ID,
  ensureRetryGuardPolicy,
  retryGuardPolicyDir,
} from '../../runtime/deterministic-retry-guard.js';
import {
  mergeInboxReadonlyGuard,
  mergeRelaySearchProvider,
  mergeRetryGuardPolicy,
} from '../../runtime/state-config.js';
import { STATE_CONFIG_FILE } from '../targets.js';
import { UNSAFE_TARGET_REASON, isRegularFileNoFollow } from '../safe-fs.js';

/** 自家插件的目录名集合（`plugins.load.paths` 里靠尾段认领）。 */
export const OUR_PLUGIN_DIR_NAMES: readonly string[] = [
  INBOX_READONLY_PLUGIN_ID,
  RELAY_SEARCH_PLUGIN_ID,
  RETRY_GUARD_PLUGIN_ID,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `plugins.load.paths` 里的字符串条目（形状不认识 ⇒ `null`，调用方跳过）。 */
export function readPluginLoadPaths(raw: unknown): string[] | null {
  if (!isRecord(raw)) return null;
  const plugins = raw.plugins;
  if (!isRecord(plugins)) return null;
  const load = plugins.load;
  if (!isRecord(load)) return null;
  const paths = load.paths;
  if (!Array.isArray(paths)) return null;
  return paths.filter((value): value is string => typeof value === 'string');
}

/** 这一条路径是不是"我们自己的插件目录"（只看尾段，与盘符无关 —— 换个盘它还是它）。 */
export function isOurPluginPath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, '/').replace(/\/+$/, '');
  return OUR_PLUGIN_DIR_NAMES.some((id) => normalized === id || normalized.endsWith(`/${id}`));
}

export interface PluginPathFinding {
  /** 配置里那条死路径。 */
  deadPath: string;
  /** 是不是自家插件（false ⇒ 只报告）。 */
  ours: boolean;
}

/** 扫一个 state 目录的插件路径。**只读、绝不抛**。 */
export function scanPluginPaths(opts: { stateDir: string; exists?: (p: string) => boolean }): PluginPathFinding[] {
  const exists = opts.exists ?? ((p: string): boolean => fs.existsSync(p));
  const configPath = path.join(opts.stateDir, STATE_CONFIG_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return [];
  }
  const paths = readPluginLoadPaths(parsed);
  if (!paths) return [];
  const findings: PluginPathFinding[] = [];
  for (const candidate of paths) {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) continue;
    if (exists(candidate)) continue;
    findings.push({ deadPath: candidate, ours: isOurPluginPath(candidate) });
  }
  return findings;
}

export interface PluginPathRebase {
  changed: boolean;
  config: Record<string, unknown>;
  /** 需要重建的插件目录（当前盘的那几个）。 */
  canonicalDirs: string[];
}

/**
 * 纯计算：把 `plugins` 段重新归并到当前盘（**不写盘**）。
 *
 * `existing` 形状不认识（不是对象）⇒ `changed:false`（宁可不做，也不猜）。
 */
export function rebasePluginConfig(
  existing: Record<string, unknown> | null,
  dirs: { inbox: string; search: string; retry: string },
): PluginPathRebase {
  if (!existing || !isRecord(existing)) return { changed: false, config: existing ?? {}, canonicalDirs: [] };
  const afterInbox = mergeInboxReadonlyGuard(existing, dirs.inbox);
  const afterSearch = mergeRelaySearchProvider({ plugins: afterInbox }, dirs.search);
  const afterRetry = mergeRetryGuardPolicy({ plugins: afterSearch }, dirs.retry);
  const changed = JSON.stringify(afterRetry) !== JSON.stringify(existing.plugins ?? null);
  return {
    changed,
    config: { ...existing, plugins: afterRetry },
    canonicalDirs: [dirs.inbox, dirs.search, dirs.retry],
  };
}

/** 当前盘的三个规范目录（**不建目录**，只算路径）。 */
export function canonicalPluginDirs(stateDir: string): { inbox: string; search: string; retry: string } {
  return {
    inbox: inboxReadonlyPolicyDir(stateDir),
    search: relaySearchPluginDir(stateDir),
    retry: retryGuardPolicyDir(stateDir),
  };
}

/**
 * 让三个插件目录**真的存在**（应用自己的幂等安装器）。返回建不成的那些。
 *
 * ⚠️ 这条是必需的：如果只把配置指向一个还不存在的目录，我们就是把 BUG-036
 *    从"死盘符"换成了"还没建" —— 网关一样拒启。所以**目录不在就不改配置**。
 */
export function materializePluginDirs(stateDir: string): string[] {
  const failures: string[] = [];
  const installers: Array<() => string> = [
    () => ensureInboxReadonlyPolicy(stateDir),
    () => ensureRelaySearchPlugin(stateDir),
    () => ensureRetryGuardPolicy(stateDir),
  ];
  for (const install of installers) {
    try {
      const dir = install();
      if (!fs.existsSync(dir)) failures.push(dir);
    } catch {
      failures.push('<installer>');
    }
  }
  return failures;
}

export interface PluginPathPlan {
  findings: RepairMessage[];
  actions: RepairAction[];
  blocked: RepairMessage[];
  /** 每个 stateDir 一条待办（动作粒度 = 一份配置文件）。 */
  pending: Array<{ stateDir: string; configPath: string; dirs: { inbox: string; search: string; retry: string } }>;
}

/** 扫描结果 → 报告片段。 */
export function planPluginPaths(opts: {
  stateDir: string;
  findings: readonly PluginPathFinding[];
  exists?: (p: string) => boolean;
}): PluginPathPlan {
  const messages: RepairMessage[] = [];
  const blocked: RepairMessage[] = [];
  const configPath = path.join(opts.stateDir, STATE_CONFIG_FILE);
  const own = opts.findings.filter((finding) => finding.ours);
  const foreign = opts.findings.filter((finding) => !finding.ours);

  for (const finding of own) messages.push({ code: 'plugin.own-dead-path', params: { path: finding.deadPath } });
  for (const finding of foreign) {
    const message: RepairMessage = { code: 'plugin.foreign-dead-path', params: { path: finding.deadPath } };
    messages.push(message);
    blocked.push(message);
  }

  if (own.length === 0) return { findings: messages, actions: [], blocked, pending: [] };

  const dirs = canonicalPluginDirs(opts.stateDir);
  const exists = opts.exists ?? ((p: string): boolean => fs.existsSync(p));
  const missing = [dirs.inbox, dirs.search, dirs.retry].filter((dir) => !exists(dir));
  // actionId 必须**每个 stateDir 各不相同**（一台机器上可能有多支盘/多个身份目录）——
  // 用路径摘要而不是目录名（目录名 `<data>/state/<id>` 的父目录名恒为 `state`，会撞）。
  const identity = createHash('sha256').update(path.resolve(opts.stateDir).toLowerCase()).digest('hex').slice(0, 8);
  const actions: RepairAction[] = [
    {
      actionId: `plugin-paths:${identity}`,
      code: 'plugin.rebase',
      params: { path: configPath, count: own.length },
      requiresConfirmation: false,
      backup: true,
      targets: [...missing, configPath],
    },
  ];
  return { findings: messages, actions, blocked, pending: [{ stateDir: opts.stateDir, configPath, dirs }] };
}

/**
 * 执行一条重归并。**先备份后写**，写失败返回 `false`（调用方如实报 failed）。
 *
 * `backup` 由调用方持有（一处备份目录管整轮），这里只负责"要不要放弃"。
 */
export function applyPluginRebase(opts: {
  stateDir: string;
  backup: (file: string) => string | null;
  log: (line: string) => void;
}): { ok: boolean; reason: string } {
  const configPath = path.join(opts.stateDir, STATE_CONFIG_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    return { ok: false, reason: 'read-failed' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'not-object' };
  // ⚠️ junction/symlink 红线：只写**文件本身**（configPath 可能是链接 ⇒ 拒绝）
  if (!isRegularFileNoFollow(configPath)) return { ok: false, reason: UNSAFE_TARGET_REASON };

  // 目录先落地：配置指向不存在的目录 = 把"死盘符"换成"还没建"，网关一样拒启
  const failures = materializePluginDirs(opts.stateDir);
  if (failures.length > 0) return { ok: false, reason: 'plugin-dir-missing' };

  const dirs = canonicalPluginDirs(opts.stateDir);
  const rebased = rebasePluginConfig(parsed, dirs);
  if (!rebased.changed) return { ok: true, reason: 'already-current' };

  if (opts.backup(configPath) === null) return { ok: false, reason: 'backup-failed' };
  try {
    writeJsonAtomic(configPath, rebased.config);
  } catch {
    return { ok: false, reason: 'write-failed' };
  }
  opts.log(`plugin-paths rebased ${configPath}`);
  return { ok: true, reason: 'rebased' };
}
