/**
 * 「我们自己的技能」的 IPC 面（T-a2）。
 *
 * 薄薄一层：解析随包目录 → 找网关要安装目录 → 调 `bundled.ts` 里的纯逻辑。
 * **不做业务判断**（哪个算装上、slug 合不合法、路径会不会逃逸），那些都在
 * `bundled.ts` 里，有它自己的单测。
 *
 * ## 安装目录为什么**不**从渲染层传
 *
 * 渲染层能把 `skills.status` 里的 `managedSkillsDir` 读出来，让它传上来最省事 ——
 * 但那等于**把一条任意的绝对路径交给"删目录"这个动作**。
 * 所以渲染层只传 `{gatewayId, agentId, slug}`，目录由主进程**问网关要**
 *（`skills.status` 自己会报，实测 2026-09-20）。渲染层永远碰不到路径。
 *
 * ## 装/卸之后为什么要多打一条 RPC
 *
 * 网关对每个 agent 缓存一份技能表，**只动磁盘它看不见**（机制、代码位置与实测见
 * `cache-refresh.ts` 的注释）。所以装/卸成功之后再通知一下；通知是**尽力而为**的，
 * 失败只记日志，绝不让装/卸本身变成失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import type { AgentListResponse, IpcResult, OurSkillsListResult } from '@clawwork/shared';
import { resolveCatalogAgentId } from '@clawwork/core';
import { getGatewayClient } from '../ws/index.js';
import {
  adoptOrphanedSkillRecords,
  applyOwnedSkillUpdate,
  decodeSkillRecord,
  encodeSkillRecord,
  installBundledSkill,
  isBundledSkillInstalled,
  managedFileShas,
  missingBundledSkills,
  parseOurSkillFrontmatter,
  planSkillSync,
  readBundledSkills,
  readInstalledSkillContent,
  readSkillFileSha,
  removeBundledSkill,
  resolveInstallDir,
  skillContentSha,
  skillDirFilePaths,
  stageBundledSkillPackage,
  type ManagedSkillRecordV2,
  type SkillConflictReason,
  type SkillUpdatePlan,
  type SkillUpdateTransactionOptions,
  type StagedSkillPackage,
} from './bundled.js';
import { readConfig, updateConfig } from '../workspace/config.js';
import { notifySkillCacheChange, type SkillCacheClient } from './cache-refresh.js';
import { getDebugLogger } from '../debug/index.js';
import { resolveOurSkillsRoot } from './locate.js';
import { checkSlidegenLauncherOwnership, configureSlidegenRuntime } from './slidegen-runtime.js';

function ipcError(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
}

function ourSkillsRoot(): string | undefined {
  return resolveOurSkillsRoot({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
}

function configureDeckRuntime(managedDir: string) {
  return configureSlidegenRuntime({
    root: ourSkillsRoot(),
    managedDir,
    isPackaged: app.isPackaged,
    executable: process.execPath,
    appPath: app.getAppPath(),
  });
}

type SkillInstallMode = 'missing' | 'verified-update' | 'confirmed-repair';

/** 单个技能这一轮的处置结果（ensure 与显式安装共用的词表）。 */
type SkillChangeOutcome =
  | { kind: 'installed'; backupDir?: string }
  | { kind: 'upgraded'; backupDir?: string }
  | { kind: 'repaired'; backupDir?: string }
  | { kind: 'adopted' }
  | { kind: 'unchanged' }
  | { kind: 'conflict'; reason: SkillConflictReason; paths: string[] }
  | { kind: 'failed'; error: string; backupDir?: string };

/** deck-layout 的运行时侧车：不进厂商来源账，但要跟本次事务一起回滚（E1.3）。 */
const SLIDEGEN_RUNTIME_RELATIVE = 'scripts/generate-runtime.json';

/**
 * 显式修复的**持久**恢复根（`<userData>/skill-backups`）。
 *
 * 为什么不能用系统临时目录：这是"用户明确换掉自己的文件"这条路上唯一的后悔药，
 * 而临时目录会被系统清理（E2 实证：修复成功时那份备份连位置都没留下）。
 * 为什么不放进 `managedSkillsDir`：那棵树底下的目录会被技能发现器当成技能扫，
 * 恢复资产不能被误认成一个技能 —— 所以放在 userData 根下，与任何技能目录都不同树。
 * 拿不到 userData 时回 `undefined`（退回临时目录），绝不因此让修复本身失败。
 */
function skillRecoveryRoot(): string | undefined {
  try {
    const userData = app.getPath('userData');
    return userData ? path.join(userData, 'skill-backups') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 回滚**本技能**的来源账（只动这一个 slug）。
 *
 * ⚠️ 必须"读**最新**配置再合并"：同一轮 ensure 里别的技能刚写下的记录不能被我们拿
 *    安装前的快照整体写回 —— 那正是旧代码末尾 `nextRecords` 的形状。
 * ⚠️ 这里不再抛：账回写不了也要以**文件回滚**为准，不能让二次失败掩盖最初的失败原因。
 */
function restoreSkillRecord(managedDir: string, slug: string, previous: string | undefined): void {
  try {
    const existing = readConfig()?.bundledSkillRecords ?? {};
    const forDir = { ...(existing[managedDir] ?? {}) };
    if (typeof previous === 'string') forDir[slug] = previous;
    else delete forDir[slug];
    updateConfig({ bundledSkillRecords: { ...existing, [managedDir]: forDir } });
  } catch (error) {
    getDebugLogger().warn({
      // `DebugDomain` 是闭集、里面没有 skills ⇒ 归到 gateway（同一条通道语义）。
      domain: 'gateway',
      event: 'skills.record-restore-failed',
      message: `${slug}: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/** 盘上那份技能的**已装视图**（计划函数的输入；回调里的"读不了"一律抛）。 */
function installedSkillView(target: string, managedDir: string, slug: string) {
  return {
    skillSha: (() => {
      const content = readInstalledSkillContent(managedDir, slug);
      return content === null ? null : skillContentSha(content);
    })(),
    fileSha: (relativePath: string) => readSkillFileSha(target, relativePath),
  };
}

/**
 * 把一条技能记账**合并**进配置。
 *
 * 为什么必须"读最新配置再合并"：同一轮 ensure 里每个技能各写一次账，中间还有别的
 * 写配置的动作。拿安装前那份快照整体写回会把**别人刚写的**记录冲掉
 * （旧代码末尾的 `nextRecords` 正是这个形状 —— 它还会把公共安装出口刚写的新账覆盖回旧值）。
 */
function writeSkillRecord(managedDir: string, slug: string, record: ManagedSkillRecordV2): void {
  const existing = readConfig()?.bundledSkillRecords ?? {};
  const forDir = { ...(existing[managedDir] ?? {}), [slug]: encodeSkillRecord(record) };
  updateConfig({ bundledSkillRecords: { ...existing, [managedDir]: forDir } });
}

/**
 * 显式修复（用户已确认替换）时要清掉的厂商已删文件。
 *
 * 只认**记账里明确归我们**的那些：没有 v2 记账就分不出"厂商文件"与"用户文件"，
 * 一个都不删（保守方向）。
 */
function repairRemovals(managedDir: string, slug: string, nextFiles: Readonly<Record<string, string>>): string[] {
  const previous = decodeSkillRecord(readConfig()?.bundledSkillRecords?.[managedDir]?.[slug]);
  if (!previous) return [];
  return Object.keys(previous.files).filter(
    (relativePath) => !Object.prototype.hasOwnProperty.call(nextFiles, relativePath),
  );
}

/** 整包装完之后：按**厂商清单**从盘上收受管理文件的真实指纹（任一缺失 ⇒ `null` ⇒ 不记账）。 */
function installedVendorFiles(slug: string, target: string): Record<string, string> | null {
  const root = ourSkillsRoot();
  if (!root) return null;
  const vendorPaths = skillDirFilePaths(path.join(root, slug));
  return vendorPaths ? managedFileShas(target, vendorPaths) : null;
}

/**
 * ⭐ H1 的**唯一安装出口**：staging → 安装/差分应用 → 运行时配置 → 核验 → 记账 → 缓存通知。
 *
 * 显式安装（`skills:our-install`）与开机 ensure 的装/升都走它。三种 mode：
 *  · `missing` —— 目标还没装：整包写下去（只写不删，用户额外文件保留）。
 *  · `verified-update` —— 自动升级：调用方已按**已证明来源**的基线算好差分计划 +
 *    计划那一刻的盘上基线；这里只做"备份 → 差分 → 核验"，任何一步失败都**恢复旧文件**。
 *  · `confirmed-repair` —— 用户明确选择替换（显式安装按钮）的修复入口：厂商管理的
 *    文件全量重写（带备份与回滚），厂商已删的记账文件清掉；用户额外文件保留，
 *    并**保留一份可恢复的完整快照**（持久目录 + 清单）。
 *
 * ⭐ E1（2026-10-09 终审）：运行时配置、装后再次核验、写账**都在事务里**
 * （`finalize` 回调）。旧实现把它们留在事务外，于是 runtime 失败时盘上已是新字节、
 * 账还是旧字节 —— 恢复环境后普通 ensure 会把自己的写入判成 `user-modified` 假冲突，
 * 且**下一次不会自愈**（旧注释里"认领自愈"对已有 pkg2 不成立）。现在失败 = 整批回滚：
 * 旧文件、旧 runtime 侧车、本技能旧账一起回来，然后才轮到"下一次重试"。
 * 缓存通知留在事务成功**之后**（失败不通知）。
 */
function installAndRecordSkill(input: {
  gatewayId: string;
  managedDir: string;
  slug: string;
  /** 随包整目录清单（`readBundledSkills` 的 packageSha）；读不出 ⇒ 装得成但**不记账**。 */
  packageSha: string | undefined;
  mode: SkillInstallMode;
  /** `verified-update`：调用方算好的差分计划 + 同一份 staging + 计划时刻的盘上基线。 */
  update?: {
    plan: Extract<SkillUpdatePlan, { kind: 'update' }>;
    baseline: Readonly<Record<string, string | null>>;
    prepared: StagedSkillPackage;
  };
}): Exclude<SkillChangeOutcome, { kind: 'conflict' }> {
  const target = resolveInstallDir(input.managedDir, input.slug);
  if (!target) return { kind: 'failed', error: `技能标识非法：${String(input.slug)}` };

  /** 事务之前的账：回滚时只恢复这一个 slug。 */
  const previousRecord = readConfig()?.bundledSkillRecords?.[input.managedDir]?.[input.slug];
  let prepared = input.update?.prepared ?? null;
  let ownedStaging = false;
  let backupDir: string | undefined;

  const diagnostic = (message: string): void => {
    getDebugLogger().warn({ domain: 'gateway', event: 'skills.transaction-diagnostic', message });
  };

  /**
   * 装后收尾（E1）：runtime 配置 → 装后再次核验 → 写来源账。
   * 抛错 = 事务失败 ⇒ 走 `applyOwnedSkillUpdate` 的回滚出口（文件 + 侧车快照 + 本技能旧账）。
   */
  const finalize = (): void => {
    // 运行时配置：deck-layout 装完必须把启动器路径指向当前这台机器/这个安装位置。
    if (input.slug === 'deck-layout') {
      const runtime = configureDeckRuntime(input.managedDir);
      if (!runtime.ok) throw new Error(runtime.error ?? 'slidegen-runtime-unavailable');
    }
    // 装后**再次**核验：runtime 配置只写侧车，但"核验 → 记账"这条链中间不留窗口。
    const verifyFiles =
      input.mode === 'missing' || !prepared ? installedVendorFiles(input.slug, target) : prepared.files;
    if (verifyFiles) {
      for (const [relativePath, sha] of Object.entries(verifyFiles)) {
        if (readSkillFileSha(target, relativePath) !== sha) throw new Error('skill-install-verify-failed');
      }
    }
    // 记账：记的是**装完之后**的受管理文件（staging 清单；整包装从盘上按厂商清单收）。
    if (typeof input.packageSha !== 'string' || !verifyFiles) return;
    try {
      writeSkillRecord(input.managedDir, input.slug, {
        version: 2,
        packageSha: input.packageSha,
        files: verifyFiles,
      });
    } catch (error) {
      // 账写失败同样算事务失败：先把这个 slug 的旧账合并着恢复回去（不动别的技能），再抛给回滚出口。
      restoreSkillRecord(input.managedDir, input.slug, previousRecord);
      throw error;
    }
  };

  const transaction: SkillUpdateTransactionOptions = {
    finalize,
    diagnostic,
    snapshotPaths: input.slug === 'deck-layout' ? [SLIDEGEN_RUNTIME_RELATIVE] : [],
    // 恢复清单里的"事务前的账"：备份万一被留下（恢复失败），人工恢复要拿它对读。
    snapshotManifest: { mode: input.mode, recorded: previousRecord ?? null },
  };
  if (input.mode === 'confirmed-repair') {
    // 显式修复：备份要**完整**（含用户额外文件）且**持久**（系统会清临时目录），成功后保留。
    transaction.backupParentDir = skillRecoveryRoot();
    transaction.retainBackupOnSuccess = true;
    transaction.snapshotWholeDirectory = true;
  }

  try {
    if (input.mode === 'missing') {
      const result = installBundledSkill({
        root: ourSkillsRoot(),
        managedDir: input.managedDir,
        slug: input.slug,
        transaction,
      });
      if (!result.ok)
        return {
          kind: 'failed',
          error: result.error ?? 'install failed',
          ...(result.backupDir ? { backupDir: result.backupDir } : {}),
        };
      backupDir = result.backupDir;
    } else {
      if (!prepared) {
        const staged = stageBundledSkillPackage({ root: ourSkillsRoot(), slug: input.slug });
        if (!staged.ok) return { kind: 'failed', error: staged.error };
        prepared = staged.staged;
        ownedStaging = true;
      }
      const apply =
        input.mode === 'verified-update' && input.update
          ? applyOwnedSkillUpdate({
              stagedDir: prepared.dir,
              managedDir: input.managedDir,
              slug: input.slug,
              files: prepared.files,
              write: input.update.plan.write,
              remove: input.update.plan.remove,
              baseline: input.update.baseline,
              ...transaction,
            })
          : applyOwnedSkillUpdate({
              stagedDir: prepared.dir,
              managedDir: input.managedDir,
              slug: input.slug,
              files: prepared.files,
              write: Object.keys(prepared.files),
              remove: repairRemovals(input.managedDir, input.slug, prepared.files),
              baseline: null,
              ...transaction,
            });
      if (!apply.ok)
        return {
          kind: 'failed',
          error: apply.error ?? 'skill-update-failed',
          ...(apply.backupDir ? { backupDir: apply.backupDir } : {}),
        };
      backupDir = apply.backupDir;
    }

    notifySkillCache(input.gatewayId, input.slug, true, input.mode !== 'missing');
    const withBackup = backupDir ? { backupDir } : {};
    if (input.mode === 'missing') return { kind: 'installed', ...withBackup };
    return input.mode === 'confirmed-repair' ? { kind: 'repaired', ...withBackup } : { kind: 'upgraded' };
  } finally {
    // staging 清理失败不是"装失败"：事务已经成功、账也写了（E1.5 的同一条纪律）。
    if (ownedStaging) {
      try {
        prepared?.cleanup();
      } catch (error) {
        diagnostic(`staging-cleanup-failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/** 冲突要**可见**：进返回值（具名）之外，还落一条调试日志，排障时不用靠猜。 */
function warnSkillUpdateConflict(slug: string, reason: SkillConflictReason, paths: string[]): void {
  getDebugLogger().warn({
    // `DebugDomain` 是闭集、里面没有 skills ⇒ 归到 gateway（这条与技能缓存同一条通道语义）。
    domain: 'gateway',
    event: 'skills.update-conflict',
    message: `${slug}: ${reason} (${paths.join(', ')})`,
  });
}

/**
 * 问网关要技能安装目录（`managedSkillsDir`）。
 *
 * ⚠️ 拿不到就**明确失败**。降级成"本地猜一个 `<stateDir>/skills`"会把
 *    "网关还没连上"变成一个**看起来成功、其实写错地方**的安装 ——
 *    那正是最难查的那种 bug。宁可让用户看到"装不上，稍后再试"。
 */
async function managedSkillsDirOf(gatewayId: string, agentId?: string): Promise<string | null> {
  const gw = getGatewayClient(gatewayId);
  if (!gw?.isConnected) return null;
  try {
    let owner = agentId?.trim();
    if (!owner) {
      const catalog = await gw.listAgents();
      owner = resolveCatalogAgentId(
        Array.isArray(catalog.agents) ? (catalog as unknown as AgentListResponse) : undefined,
      );
    }
    if (!owner || getGatewayClient(gatewayId) !== gw || !gw.isConnected) return null;
    const report = await gw.getSkillsStatus(owner);
    if (getGatewayClient(gatewayId) !== gw || !gw.isConnected) return null;
    if (report.agentId && report.agentId !== owner) return null;
    const dir = (report as { managedSkillsDir?: unknown } | undefined)?.managedSkillsDir;
    return typeof dir === 'string' && dir.length > 0 ? dir : null;
  } catch {
    return null;
  }
}

/** 连上的客户端；没连上返回 null（15 秒超时的请求不该白挂一条）。 */
function liveGatewayClient(gatewayId: string): SkillCacheClient | null {
  const gw = getGatewayClient(gatewayId);
  return gw?.isConnected ? gw : null;
}

/**
 * 装/卸成功之后通知网关重扫。**不 await**：这是尽力而为的一下，
 * 让界面等它没有意义（最坏情况下对面不回，`GatewayClient` 要挂满 15 秒超时）。
 */
function notifySkillCache(gatewayId: string, slug: string, enabled: boolean, force = false): void {
  void notifySkillCacheChange({
    client: liveGatewayClient(gatewayId),
    slug,
    enabled,
    force,
    onWarn: ({ slug: s, error }) =>
      getDebugLogger().warn({
        // `DebugDomain` 是闭集、里面没有 skills ⇒ 归到 gateway（这条 warn 报的就是
        // 一条网关 RPC 没成），技能这层语义放在 event 名里。
        domain: 'gateway',
        event: 'skills.cache-refresh.failed',
        message: `${s}: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });
}

/**
 * 手机端（18780 API）用的随包技能操作。
 *
 * 只做转接：全部复用下面 registerSkillsHandlers 里同一套私有实现，
 * 不复制业务逻辑（安装/修复的判据、备份、冲突处理都在一处）。
 */
export async function mobileListBundledSkills(gatewayId: string, agentId?: string) {
  const skills = readBundledSkills(ourSkillsRoot());
  const managedDir = await managedSkillsDirOf(gatewayId, agentId);
  return {
    managedDirKnown: managedDir !== null,
    skills: skills.map((skill) => ({
      ...skill,
      installed: managedDir ? isBundledSkillInstalled(managedDir, skill.slug) : false,
    })),
  };
}

export async function mobileInstallBundledSkill(gatewayId: string, slug: string, agentId?: string) {
  const managedDir = await managedSkillsDirOf(gatewayId, agentId);
  if (!managedDir) return { ok: false as const, error: 'GATEWAY_UNAVAILABLE' };
  const skill = readBundledSkills(ourSkillsRoot()).find((entry) => entry.slug === slug);
  const mode: SkillInstallMode = isBundledSkillInstalled(managedDir, slug) ? 'confirmed-repair' : 'missing';
  const outcome = installAndRecordSkill({
    gatewayId,
    managedDir,
    slug,
    packageSha: skill?.packageSha,
    mode,
  });
  if (outcome.kind === 'failed') return { ok: false as const, error: outcome.error };
  const backupDir = 'backupDir' in outcome ? outcome.backupDir : undefined;
  return backupDir ? { ok: true as const, result: { backupDir } } : { ok: true as const };
}

export async function mobileRemoveBundledSkill(gatewayId: string, slug: string, agentId?: string) {
  const managedDir = await managedSkillsDirOf(gatewayId, agentId);
  if (!managedDir) return { ok: false as const, error: 'GATEWAY_UNAVAILABLE' };
  const result = removeBundledSkill({ managedDir, slug });
  if (result.ok) notifySkillCache(gatewayId, slug, false);
  return result;
}

export function registerSkillsHandlers(): void {
  /**
   * 列出随包技能。**网关没连上也能列**（`installed` 全为 `false`）——
   * 技能市场是"我们有什么"，不该因为网关没起来就整页空着。
   *
   * ⚠️ **返回类型必须显式写出来**。`ipcMain.handle` 的返回值不参与类型检查，
   *    所以"handler 回什么形状"和"渲染层按什么形状读"这两件事**编译器管不着** ——
   *    第一版就是在这里栽的：handler 回的是**扁平**的 `{ ok, managedDirKnown, skills }`，
   *    而渲染层按 `IpcResult` 约定的 `res.result.skills` 去读 ⇒ 永远是 undefined ⇒
   *    整页显示"读取失败"。**单测没抓到**，因为测试里的桩是按渲染层的假设写的
   *    ——桩与真身各写一遍，就是这个形状的假绿。实机第一次点进去就露了。
   *    写上返回类型之后，再漂移 `typecheck` 就会红。
   */
  ipcMain.handle(
    'skills:our-list',
    async (_event, payload: { gatewayId?: string; agentId?: string } = {}): Promise<IpcResult<OurSkillsListResult>> => {
      try {
        const skills = readBundledSkills(ourSkillsRoot());
        const managedDir = payload?.gatewayId ? await managedSkillsDirOf(payload.gatewayId, payload.agentId) : null;
        return {
          ok: true,
          result: {
            managedDirKnown: managedDir !== null,
            skills: skills.map((skill) => ({
              ...skill,
              installed: managedDir ? isBundledSkillInstalled(managedDir, skill.slug) : false,
            })),
          },
        };
      } catch (err) {
        return ipcError(err);
      }
    },
  );

  ipcMain.handle(
    'skills:our-install',
    async (_event, payload: { gatewayId: string; agentId?: string; slug: string }) => {
      try {
        const managedDir = await managedSkillsDirOf(payload.gatewayId, payload.agentId);
        if (!managedDir) return { ok: false, error: 'GATEWAY_UNAVAILABLE' };
        const skill = readBundledSkills(ourSkillsRoot()).find((entry) => entry.slug === payload.slug);
        // ⭐ H1：显式安装是**用户明确的一次选择** ⇒ 已装的那个走 confirmed-repair
        //    （厂商文件全量重写，带备份/回滚/核验），没装的走 missing。
        //    这也是"未知旧盘"的**修复出口** —— 开机 ensure 永远不会替用户做这个选择。
        const mode: SkillInstallMode = isBundledSkillInstalled(managedDir, payload.slug)
          ? 'confirmed-repair'
          : 'missing';
        const outcome = installAndRecordSkill({
          gatewayId: payload.gatewayId,
          managedDir,
          slug: payload.slug,
          packageSha: skill?.packageSha,
          mode,
        });
        // E2/E3：显式修复成功时把**保留下来的恢复备份位置**交给界面。
        // 失败那条路的备份位置已经在 `error` 里（`restore-failed:…; 恢复备份已保留：<路径>`）——
        // 用户明确替换了自己的文件，至少要知道"出问题时去哪儿找回原来的那份"。
        if (outcome.kind === 'failed') return { ok: false, error: outcome.error };
        // ⚠️ 这里曾有一条 `kind === 'conflict'` 分支 —— 它是**死代码**（2026-10-16）：
        //    `installAndRecordSkill` 的显式路径只回 installed/upgraded/repaired/failed
        //    （`missing` 只写不删、`confirmed-repair` 是用户点过确认的整目录重写，
        //    都不会判冲突），冲突只出现在 **ensure/计划** 那条链上（`skills:our-ensure`
        //    自己把它 push 进 `conflicts[]`）。返回类型已收窄为
        //    `Exclude<SkillChangeOutcome, { kind: 'conflict' }>`，所以以后谁再让这条路上
        //    冒出 conflict，`typecheck` 会当场红 —— 不用靠人记得。
        const backupDir = 'backupDir' in outcome ? outcome.backupDir : undefined;
        return backupDir ? { ok: true, result: { backupDir } } : { ok: true };
      } catch (err) {
        return ipcError(err);
      }
    },
  );

  /**
   * ⭐ 开机自装（2026-09-24；H1 起升级判据换成"版本化来源记录 + 差分计划"）。
   *
   * 三层语义：
   *  ① **缺了就补**（`missing`）：已装的**不动**；
   *  ② **我们自己放旧了**（随包版本变了、盘上还是我们装的那份）⇒ 差分升级；
   *  ③ **来源存疑**（无账/旧账/用户改过）⇒ 能认领就认领（`adopt`，只记账不写盘）、
   *     认不领就返回**具名冲突**（`conflicts`）并**保留现场** —— 留给用户走显式安装
   *     （confirmed-repair）那条路，开机绝不替用户做"替换"这个决定。
   *
   * ⚠️ 永远返回 `ok:true`（只要拿到目录）：这是**尽力而为**的启动步骤，
   *    装不上/有冲突不该让调用方把它当失败处理，更不该挡住启动 ——
   *    结果里带上明细（installed / upgraded / adopted / conflicts / failed）供日志与排障用。
   * ⚠️ 冲突**不算 failed**：重试一次还是同一个冲突，把它算失败只会让启动流程白重试两次。
   */
  ipcMain.handle(
    'skills:our-ensure',
    async (_event, payload: { gatewayId: string; agentId?: string } = { gatewayId: '' }) => {
      try {
        const managedDir = await managedSkillsDirOf(payload.gatewayId, payload.agentId);
        if (!managedDir) return { ok: false, error: 'GATEWAY_UNAVAILABLE' };

        const root = ourSkillsRoot();
        const skills = readBundledSkills(root);
        const storedRecords = readConfig()?.bundledSkillRecords ?? {};
        // ⭐ T31（缺口 3）：孤儿键（目录已不在盘上）的技能账先并回来 —— 否则换了网关/
        //    换了目录之后，这一侧的账是空的，planSkillSync 会把"我们自己装的旧版"判成
        //    `unverified-origin`，在健康盘上冒虚假冲突。
        const orphanAdoption = adoptOrphanedSkillRecords({
          records: storedRecords,
          managedDir,
          pathExists: (candidate) => fs.existsSync(candidate),
        });
        const records = orphanAdoption.records;
        if (orphanAdoption.migratedFrom.length > 0) {
          const next: Record<string, Record<string, string>> = { ...storedRecords, [managedDir]: records };
          for (const stale of orphanAdoption.migratedFrom) delete next[stale];
          try {
            updateConfig({ bundledSkillRecords: next });
          } catch (error) {
            getDebugLogger().warn({
              domain: 'gateway',
              event: 'skills.record-migrate-failed',
              message: `${orphanAdoption.migratedFrom.join(', ')}: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
        const missing = new Set(
          missingBundledSkills(skills, (slug) => isBundledSkillInstalled(managedDir, slug)).map((skill) => skill.slug),
        );

        const installed: string[] = [];
        const upgraded: string[] = [];
        const adopted: string[] = [];
        const failed: Array<{ slug: string; error: string }> = [];
        const conflicts: Array<{ slug: string; reason: SkillConflictReason; paths: string[] }> = [];

        for (const skill of skills) {
          const classify = (outcome: SkillChangeOutcome): void => {
            switch (outcome.kind) {
              case 'installed':
                installed.push(skill.slug);
                return;
              case 'upgraded':
              case 'repaired':
                upgraded.push(skill.slug);
                return;
              case 'adopted':
                adopted.push(skill.slug);
                return;
              case 'conflict':
                conflicts.push({ slug: skill.slug, reason: outcome.reason, paths: outcome.paths });
                warnSkillUpdateConflict(skill.slug, outcome.reason, outcome.paths);
                return;
              case 'failed':
                failed.push({ slug: skill.slug, error: outcome.error });
                return;
              case 'unchanged':
                return;
            }
          };

          if (missing.has(skill.slug)) {
            classify(
              installAndRecordSkill({
                gatewayId: payload.gatewayId,
                managedDir,
                slug: skill.slug,
                packageSha: skill.packageSha,
                mode: 'missing',
              }),
            );
            continue;
          }

          // 快路径：随包版本没变 ⇒ 一个字节都不动。**故意不在这里报"用户改过"** ——
          // 随包未变时没有任何东西要升，制造每开机的冲突噪音只会让人不再看它。
          if (typeof skill.packageSha !== 'string') continue; // 清单读不出 ⇒ 不猜、不升
          const decoded = decodeSkillRecord(records[skill.slug]);
          if (decoded && decoded.packageSha === skill.packageSha) continue;

          // deck-layout：自动升级前先核**启动器所有权**（用户改过的启动器一个字节都不许动）。
          // 记录基线本来也拦得住这一类，但这里给出的名字更准（脚本被改 vs 别的文件被改）。
          if (skill.slug === 'deck-layout') {
            const ownership = checkSlidegenLauncherOwnership(root, managedDir);
            if (!ownership.ok) {
              conflicts.push({
                slug: skill.slug,
                reason: ownership.error === 'slidegen-runtime-script-modified' ? 'user-modified' : 'unverified-origin',
                paths: ['scripts/generate.cjs'],
              });
              continue;
            }
          }

          const staged = stageBundledSkillPackage({ root, slug: skill.slug });
          if (!staged.ok) {
            failed.push({ slug: skill.slug, error: staged.error });
            continue;
          }
          try {
            const target = resolveInstallDir(managedDir, skill.slug);
            if (!target) {
              failed.push({ slug: skill.slug, error: `技能标识非法：${skill.slug}` });
              continue;
            }
            const plan = planSkillSync({
              packageSha: skill.packageSha,
              nextFiles: staged.staged.files,
              recorded: records[skill.slug],
              installed: installedSkillView(target, managedDir, skill.slug),
            });
            if (plan.kind === 'unchanged') continue;
            if (plan.kind === 'adopt') {
              // ⭐ E1.4：认领**不改厂商文件**，但"这套 runtime 在这台机器上能用"同样得先成立 ——
              //    否则先把新账写下去、再在循环尾的 runtime 配置里失败，账就成了**未核验的账**。
              //    认领的盘上内容就是当前包那份 ⇒ 需要的 runtime 只有 deck-layout 的启动器配置。
              if (skill.slug === 'deck-layout') {
                const runtime = configureDeckRuntime(managedDir);
                if (!runtime.ok) {
                  failed.push({ slug: skill.slug, error: runtime.error ?? 'slidegen-runtime-unavailable' });
                  continue;
                }
              }
              // 只认领**真实装后基线**（盘上每个受管理文件都与当前包逐字一致）：不写盘。
              writeSkillRecord(managedDir, skill.slug, plan.record);
              adopted.push(skill.slug);
              continue;
            }
            if (plan.kind === 'conflict') {
              /**
               * ⭐ 2026-10-17（产品决定，BUG-146）：**前账本时代**的随包技能（`records` 里
               * 根本没有这一项）在升级时无法核验来源，旧行为是永久保留 —— 结果模型读到的是
               * **旧版技能指令**（生图技能里还写着 `qwen-image-plus`，模型据此回答"不支持生图"）。
               *
               * 现在改为：**没有账、且盘上那份的 frontmatter 仍带我们这个 slug 的
               * `metadata.openclaw.skillKey`** ⇒ 认作产品旧版本，走**与「修复随包版本」
               * 同一条受控路径**（`confirmed-repair`：整目录备份并保留，然后写入当前包）。
               *
               * 反过来，形状认不出（没有 `---` frontmatter、用了块标量）或 skillKey 对不上 ⇒
               * 可能真是用户自己写的技能，**保持原样报冲突、交用户决定**（那条保护不放松）。
               */
              const installedText =
                records[skill.slug] === undefined ? readInstalledSkillContent(managedDir, skill.slug) : null;
              const installedShape = installedText ? parseOurSkillFrontmatter(installedText) : null;
              // 只有"盘上这份确实是我们随包技能的旧副本"才自动升级；
              // 形状认不出 / skillKey 不是这个 slug ⇒ 可能真是用户自己写的，保持保留并报冲突。
              const looksLikeOurOlderCopy = installedShape !== null && installedShape.skillKey === skill.slug;
              if (records[skill.slug] === undefined && looksLikeOurOlderCopy) {
                classify(
                  installAndRecordSkill({
                    gatewayId: payload.gatewayId,
                    managedDir,
                    slug: skill.slug,
                    packageSha: skill.packageSha,
                    mode: 'confirmed-repair',
                  }),
                );
                continue;
              }
              conflicts.push({ slug: skill.slug, reason: plan.reason, paths: plan.paths });
              warnSkillUpdateConflict(skill.slug, plan.reason, plan.paths);
              continue;
            }
            // 应用前把**计划那一刻**盘上的值冻成基线：计划之后又被人动过 ⇒ 应用失败而不是覆盖。
            const baseline: Record<string, string | null> = {};
            for (const relativePath of [...plan.write, ...plan.remove])
              baseline[relativePath] = readSkillFileSha(target, relativePath);
            classify(
              installAndRecordSkill({
                gatewayId: payload.gatewayId,
                managedDir,
                slug: skill.slug,
                packageSha: skill.packageSha,
                mode: 'verified-update',
                update: { plan, baseline, prepared: staged.staged },
              }),
            );
          } finally {
            try {
              staged.staged.cleanup();
            } catch (error) {
              getDebugLogger().warn({
                domain: 'gateway',
                event: 'skills.transaction-diagnostic',
                message: `staging-cleanup-failed: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          }
        }

        // 每次开机都把 deck-layout 的启动器路径刷成当前这台机器/这个安装位置。
        // 有失败或有冲突说明现场不是"干净的我们的盘"，不在这里动它。
        if (
          isBundledSkillInstalled(managedDir, 'deck-layout') &&
          !failed.some((item) => item.slug === 'deck-layout') &&
          !conflicts.some((item) => item.slug === 'deck-layout')
        ) {
          const runtime = configureDeckRuntime(managedDir);
          if (!runtime.ok) failed.push({ slug: 'deck-layout', error: runtime.error ?? 'slidegen-runtime-unavailable' });
        }

        return { ok: true, result: { installed, upgraded, adopted, conflicts, failed } };
      } catch (err) {
        return ipcError(err);
      }
    },
  );

  ipcMain.handle(
    'skills:our-remove',
    async (_event, payload: { gatewayId: string; agentId?: string; slug: string }) => {
      try {
        const managedDir = await managedSkillsDirOf(payload.gatewayId, payload.agentId);
        if (!managedDir) return { ok: false, error: 'GATEWAY_UNAVAILABLE' };
        const result = removeBundledSkill({ managedDir, slug: payload.slug });
        if (result.ok) notifySkillCache(payload.gatewayId, payload.slug, false);
        return result;
      } catch (err) {
        return ipcError(err);
      }
    },
  );
}
