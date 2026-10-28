/**
 * 修复项 #3 · 提示词区块陈旧 / 损坏（SPEC 二·MVP 3，事故背书 = 视频拒答类"注入层陈旧"）。
 *
 * ## 现场
 *
 * 能力边界是一段带**版本标记**的区块，由应用在每次启动时写进 main 助手的 `AGENTS.md`
 * （运行时每轮全文注入；**子代理会话只注入它**）。真实现场：主罗盘被告知"视频不支持"
 * （区块停在 v2），而别的助手照着随包技能照常出片 —— 用户看到的是"有的助手可以、
 * 有的直接说不可以"。
 *
 * 区块**只由应用写**。应用写不动的时候（网关起不来、盘读过、RPC 超时），
 * 区块就会永远停在旧版本，而用户毫无办法 —— 这就是本项要覆盖的洞。
 *
 * ## 判据（**版本号**，不是内容比对）
 *
 * 应用每次启动都会带着**真实模型目录**再注入一遍，所以内容随时可能合法地变
 * （模型上下线）。拿内容做判据会把"目录变了"误报成"区块坏了"，还会把好区块
 * 反复重写。⇒ 只认三件事：
 *   ① 区块**在不在**（带起止标记）
 *   ② 两个标记**配不配对**（半写就是坏）
 *   ③ 版本号与**当前代码**比：`<` 是陈旧（可修）；`>` 是**更新的构建写的**（**不动**）
 *
 * ## 修法
 *
 * `mergeCapabilityBoundaryBlock`（应用自己那个纯函数）—— **区块外一字不动**。
 *
 * ⚠️ 离线修复拿不到模型目录，写进去的那一段会退化成"以工作台模型选择器为准"。
 *    **这是有界的**：应用下次启动会带真实目录再注入一遍，内容不同即重写；而修复模式
 *    与应用**不许同时跑**（活锁保护），所以这段退化窗口里根本没有会话在跑。
 *    如实写在报告里，不假装无损。
 *
 * ⚠️ **不许降级**：区块版本比当前代码还新 ⇒ 只报告（`capability.block-newer`）。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  CAPABILITY_BOUNDARY_PROMPT_VERSION,
  buildCapabilityBoundaryPrompt,
  buildCapabilityRegistry,
  capabilityBoundaryStartMarker,
  mergeCapabilityBoundaryBlock,
} from '@clawwork/core';
import type { RepairAction, RepairMessage } from '@clawwork/shared';
import { STATE_CONFIG_FILE } from '../targets.js';
import { UNSAFE_TARGET_REASON, isRegularFileNoFollow } from '../safe-fs.js';

export const AGENT_FILE_NAME = 'AGENTS.md';
/** 主助手 id（区块只写给它；见 `capability/capability-boundary-prompt.ts`）。 */
export const MAIN_AGENT_ID = 'main';

/**
 * 标记前缀从**上游函数**里抠，不另抄一份字面量（抄一份就多一个漂移点）。
 * `capabilityBoundaryStartMarker()` = `<!-- partner-w-capability-boundary:3:begin -->`
 */
function markerPrefix(): string {
  const sample = capabilityBoundaryStartMarker();
  const open = '<!-- ';
  return sample.startsWith(open) ? sample.slice(open.length, sample.indexOf(':')) : 'partner-w-capability-boundary';
}

export type BlockState =
  /** 整段区块不在（`AGENTS.md` 里一个标记都没有）。 */
  | { kind: 'absent' }
  /** 标记在、但不配对（半写：只有 begin 没 begin…end 之类）—— 坏。 */
  | { kind: 'malformed' }
  /** 区块完整，带版本号。 */
  | { kind: 'present'; version: number };

/** 从 `AGENTS.md` 内容里读出区块状态（**纯函数**）。 */
export function readCapabilityBlockState(content: string): BlockState {
  const prefix = markerPrefix();
  const begin = new RegExp(`<!-- ${prefix}:(\\d+):begin -->`, 'gu');
  const end = new RegExp(`<!-- ${prefix}:(\\d+):end -->`, 'gu');
  const begins = [...content.matchAll(begin)];
  const ends = [...content.matchAll(end)];
  if (begins.length === 0 && ends.length === 0) return { kind: 'absent' };
  if (begins.length !== 1 || ends.length !== 1) return { kind: 'malformed' };
  const beginIndex = begins[0]?.index ?? -1;
  const endIndex = ends[0]?.index ?? -1;
  if (beginIndex < 0 || endIndex < beginIndex) return { kind: 'malformed' };
  const version = Number(begins[0]?.[1]);
  if (!Number.isInteger(version)) return { kind: 'malformed' };
  return { kind: 'present', version };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从 `openclaw.json` 里读主助手的工作区（`agents.entries.main.workspace` → 默认值）。 */
export function readAgentWorkspace(raw: unknown, agentId: string = MAIN_AGENT_ID): string | null {
  if (!isRecord(raw)) return null;
  const agents = raw.agents;
  if (!isRecord(agents)) return null;
  const entries = agents.entries;
  if (isRecord(entries)) {
    const entry = entries[agentId];
    if (isRecord(entry) && typeof entry.workspace === 'string' && entry.workspace.trim().length > 0) {
      return entry.workspace;
    }
  }
  const defaults = agents.defaults;
  if (isRecord(defaults) && typeof defaults.workspace === 'string' && defaults.workspace.trim().length > 0) {
    return defaults.workspace;
  }
  return null;
}

export type CapabilityVerdict =
  | { kind: 'ok'; version: number }
  | { kind: 'missing' }
  | { kind: 'corrupt' }
  | { kind: 'stale'; version: number }
  | { kind: 'newer'; version: number }
  | { kind: 'unavailable'; reason: 'no-workspace' | 'no-file' };

export interface CapabilityFinding {
  stateDir: string;
  /** 读出问题的那份 `AGENTS.md`；`unavailable` 时为 null。 */
  filePath: string | null;
  verdict: CapabilityVerdict;
}

/** 判决（**纯函数**）：区块状态 + 当前代码版本 → 该怎么办。 */
export function classifyCapabilityBlock(state: BlockState): {
  kind: 'missing' | 'corrupt' | 'ok' | 'stale' | 'newer';
  version?: number;
} {
  if (state.kind === 'absent') return { kind: 'missing' };
  if (state.kind === 'malformed') return { kind: 'corrupt' };
  const current = CAPABILITY_BOUNDARY_PROMPT_VERSION;
  if (state.version < current) return { kind: 'stale', version: state.version };
  if (state.version > current) return { kind: 'newer', version: state.version };
  return { kind: 'ok', version: state.version };
}

/** 扫一个 state 目录（**只读、绝不抛**）。 */
export function scanCapabilityBlock(opts: { stateDir: string; agentId?: string }): CapabilityFinding {
  const configPath = path.join(opts.stateDir, STATE_CONFIG_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { stateDir: opts.stateDir, filePath: null, verdict: { kind: 'unavailable', reason: 'no-workspace' } };
  }
  const workspace = readAgentWorkspace(parsed, opts.agentId ?? MAIN_AGENT_ID);
  if (!workspace)
    return { stateDir: opts.stateDir, filePath: null, verdict: { kind: 'unavailable', reason: 'no-workspace' } };

  const filePath = path.join(workspace, AGENT_FILE_NAME);
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { stateDir: opts.stateDir, filePath, verdict: { kind: 'unavailable', reason: 'no-file' } };
  }
  const state = readCapabilityBlockState(content);
  const verdict = classifyCapabilityBlock(state);
  return {
    stateDir: opts.stateDir,
    filePath,
    verdict:
      verdict.kind === 'newer' || verdict.kind === 'stale' || verdict.kind === 'ok'
        ? { kind: verdict.kind, version: verdict.version ?? 0 }
        : { kind: verdict.kind },
  };
}

export interface CapabilityPlan {
  findings: RepairMessage[];
  actions: RepairAction[];
  skipped: RepairMessage[];
  pending: Array<{ filePath: string; verdict: CapabilityVerdict }>;
}

export function planCapabilityBlocks(findings: readonly CapabilityFinding[]): CapabilityPlan {
  const messages: RepairMessage[] = [];
  const actions: RepairAction[] = [];
  const skipped: RepairMessage[] = [];
  const pending: Array<{ filePath: string; verdict: CapabilityVerdict }> = [];

  findings.forEach((finding, index) => {
    const { verdict } = finding;
    if (verdict.kind === 'unavailable') {
      skipped.push({ code: `capability.${verdict.reason}`, params: { path: finding.stateDir } });
      return;
    }
    const filePath = finding.filePath as string;
    if (verdict.kind === 'ok') {
      messages.push({ code: 'capability.ok', params: { path: filePath, version: verdict.version } });
      return;
    }
    if (verdict.kind === 'newer') {
      messages.push({ code: 'capability.block-newer', params: { path: filePath, version: verdict.version } });
      skipped.push({ code: 'capability.no-downgrade', params: { path: filePath } });
      return;
    }
    const message: RepairMessage =
      verdict.kind === 'stale'
        ? {
            code: 'capability.block-stale',
            params: { path: filePath, version: verdict.version, current: CAPABILITY_BOUNDARY_PROMPT_VERSION },
          }
        : { code: `capability.block-${verdict.kind}`, params: { path: filePath } };
    messages.push(message);
    actions.push({
      actionId: `capability-block:${index}`,
      code: 'capability.rewrite-block',
      params: { path: filePath, version: CAPABILITY_BOUNDARY_PROMPT_VERSION },
      requiresConfirmation: false,
      backup: true,
      targets: [filePath],
    });
    pending.push({ filePath, verdict });
  });

  return { findings: messages, actions, skipped, pending };
}

/**
 * 重写一个 `AGENTS.md` 的区块。先备份后写；`changed === false` 时**一个字节都不写**
 * （幂等的落点就在这一句：跑第二遍时区块已是当前版本 ⇒ 不写、不产生备份）。
 */
export function applyCapabilityRewrite(opts: {
  filePath: string;
  backup: (file: string) => string | null;
  log: (line: string) => void;
}): { ok: boolean; reason: string } {
  let content: string;
  try {
    content = fs.readFileSync(opts.filePath, 'utf8');
  } catch {
    return { ok: false, reason: 'read-failed' };
  }
  // ⚠️ junction/symlink 红线：AGENTS.md 必须是**文件本身**（可能是链接 ⇒ 拒绝，
  //    否则会把内容写到链接指向的真实文件上）
  if (!isRegularFileNoFollow(opts.filePath)) return { ok: false, reason: UNSAFE_TARGET_REASON };

  const block = buildCapabilityBoundaryPrompt(buildCapabilityRegistry({ models: [] }));
  const merged = mergeCapabilityBoundaryBlock(content, block);
  if (!merged.changed) return { ok: true, reason: 'already-current' };
  if (opts.backup(opts.filePath) === null) return { ok: false, reason: 'backup-failed' };
  try {
    fs.writeFileSync(opts.filePath, merged.content, 'utf8');
  } catch {
    return { ok: false, reason: 'write-failed' };
  }
  opts.log(`capability-block rewritten ${opts.filePath}`);
  return { ok: true, reason: 'rewritten' };
}
