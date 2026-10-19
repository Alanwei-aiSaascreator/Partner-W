import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { readCurrentDeployment } from '../runtime/deploy.js';
import { hasFeishuPlugin } from './feishu.js';
import {
  installFeishuFromOfficialPackage,
  readFeishuInstallRecord,
  type FeishuInstallRecord,
} from './feishu-install.js';

/**
 * 启动时自愈"插件在、可信安装记录没了"（2026-10-19 现场盘）。
 *
 * ## 为什么需要
 *
 * 内核只给有**可信安装记录**的插件开 channel ingress。记录的 `installPath` 是**绝对路径**：
 * U 盘换个盘符（E: → F:）之后，路径不再存在，内核判 record-missing / path-mismatch，
 * 飞书通道直接进 `ingressUnavailable` —— 用户看到的是一句"插件缺少可信安装记录"，
 * 而插件目录明明就在那儿。1.0.9 及更早还有一种来源：装插件走的是**目录复制**，
 * 从来就没有记录。
 *
 * 产品承诺是"插上就用"，所以这件事不能指望用户每次换机都去点一次「重新扫码」。
 * 启动后后台跑一次官方安装（随包 npm + 离线缓存），把记录重新建在当前路径上。
 *
 * ## 边界
 *
 * - **只在真有问题时动手**：插件目录不在（用户从没用过）⇒ 什么都不做；记录有效 ⇒ 什么都不做。
 * - **每个进程只试一次**（真正动手之后）：安装失败不循环（失败原因写日志；界面仍按
 *   "通道未就绪"如实提示）。**运行时还没部署好**时返回 `deferred` 且**不**消耗这一次 ——
 *   全新盘首次部署实测 149s，调用方按退避继续等（2026-10-19 自审）。
 * - **不阻塞启动**：调用方延迟触发；停/装/起期间用户还能看到界面。
 * - 安装本身是单飞的（`installFeishuFromOfficialPackage` 内部按 stateDir 去重）。
 */

export interface FeishuInstallRepairInput {
  /** 当前网关真正在用的 state 目录（解析不到就跳过）。 */
  stateDir: string | null;
  /** 运行时部署根（便携：`<运行数据>/portable-runtime-cache`）。 */
  deploymentDir: string;
  /** 随包 npm 负载目录（`<resources>/runtime/node`）。 */
  runtimeNodePayloadDir?: string;
  /** 随包插件目录（读版本号用）。 */
  bundledPluginDir?: string;
  /** 注入用（测试）。 */
  readRecord?: (stateDir: string) => FeishuInstallRecord | null;
  /** 注入用（测试）：运行时部署解析。 */
  readDeployment?: typeof readCurrentDeployment;
  ensureInstall?: typeof installFeishuFromOfficialPackage;
  stopGateway?: () => Promise<void>;
  restartGateway?: () => Promise<void>;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

export type FeishuInstallRepairResult =
  | 'skipped'
  | 'repaired'
  | 'failed'
  /**
   * 运行时还没部署好（全新盘首次启动实测要 149s，而触发点在 10s）。
   * **不消耗"每进程一次"的门闩**，调用方应继续退避重试（2026-10-19 自审）。
   */
  | 'deferred';

let attemptedInThisProcess = false;

/** 测试用：复位"每进程一次"的门闩。 */
export function resetFeishuInstallRepairForTests(): void {
  attemptedInThisProcess = false;
}

function readBundledPluginVersion(dir: string | undefined): string {
  if (!dir) return '';
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version.trim() : '';
  } catch {
    return '';
  }
}

async function defaultStopGateway(): Promise<void> {
  const runtime = await import('../runtime/index.js');
  await runtime.stopLocalGatewayForMaintenance();
}

async function defaultRestartGateway(): Promise<void> {
  const runtime = await import('../runtime/index.js');
  await runtime.restartLocalGatewayRuntime();
  const ws = await import('../ws/index.js');
  ws.reconnectGateway('local-runtime');
}

export async function repairFeishuInstallOnStartup(
  input: FeishuInstallRepairInput,
): Promise<FeishuInstallRepairResult> {
  const log = input.log ?? (() => {});
  if (attemptedInThisProcess) return 'skipped';
  const stateDir = input.stateDir;
  if (!stateDir) {
    // ⚠️ 2026-10-19 现场：第一次触发（启动 10s）可能早于网关 spawn 完成 ——
    //    `getActiveLocalGatewayStateDir()` 只在 ownership='spawned' 时返回值。
    //    此前这里返回 `skipped`，调用方不再重试 ⇒ 本次进程永久放弃自愈，
    //    用户看到"插件缺少可信安装记录"一直修不好。**未解析 ≠ 不需要修**。
    log('connectors.feishu-install.repair-deferred', { reason: 'state-dir-unresolved' });
    return 'deferred';
  }
  // 插件根本没装过 ⇒ 不是"记录坏了"，不替用户装他没要过的东西。
  if (!hasFeishuPlugin(stateDir)) return 'skipped';

  const readRecord = input.readRecord ?? readFeishuInstallRecord;
  try {
    if (readRecord(stateDir) !== null) return 'skipped';
  } catch {
    // 读不出来按"需要修"处理：安装本身会重建记录。
  }

  const deployment = (input.readDeployment ?? readCurrentDeployment)(input.deploymentDir);
  if (deployment.status !== 'ok' || !deployment.nodePath || !deployment.cliPath) {
    // ⚠️ 全新盘首次启动的运行时部署实测要 149s，而触发点在 10s ⇒ 这一刻"未就绪"是
    //    预期内状态，**不是失败**。返回 deferred 且**不**消耗门闩，让调用方继续重试
    //    （2026-10-19 自审：此前直接 failed + 门闩置位，用户必须再重启一次才能恢复）。
    log('connectors.feishu-install.repair-deferred', { reason: 'runtime-not-ready' });
    return 'deferred';
  }
  // 旧程序目录（1.0.9 及更早）没有随包 npm：离线装不了。这是**本块盘的永久条件**，
  // 记下并消耗门闩，不反复停网关重试。
  if (input.runtimeNodePayloadDir && !existsSync(path.join(input.runtimeNodePayloadDir, 'npm.cmd'))) {
    attemptedInThisProcess = true;
    log('connectors.feishu-install.repair-skipped', { reason: 'npm-payload-missing' });
    return 'failed';
  }
  // 真正动手之前才消耗"每进程一次"：之前的任何"未就绪"都不算一次尝试。
  attemptedInThisProcess = true;

  log('connectors.feishu-install.repair-start');
  const stopGateway = input.stopGateway ?? defaultStopGateway;
  const restartGateway = input.restartGateway ?? defaultRestartGateway;
  let stopped = false;
  try {
    try {
      await stopGateway();
      stopped = true;
    } catch {
      // 停不下来也照常尝试；失败会在下面返回 failed。
    }
    const ensure = input.ensureInstall ?? installFeishuFromOfficialPackage;
    const result = await ensure({
      stateDir,
      nodePath: deployment.nodePath,
      cliPath: deployment.cliPath,
      pluginVersion: readBundledPluginVersion(input.bundledPluginDir),
      ...(input.runtimeNodePayloadDir ? { payloadDir: input.runtimeNodePayloadDir } : {}),
    });
    if (!result.ok) {
      log('connectors.feishu-install.repair-failed', { reason: result.reason });
      return 'failed';
    }
    log('connectors.feishu-install.repair-done');
    return 'repaired';
  } catch (error) {
    log('connectors.feishu-install.repair-failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  } finally {
    if (stopped) {
      try {
        await restartGateway();
      } catch {
        // 重启失败不影响下一次启动：自愈会在下次再跑一遍。
      }
    }
  }
}
