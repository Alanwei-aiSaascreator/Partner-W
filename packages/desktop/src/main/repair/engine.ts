/**
 * 修复引擎（FEAT-03）—— **唯一真源**：`--repair` 独立窗口与「设置 → 诊断与修复」共用它。
 *
 * ## 三个不可让步的性质（SPEC 三）
 *
 * 1. **先预览后动手**：`scan()` 只读，产出的是"发现了什么 + 打算改哪个文件"；
 *    写盘只发生在 `apply(actionIds)`，且只认**同一份扫描**里发出来的 actionId
 *    （不认路径、不认"上次那份计划"—— 盘上的东西可能已经变了）。
 * 2. **先备份后修改**：每条写动作先备份，备份不成 ⇒ **放弃那一条**（不留半成品现场）。
 * 3. **幂等**：跑第二遍时所有判据都已经"已经是当前状态" ⇒ 零动作、零写盘、**零备份目录**。
 *    这条不是口号，是每一项各自的判据设计（锁被重命名后不再叫 `*.lock`、插件段已归并、
 *    区块版本已是当前）—— `test/repair-engine.test.ts` 用真实目录逐项钉住。
 *
 * ## 活锁保护（SPEC 四）
 *
 * 本机有Partner-W在跑（单实例锁的主人还活着）、或 18789 上有监听、或扫到一把
 * **实锤在跑**的网关锁 ⇒ `liveInstance` 非 null ⇒ **所有写动作一律 skipped**。
 * 理由：主程序启动时正在改同一批文件（它自己也在写 `openclaw.json`、也在写锁），
 * 并发写就是把用户的配置搅成两半。
 * 活锁下仍然可用的是：只读全检、以及**只新建一个文件**的诊断包（白名单见
 * `LIVE_SAFE_ACTION_IDS` —— 客服最需要它的时刻恰恰是"应用开着、用户正被卡住"）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  RepairAction,
  RepairApplyResult,
  RepairDiagnosticsResult,
  RepairItemReport,
  RepairMessage,
  RepairOutcome,
  RepairRestoreResult,
  RepairScanReport,
} from '@clawwork/shared';
import { RepairBackup, repairRunStamp, restoreRepairBackup } from './backup.js';
import { planSkillRecords } from './skill-records.js';
import { appOwnedRoots, isPathWithinAnyRoot, type RepairTargets } from './targets.js';
import {
  applyGatewayLockQuarantine,
  planGatewayLocks,
  scanGatewayLocks,
  type GatewayLockFinding,
  type GatewayLockProbe,
} from './items/gateway-locks.js';
import { applyPluginRebase, planPluginPaths, scanPluginPaths } from './items/plugin-paths.js';
import { applyCapabilityRewrite, planCapabilityBlocks, scanCapabilityBlock } from './items/capability-block.js';
import { inspectEnvironment } from './items/environment.js';
import { writeDiagnosticsPack } from './items/diagnostics-pack.js';

export const DIAGNOSTICS_ACTION_ID = 'diagnostics-pack:export';

/**
 * 活锁下**仍然允许**的动作：只**新建一个文件**、不改任何既有内容的那些。
 *
 * 为什么给诊断包开这一个口子：客服最需要它的时候恰恰是"应用开着、用户正被卡住"
 * 的时候 —— 把所有写动作一并禁掉，等于在最需要证据的场景里不给证据。
 * 它只往数据根写一个新的 zip（SPEC 三·5：不自动上传），不碰锁、不碰配置、不碰用户文件。
 *
 * ⚠️ 这个集合**只许加这一类**动作。任何会改动既有文件的东西（哪怕只是改名）都不行。
 */
const LIVE_SAFE_ACTION_IDS: ReadonlySet<string> = new Set([DIAGNOSTICS_ACTION_ID]);

/** 活锁探测的可注入面（默认实现见 `host.ts`）。 */
export interface LiveInstanceProbe {
  /** 单实例锁的主人还活着吗。 */
  ownerAlive: () => { alive: boolean; pid: number } | null;
  /** 本机网关端口上的监听者 pid（没有监听 ⇒ null）。 */
  portListener: () => number | null;
}

/**
 * 技能账（配置里的 `bundledSkillRecords`）的读写面 —— 可注入（默认实现见 `host.ts`）。
 *
 * 为什么做成注入面而不是直接 import `workspace/config.js`：那一支拉进 `electron`
 * （与 `targets.ts` 不 import `state-config.ts` 同一条理由），而这一项要能在不起
 * Electron 的测试里逐条钉住。
 */
export interface SkillRecordsAccess {
  /**
   * 读配置里那份账 + 它所在的**文件路径**（迁移前要先备份这个文件）。
   * 配置不存在 / 读不出来 ⇒ `null`（这一项报"读不到"，不当成"没问题"）。
   */
  read: () => { records: Record<string, Record<string, string>>; configPath: string } | null;
  /** 整份写回（`bundledSkillRecords` 是整字段替换）。成功 ⇒ `true`。 */
  write: (records: Record<string, Record<string, string>>) => boolean;
}

export interface RepairEngineOptions {
  targets: RepairTargets;
  appVersion: string;
  /** 随包运行时根（环境自查的第②项要它）。 */
  bundledRuntimeRoot: string | null;
  isPackaged: boolean;
  now: () => Date;
  liveInstance: LiveInstanceProbe;
  /** 锁存活核验（生产用默认实现；测试注入假进程表）。 */
  lockProbe?: GatewayLockProbe;
  /** 技能账读写（生产用 `host.ts` 的默认实现；测试注入内存账）。 */
  skillRecords?: SkillRecordsAccess;
}

/** 一条待办在**同一份扫描**里的执行体（`apply` 只会执行这里面登记过的）。 */
type Executor = (backup: RepairBackup) => RepairOutcome;

export interface RepairSession {
  scan(): RepairScanReport;
  apply(actionIds: readonly string[]): RepairApplyResult;
  exportDiagnostics(): RepairDiagnosticsResult;
  /** 还原某一轮修复（`apply` 回给界面的 `backupDir`）。活锁下拒绝。 */
  restore(backupDir: string): RepairRestoreResult;
}

function baseReport(id: RepairItemReport['id'], seed: Partial<RepairItemReport> = {}): RepairItemReport {
  return {
    id,
    severity: seed.severity ?? 'ok',
    findings: seed.findings ?? [],
    actions: seed.actions ?? [],
    blocked: seed.blocked ?? [],
    skipped: seed.skipped ?? [],
  };
}

function outcome(actionId: string, ok: boolean, reason: string, backupPath: string | null = null): RepairOutcome {
  return { actionId, status: ok ? 'applied' : 'failed', message: { code: `apply.${reason}` }, backupPath };
}

export function createRepairSession(options: RepairEngineOptions): RepairSession {
  const { targets } = options;
  let lastScan: RepairScanReport | null = null;
  let executors = new Map<string, Executor>();

  const detectLiveInstance = (locks: readonly GatewayLockFinding[]): RepairMessage | null => {
    const owner = options.liveInstance.ownerAlive();
    if (owner?.alive) return { code: 'live.instance-owner', params: { pid: owner.pid } };
    const port = options.liveInstance.portListener();
    if (port !== null) return { code: 'live.port-listener', params: { pid: port } };
    const liveLock = locks.find(
      (finding) => finding.verdict.kind === 'live' && finding.verdict.reason === 'start-time-match',
    );
    if (liveLock) return { code: 'live.gateway-lock', params: { path: liveLock.path } };
    return null;
  };

  const scan = (): RepairScanReport => {
    const nextExecutors = new Map<string, Executor>();
    const items: RepairItemReport[] = [];

    // ---- #1 坏锁 / 半写锁 ----------------------------------------------------
    const locks = targets.stateDirs.flatMap((stateDir) => scanGatewayLocks({ stateDir, probe: options.lockProbe }));
    const lockPlan = planGatewayLocks(locks);
    const lockFindings = targets.stateDirs.length === 0 ? [{ code: 'lock.no-state' }] : lockPlan.findings;
    for (const action of lockPlan.actions) {
      const finding = locks.find((item) => item.path === action.params?.path);
      if (!finding) continue;
      nextExecutors.set(action.actionId, (backup) => {
        const result = applyGatewayLockQuarantine({
          lockPath: finding.path,
          stamp: repairRunStamp(options.now()),
          probe: options.lockProbe,
          backup: (file) => backup.backupFile(file),
          log: (line) => backup.log(line),
        });
        return outcome(action.actionId, result.ok, result.reason, result.backupPath);
      });
    }
    items.push(
      baseReport('gateway-locks', {
        severity: lockPlan.actions.length > 0 ? 'attention' : 'ok',
        findings:
          lockFindings.length > 0 ? lockFindings : [{ code: 'lock.none', params: { count: targets.stateDirs.length } }],
        actions: lockPlan.actions,
        skipped: targets.stateDirs.length === 0 ? [{ code: 'lock.no-state' }] : [],
      }),
    );

    // ---- #2 失效插件路径 ----------------------------------------------------
    const pluginPlans = targets.stateDirs.map((stateDir) => ({
      stateDir,
      plan: planPluginPaths({ stateDir, findings: scanPluginPaths({ stateDir }) }),
    }));
    const pluginFindings = pluginPlans.flatMap(({ plan }) => plan.findings);
    const pluginActions = pluginPlans.flatMap(({ plan }) => plan.actions);
    const pluginBlocked = pluginPlans.flatMap(({ plan }) => plan.blocked);
    for (const { stateDir, plan } of pluginPlans) {
      for (const action of plan.actions) {
        nextExecutors.set(action.actionId, (backup) => {
          const result = applyPluginRebase({
            stateDir,
            backup: (file) => backup.backupFile(file),
            log: (line) => backup.log(line),
          });
          return outcome(action.actionId, result.ok, result.reason);
        });
      }
    }
    items.push(
      baseReport('plugin-paths', {
        severity: pluginActions.length > 0 ? 'attention' : pluginBlocked.length > 0 ? 'broken' : 'ok',
        findings: pluginFindings.length > 0 ? pluginFindings : [{ code: 'plugin.none' }],
        actions: pluginActions,
        blocked: pluginBlocked,
        skipped: targets.stateDirs.length === 0 ? [{ code: 'plugin.no-state' }] : [],
      }),
    );

    // ---- #3 提示词区块 ------------------------------------------------------
    const capabilities = targets.stateDirs.map((stateDir) => scanCapabilityBlock({ stateDir }));
    const capabilityPlan = planCapabilityBlocks(capabilities);
    for (const action of capabilityPlan.actions) {
      const filePath = action.params?.path;
      if (typeof filePath !== 'string') continue;
      nextExecutors.set(action.actionId, (backup) => {
        const result = applyCapabilityRewrite({
          filePath,
          backup: (file) => backup.backupFile(file),
          log: (line) => backup.log(line),
        });
        return outcome(action.actionId, result.ok, result.reason);
      });
    }
    items.push(
      baseReport('capability-block', {
        severity:
          capabilityPlan.actions.length > 0 ? 'attention' : capabilityPlan.skipped.length > 0 ? 'blocked' : 'ok',
        findings: capabilityPlan.findings.length > 0 ? capabilityPlan.findings : [{ code: 'capability.none' }],
        actions: capabilityPlan.actions,
        skipped: capabilityPlan.skipped,
      }),
    );

    // ---- #4 运行环境自查（**只报告**，永不给动作） ---------------------------
    const environment = inspectEnvironment({
      targets,
      bundledRuntimeRoot: options.bundledRuntimeRoot,
      isPackaged: options.isPackaged,
    });
    items.push(
      baseReport('environment', {
        severity: environment.unhealthy ? 'broken' : 'ok',
        findings: environment.findings,
        blocked: environment.guidance,
      }),
    );

    // ---- #5 诊断包导出 ------------------------------------------------------
    const outputDir = targets.volumeRoot ?? targets.dataRoot;
    const diagnosticsAction: RepairAction = {
      actionId: DIAGNOSTICS_ACTION_ID,
      code: 'diagnostics.export',
      params: { path: outputDir },
      requiresConfirmation: false,
      backup: false,
      targets: [path.join(outputDir, 'Partner-W-诊断包-<时间戳>.zip')],
    };
    nextExecutors.set(DIAGNOSTICS_ACTION_ID, (backup) => {
      const written = writeDiagnosticsPack(
        { targets, appVersion: options.appVersion, scan: lastScan, now: options.now(), outputDir },
        repairRunStamp(options.now()),
      );
      backup.log(`diagnostics pack -> ${written ?? 'FAILED'}`);
      return written
        ? {
            actionId: DIAGNOSTICS_ACTION_ID,
            status: 'applied',
            message: { code: 'apply.diagnostics-written', params: { path: written } },
            backupPath: null,
          }
        : {
            actionId: DIAGNOSTICS_ACTION_ID,
            status: 'failed',
            message: { code: 'apply.diagnostics-failed' },
            backupPath: null,
          };
    });
    items.push(
      baseReport('diagnostics-pack', {
        severity: 'attention',
        findings: [{ code: 'diagnostics.ready', params: { path: outputDir } }],
        actions: [diagnosticsAction],
      }),
    );

    // ---- #6 技能安装记录（T31：「修复 → 换网关」通路） -----------------------
    //
    // 随包技能的账按网关报的 `managedSkillsDir`（= `<stateDir>/skills`）做键。
    // 换网关 / 换盘后旧键成孤儿 ⇒ 健康盘上冒"未知来源"的**虚假冲突**；而"换网关"
    // 恰恰可能伴随"网关连不上"，ensure 那条自愈通路跑不到 —— 只有修复模式够得着。
    // 只迁**目录已不在盘上**的旧键（目录还在的一律不动，那可能只是另一块盘）。
    const skillAccess = options.skillRecords;
    if (!skillAccess) {
      items.push(baseReport('skill-records', { severity: 'blocked', skipped: [{ code: 'skill.no-access' }] }));
    } else {
      const snapshot = skillAccess.read();
      if (!snapshot) {
        items.push(baseReport('skill-records', { severity: 'blocked', blocked: [{ code: 'skill.no-config' }] }));
      } else {
        const plan = planSkillRecords({
          stateDirs: targets.stateDirs,
          records: snapshot.records,
          pathExists: (candidate) => fs.existsSync(candidate),
        });
        const migration = plan.migration;
        if (migration) {
          nextExecutors.set('skill-records:migrate', (backup) => {
            // 先备份**配置文件本身**（迁移改的就是它）—— 备份不成 ⇒ 放弃这一条。
            const copy = backup.backupFile(snapshot.configPath);
            if (!copy) return outcome('skill-records:migrate', false, 'backup-failed');
            const ok = skillAccess.write(migration.next);
            // 码写成字面量：`test/repair-codes-i18n.test.ts` 按 `code:` 行扫源码，
            // 经 `outcome()` 拼出来的 `apply.<reason>` 它看不见 ⇒ 容易漏进一句机器话。
            return {
              actionId: 'skill-records:migrate',
              status: ok ? 'applied' : 'failed',
              message: { code: ok ? 'apply.skill-migrated' : 'apply.write-failed' },
              backupPath: copy,
            };
          });
        }
        items.push(
          baseReport('skill-records', {
            severity: migration ? 'attention' : plan.blocked.length > 0 ? 'blocked' : 'ok',
            findings: plan.findings,
            actions: plan.actions,
            blocked: plan.blocked,
            skipped: plan.skipped,
          }),
        );
      }
    }

    executors = nextExecutors;
    lastScan = {
      items,
      liveInstance: detectLiveInstance(locks),
      scannedAt: options.now().getTime(),
      scannedRoots: [...targets.candidateStateRoots, targets.dataRoot, targets.logsRoot],
    };
    return lastScan;
  };

  const apply = (actionIds: readonly string[]): RepairApplyResult => {
    const chosen = actionIds.filter((id) => executors.has(id));
    if (chosen.length === 0) return { outcomes: [], backupDir: null, logPath: null };

    if (lastScan?.liveInstance) {
      const allowed = chosen.filter((id) => LIVE_SAFE_ACTION_IDS.has(id));
      const blocked = chosen.filter((id) => !LIVE_SAFE_ACTION_IDS.has(id));
      const outcomes: RepairOutcome[] = blocked.map((id) => ({
        actionId: id,
        status: 'skipped' as const,
        message: { code: 'apply.blocked-live-instance' },
        backupPath: null,
      }));
      if (allowed.length === 0) return { outcomes, backupDir: null, logPath: null };
      const partial = runActions(allowed);
      return { outcomes: [...outcomes, ...partial.outcomes], backupDir: partial.backupDir, logPath: partial.logPath };
    }
    return runActions(chosen);
  };

  const runActions = (ids: readonly string[]): RepairApplyResult => {
    const backup = new RepairBackup(targets.logsRoot, repairRunStamp(options.now()));
    backup.log(`repair session start (${ids.length} action(s))`);
    const outcomes: RepairOutcome[] = [];
    for (const id of ids) {
      const executor = executors.get(id);
      if (!executor) continue;
      outcomes.push(executor(backup));
    }
    backup.log(`repair session end (${outcomes.map((item) => item.status).join(',')})`);
    return {
      outcomes,
      backupDir: backup.dirExists ? backup.dir : null,
      logPath: backup.dirExists ? backup.logPath : null,
    };
  };

  const exportDiagnostics = (): RepairDiagnosticsResult => {
    const report = lastScan ?? scan();
    const outputDir = targets.volumeRoot ?? targets.dataRoot;
    const written = writeDiagnosticsPack(
      { targets, appVersion: options.appVersion, scan: report, now: options.now(), outputDir },
      repairRunStamp(options.now()),
    );
    return written
      ? { ok: true, path: written, message: { code: 'diagnostics.written', params: { path: written } } }
      : { ok: false, path: null, message: { code: 'diagnostics.failed' } };
  };

  /**
   * 还原某一轮修复（T31 · 缺口 1）：把那份备份目录里的 `index.json` 逐条写回原路径。
   *
   * 三条纪律：
   *  ① 与 `apply` 同一条：**活锁下拒绝**（还原也是写动作，正跟主程序抢同一批文件）。
   *  ② **备份目录**白名单在 IPC 层做（引擎不认识"哪个目录能碰"）。
   *  ③ **还原目标**白名单在这里做 —— 目标来自 `index.json`（不可信输入），
   *     不过 `appOwnedRoots()` 这一关就是"任意文件覆写"原语。
   */
  const restore = (backupDir: string): RepairRestoreResult => {
    if (lastScan?.liveInstance) {
      return {
        ok: false,
        reason: 'blocked-live-instance',
        dir: backupDir,
        total: 0,
        restored: 0,
        missing: 0,
        refused: 0,
        failed: 0,
      };
    }
    const report = restoreRepairBackup(backupDir, {
      isAllowedTarget: (target) => isPathWithinAnyRoot(target, appOwnedRoots(targets)),
    });
    const counts = {
      dir: report.dir,
      total: report.total,
      restored: report.restored.length,
      missing: report.missing.length,
      refused: report.refused.length,
      failed: report.failed.length,
    };
    if (report.indexMissing) return { ok: false, reason: 'no-index', ...counts };
    if (report.total === 0) return { ok: false, reason: 'nothing', ...counts };
    const clean = counts.restored === report.total;
    return { ok: clean, reason: clean ? 'restored' : 'partial', ...counts };
  };

  return { scan, apply, exportDiagnostics, restore };
}
