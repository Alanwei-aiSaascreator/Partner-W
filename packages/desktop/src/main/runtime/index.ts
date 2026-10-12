/**
 * 装载器编排 —— **只有顺序，没有逻辑**。
 *
 *   userData 覆盖（在 app.ready 之前，见 `user-data-override.ts`）
 *   → 对齐 state/config 的 token
 *   → 认本机缓存（拔盘走这条）
 *   → 没有就定位部署源 + 部署
 *   → 解析一个能跑 openclaw 的 Node
 *   → 探活/认证后决定 spawn 还是复用
 *
 * ⚠️ **本层绝不抛**。启动路径上抛出去 = 用户看到白屏，而"网关没起来"本来就有
 * 专门的界面表达（ConnectionBanner）。所以失败一律 resolve 成带 `reason`/`code`
 * 的结果，让调用方照常走 `initAllGateways()` —— 上一轮留下的、或用户自己的网关
 * 可能还活着，得让界面说真话。
 *
 * ⚠️ 真正的判断都在各自模块里（这是刻意的）：本文件应该读起来像一张清单。
 */

import { app } from 'electron';
import { GATEWAY_WS_PORT } from '@clawwork/shared';
import {
  GATEWAY_PORT_OCCUPIED,
  ensureGatewayRunning,
  stopGateway,
  stopGatewayIfOwned,
  type EnsureGatewayRunningResult,
  type GatewayChildProcess,
} from './gateway-process.js';
import {
  deployedNodePathFor,
  loadNodeVersionContract,
  nodeCandidates,
  nodeFailureCodeOf,
  pickNode,
  probeNodeWithBoundedRetry,
  NODE_PROBE_RETRY_BUDGET_MS,
} from './node-runtime.js';
import type { PickNodeResult, ProbeRetryRecord } from './node-runtime.js';
import {
  describeRuntimeSearch,
  fallbackDriveCandidates,
  findDevRuntimeRoots,
  findRuntimeRoot,
  listRemovableDrives,
  planRuntimeSearch,
  type RuntimeSearchInputs,
} from './locate.js';
import { CLAWROUTER_ENTRY, DEPLOY_FAILED_CODE, ensureRuntimeDeployed, readCurrentDeployment } from './deploy.js';
import type { CurrentDeployment, DeployProgress, DeployResult, DeploymentStamp } from './deploy.js';
import { parseManifest, parseNodeManifest, selectNodeVariant, selectRuntimeVariant } from './manifest.js';
import type { NodeVariant, RuntimeVariant } from './manifest.js';
import { ensureClientGatewayEntry } from './state-config.js';
import {
  GATEWAY_CRASH_LOOP_BREAKER,
  crashLoopBreakerGuidance,
  inspectCrashLoopBreaker,
  type CrashLoopBreakerState,
} from './gateway-breaker.js';
import { runStateLinksSelfCheck } from './state-links-selfcheck.js';
import type { LinkSelfCheckResult } from './state-links-selfcheck.js';
import fs from 'node:fs';
import path from 'node:path';

export interface RuntimeBootstrapResult {
  ok: boolean;
  /** 给人看的原因（失败时必有）。 */
  reason?: string;
  /** 机器可判的失败类别（如 `runtime.gateway-port-occupied`）。 */
  code?: string;
  ownership?: 'spawned' | 'reused';
  deploymentKey?: string;
  deployStatus?: 'deployed' | 'skipped';
  nodeVersion?: string;
  nodeExe?: string;
  /** 坏链自检的结论（摘要；明细在日志里）—— 见 `state-links-selfcheck.ts`。 */
  links?: LinkSelfCheckSummary;
  elapsedMs?: number;
}

/** 自检结果的**摘要**（日志/界面用；明细不往外带）。 */
export interface LinkSelfCheckSummary {
  checked: number;
  broken: number;
  repaired: number;
  /** 试过要修、没修成的条数（原因逐条写进日志）。 */
  failed: number;
  summary: string;
}

/**
 * 编排的依赖（可整体替换，便于钉住顺序 —— 真机上"顺序错了"极难复现）。
 *
 * 默认实现全部来自各自模块；测试传一个记录调用的假集合即可。
 */
export interface RuntimeBootstrapDeps {
  alignClientConfig: (opts: {
    userDataDir: string;
    stateUserDataDir: string;
    portableWorkspacePath?: string;
    legacyStateUserDataDir?: string;
  }) => Promise<{ token: string; stateDir: string }>;
  readCached: (userDataDir: string) => CurrentDeployment;
  /**
   * 从盘上部署一份运行时。
   *
   * `onProgress` 是**可选**的：没有谁在听（测试、无界面的调用方）时**连字段都不传**，
   * 免得调用形状被一个恒为 undefined 的键污染。
   */
  deployFromMedia: (opts: { userDataDir: string; onProgress?: (p: DeployProgress) => void }) => Promise<DeployResult>;
  /**
   * 坏链自检（**同步、永不抛**的默认实现见 `state-links-selfcheck.ts`）。
   *
   * 单独做成一个 dep 是为了让"自检炸了也不能拦住启动"这条能被钉住 —— 真机上
   * 一个 EPERM 就把整个启动吞掉，是这一层最不该有的行为。
   */
  selfCheckLinks: (opts: { stateDir: string; deployedRoot: string }) => LinkSelfCheckResult;
  /**
   * ⚠️ 只给 `deployedRoot`。**不提供"盘上那个 node"当候选** —— 部署成功即代表
   * `deployed/<key>/node/node.exe` 已验过 hash 且自包含，运行期就该只用它；
   * 多给一个候选只会让"到底跑了哪个 node"变得不确定。
   */
  resolveNode: (opts: { userDataDir: string; deploymentKey: string; deployedRoot: string }) => Promise<PickNodeResult>;
  startGateway: (opts: {
    nodeExe: string;
    cliPath: string;
    deployedRoot: string;
    stateDir: string;
    identityPath: string;
    token: string;
    /**
     * BUG-059 附 F4：真 spawn 之前的闸（判定为 reuse/foreign 的路径**不会**调用它）。
     * 默认实现一路传到 `ensureGatewayRunning` 的 spawn 分支；测试假实现可自取所需。
     */
    beforeSpawn?: () => void | Promise<void>;
  }) => Promise<EnsureGatewayRunningResult>;
  setStateDirEnv: (stateDir: string) => void;
  /**
   * BUG-040 ④ + BUG-059：看一眼网关的崩溃循环熔断（`gateway.crash_loop_breaker`）。
   * 两处消费：①spawn 分支的预检 `beforeSpawn`（熔断 ⇒ 不撞墙）②失败路径的换码诊断。
   * **只读**、永不抛；缺省实现在 `gateway-breaker.ts`。可选（老测试的假依赖集不用改）。
   */
  inspectBreaker?: (stateDir: string) => CrashLoopBreakerState;
  log: (event: string, data?: Record<string, unknown>) => void;
  now: () => number;
}

/**
 * 采集**环境**侧的检索输入（cwd / 盘符 / 打包态）。
 *
 * 真机上的这三个值都是环境，单测注入不了 ⇒ 抽出来单独喂给 `planRuntimeSearch`，
 * 让「打包态 ⇒ 随包那份进候选」这条可以被钉住。
 */
export function collectRuntimeSearchInputs(): RuntimeSearchInputs {
  const cwd = process.cwd();
  return {
    cwd,
    envDir: process.env.CLAWWORK_RUNTIME_DIR,
    devRoots: findDevRuntimeRoots(cwd),
    driveLetters: listRemovableDrives(),
    // ⚠️ **打包态才有 `<resources>/runtime`**：`process.resourcesPath` 在
    // `electron-vite dev` 下指的是 `node_modules/electron/dist/resources` ——
    // 那里永远不会有我们这份运行时。⇒ 连同 `isPackaged` 一起交给
    // `planRuntimeSearch`，由它决定要不要产生 bundled 候选（dev 下优雅缺席）。
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  };
}

/** `locateAndPlan` 的结果：要么有得部署，要么带一句**能排障**的原因。 */
export type LocatePlan =
  | {
      ok: true;
      runtimeRoot: string;
      deploy: (o: { userDataDir: string; onProgress?: (p: DeployProgress) => void }) => Promise<DeployResult>;
    }
  | { ok: false; reason: string };

/**
 * 定位部署源 + 读两份 manifest，算出这次要部署什么。
 *
 * ⚠️ 失败一律 `{ ok:false, reason }`（**不抛**）—— 「找不到运行时」的原因必须能
 * 一路传到启动日志里，所以原因文本要自带"找过哪些地方"（见 `describeRuntimeSearch`）。
 *
 * `inputs` 只在单测里给（真机恒走 `collectRuntimeSearchInputs()`）：cwd、盘符枚举、
 * 打包态都是**环境**，不注入的话"随包那份能用"这条在测试里就没法稳定复现
 * （机器上插着一个真 U 盘就会翻）。
 */
export async function locateAndPlan(
  userDataDir: string,
  inputs: RuntimeSearchInputs = collectRuntimeSearchInputs(),
): Promise<LocatePlan> {
  const search = planRuntimeSearch(inputs);
  const hit = findRuntimeRoot(search.candidates) ?? findRuntimeRoot(fallbackDriveCandidates());
  if (!hit) {
    return {
      ok: false,
      // ⚠️ 这段文本是**排障入口**：必须能看出找过谁、谁连候选都没产生
      reason: describeRuntimeSearch({
        candidates: search.candidates,
        absent: search.absent,
        fallbackScanned: true,
      }),
    };
  }

  const runtimeRoot = hit.root;
  const manifestPath = hit.manifestPath;
  const from = `（来源 [${hit.origin}]：${runtimeRoot}）`;

  let parsed: { manifestPath: string; runtime: RuntimeVariant; node: NodeVariant };
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const manifest = parseManifest(raw);
    const runtime = selectRuntimeVariant(manifest, process.platform, process.arch);

    const nodeManifestFile = path.join(runtimeRoot, 'node', 'node-manifest.json');
    if (!fs.existsSync(nodeManifestFile)) {
      return {
        ok: false,
        reason: `找到了运行时 ${from}，但它不完整：缺 ${path.join('node', 'node-manifest.json')}（随行 Node 的清单）。`,
      };
    }
    const nodeManifestRaw: unknown = JSON.parse(fs.readFileSync(nodeManifestFile, 'utf-8'));
    const node = selectNodeVariant(parseNodeManifest(nodeManifestRaw), process.platform, process.arch);
    parsed = { manifestPath, runtime, node };
  } catch (err) {
    // ⚠️ 命中了一个**坏掉的**来源时，原因里必须带上"是哪一份" —— 只说
    // "manifest 字段不对"，拿到日志的人不知道要去修哪个盘/哪个包。
    return { ok: false, reason: `找到了运行时 ${from}，但它用不了：${(err as Error).message}` };
  }

  return {
    ok: true,
    runtimeRoot,
    deploy: (o) =>
      ensureRuntimeDeployed({
        userDataDir: o.userDataDir,
        runtimeRoot,
        runtime: parsed.runtime,
        node: parsed.node,
        manifestPath: parsed.manifestPath,
        // 没人听就不传这个键（调用形状保持干净）
        ...(o.onProgress ? { onProgress: o.onProgress } : {}),
      }),
  };
}

function makeDefaultDeps(): RuntimeBootstrapDeps {
  return {
    alignClientConfig: async ({ userDataDir, stateUserDataDir, portableWorkspacePath, legacyStateUserDataDir }) => {
      const res = await ensureClientGatewayEntry({
        userDataDir,
        stateUserDataDir,
        portableWorkspacePath,
        legacyStateUserDataDir,
      });
      return { token: res.token, stateDir: res.stateDir };
    },
    readCached: (userDataDir) => readCurrentDeployment(userDataDir),
    selfCheckLinks: ({ stateDir, deployedRoot }) => runStateLinksSelfCheck({ stateDir, deployedRoot }),
    deployFromMedia: async ({ userDataDir, onProgress }) => {
      const plan = await locateAndPlan(userDataDir);
      // ⚠️ 原因文本原样抛出：它自带"找过哪些地方"（见 describeRuntimeSearch），
      // 而 bootstrap 会把它写进 `runtime.bootstrap.failed` 的 reason。
      if (!plan.ok) throw new Error(plan.reason);
      // 同样条件透传：没人听就不带这个键。
      return plan.deploy({ userDataDir, ...(onProgress ? { onProgress } : {}) });
    },
    resolveNode: async ({ deployedRoot }) => {
      // ⚠️ BUG-064（2026-10-10）：路径由**传入的 deployedRoot** 决定（换盘符 F→G 后
      //    探测的就是新盘符下的同一位置）；不再按 existsSync 决定要不要给候选 ——
      //    "文件不存在"本身是有信息量的失败分档（missing），要走到界面上。
      const deployedNode = deployedNodePathFor(deployedRoot);

      // 版本区间来自**部署后的** openclaw 包 —— 不硬编码。
      // 合同 #1：**版本契约加载**与**Node 执行**的耗时分开记。
      const contractStartedAt = Date.now();
      const contract = await loadNodeVersionContract(path.join(deployedRoot, 'node_modules', 'openclaw'));
      const contractMs = Math.max(0, Date.now() - contractStartedAt);

      // 合同 A：**所有候选共享同一个 deadline**（同一单调时钟）——候选切换不重新
      // 获得整段预算；版本契约加载的耗时已经单独记完，不混进探测预算。
      const deadlineMs = performance.now() + NODE_PROBE_RETRY_BUDGET_MS;
      const probeRecords: ProbeRetryRecord[] = [];
      const res = await pickNode({
        candidates: nodeCandidates({
          envNode: process.env.CLAWWORK_NODE,
          deployedNodePath: deployedNode,
        }),
        // 合同 #2/#3：异步探测 + 只对 timeout 的有界重试（最多 2 次、剩余预算内）。
        probe: (exe) =>
          probeNodeWithBoundedRetry(exe, {
            deadlineMs,
            onAttempt: (record) => probeRecords.push(record),
          }).then((w) => w.result),
        isSupported: contract.isSupported,
        supportedRange: contract.supportedRange,
      });
      return { ...res, probeRecords, contractMs };
    },
    startGateway: async ({ nodeExe, cliPath, deployedRoot, stateDir, identityPath, token, beforeSpawn }) =>
      ensureGatewayRunning({
        nodeExe,
        cliPath,
        deployedRoot,
        stateDir,
        token,
        port: GATEWAY_WS_PORT,
        identityPath,
        // 没人给这个闸就不带这个键（调用形状保持干净）
        ...(beforeSpawn ? { beforeSpawn } : {}),
      }),
    setStateDirEnv: (stateDir) => {
      // ⚠️ media/resolve.ts 读它；不设的话聊天里的图片会**静默**读不到
      process.env.OPENCLAW_STATE_DIR = stateDir;
    },
    log: () => {
      /* 默认不落日志；接线时注入 getDebugLogger */
    },
    now: () => Date.now(),
  };
}

/**
 * 拉起本机网关。**永不抛** —— 失败返回 `{ ok:false, reason, code }`。
 */
export async function bootstrapLocalGatewayRuntime(opts: {
  userDataDir: string;
  runtimeCacheUserDataDir?: string;
  stateCacheUserDataDir?: string;
  portableWorkspacePath?: string;
  legacyStateUserDataDir?: string;
  /**
   * 部署阶段的真实进度（可选）。**透传**给 `deployFromMedia`，这一层不解释它 ——
   * 快照、节流、停滞提示都在接线处（`main/index.ts` + `deploy-progress.ts`）。
   */
  onDeployProgress?: (p: DeployProgress) => void;
  deps?: Partial<RuntimeBootstrapDeps>;
}): Promise<RuntimeBootstrapResult> {
  const deps: RuntimeBootstrapDeps = { ...makeDefaultDeps(), ...opts.deps };
  const { userDataDir } = opts;
  const runtimeCacheUserDataDir = opts.runtimeCacheUserDataDir ?? userDataDir;
  const stateCacheUserDataDir = opts.stateCacheUserDataDir ?? userDataDir;
  const startedAt = deps.now();

  /**
   * 部署那一步的**带码**包装：这一步失败时，公开原因必须是 `deploy-failed`
   * （界面的出口在盘上），而不是笼统的 `unknown`。
   *
   * ⚠️ 包在**编排层**而不是 `ensureRuntimeDeployed` 内部：这整段（定位 + 部署）
   *    才是"从盘上准备运行环境"这件事，两处调用点（便携 / 安装形态）都从这里过。
   * ⚠️ 已经带码的错误（迁移阻塞、端口占用…）**原样放行** —— 那些类别的出口不是"换块盘"。
   */
  const deployWithCode = async (cacheUserDataDir: string): Promise<DeployResult> => {
    try {
      return await deps.deployFromMedia({
        userDataDir: cacheUserDataDir,
        ...(opts.onDeployProgress ? { onProgress: opts.onDeployProgress } : {}),
      });
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      if ((cause as Error & { code?: string }).code) throw cause;
      throw Object.assign(cause, { code: DEPLOY_FAILED_CODE });
    }
  };

  const fail = (
    code: string | undefined,
    reason: string,
    extra: Partial<RuntimeBootstrapResult> = {},
  ): RuntimeBootstrapResult => {
    deps.log('runtime.bootstrap.failed', { code, reason });
    return { ok: false, code, reason, elapsedMs: deps.now() - startedAt, ...extra };
  };

  /** 失败诊断要用的 stateDir（对齐配置之后才有；拿不到就不诊断）。 */
  let diagnosisStateDir: string | undefined;
  /** 这一轮运行时是**部署**出来的还是缓存命中的（失败时要带回结果里，见 BUG-040 R2）。 */
  let deployStatus: 'deployed' | 'skipped' | undefined;
  const inspectBreaker: (dir: string) => CrashLoopBreakerState =
    deps.inspectBreaker ?? ((dir) => inspectCrashLoopBreaker(dir));

  try {
    const { token, stateDir } = await deps.alignClientConfig({
      userDataDir,
      stateUserDataDir: stateCacheUserDataDir,
      portableWorkspacePath: opts.portableWorkspacePath,
      ...(opts.legacyStateUserDataDir ? { legacyStateUserDataDir: opts.legacyStateUserDataDir } : {}),
    });
    diagnosisStateDir = stateDir;
    deps.setStateDirEnv(stateDir);

    // ② 安装形态先认本机缓存（保留“部署源暂时不在也能启动”的既有退路）。
    //    便携形态用了独立缓存作用域，必须先拿本包 manifest 算目标 key；否则同机旧版
    //    留下的一份“结构完整”缓存会盖过当前包随附的运行时。
    let deployed: { deploymentKey: string; deployedRoot: string; cliPath: string; nodePath: string };

    if (runtimeCacheUserDataDir !== userDataDir) {
      const res = await deployWithCode(runtimeCacheUserDataDir);
      deployed = {
        deploymentKey: res.deploymentKey,
        deployedRoot: res.deployedRoot,
        cliPath: res.cliPath,
        nodePath: res.nodePath,
      };
      deployStatus = res.status;
      deps.log('runtime.deploy.done', { deploymentKey: res.deploymentKey, status: res.status });
    } else {
      const cached = deps.readCached(runtimeCacheUserDataDir);
      if (cached.status === 'ok' && cached.deploymentKey && cached.deployedRoot && cached.cliPath && cached.nodePath) {
        deployed = {
          deploymentKey: cached.deploymentKey,
          deployedRoot: cached.deployedRoot,
          cliPath: cached.cliPath,
          nodePath: cached.nodePath,
        };
        deployStatus = 'skipped';
        deps.log('runtime.deploy.skipped', { deploymentKey: cached.deploymentKey });
      } else {
        // ③ 没有可用缓存 ⇒ 从部署源部署一份
        const res = await deployWithCode(runtimeCacheUserDataDir);
        deployed = {
          deploymentKey: res.deploymentKey,
          deployedRoot: res.deployedRoot,
          cliPath: res.cliPath,
          nodePath: res.nodePath,
        };
        deployStatus = res.status;
        deps.log('runtime.deploy.done', { deploymentKey: res.deploymentKey, status: res.status });
      }
    }

    // ④ 坏链自检 + 我们能修的那半（**只修悬空的**：换根前缀、后缀不动、目标必须真存在）。
    //
    // ⚠️ 位置刻意紧跟部署之后：要的是**这一轮真正在用的**那个 deployedRoot；而
    //    `plugin-skills\*` 是网关启动时才会去读/建的，所以必须赶在它前面。
    // ⚠️ **软失败**：自检只是额外一层保险，炸了不能拦住启动（有测试钉着这一条）。
    let links: LinkSelfCheckSummary | undefined;
    try {
      const check = deps.selfCheckLinks({ stateDir, deployedRoot: deployed.deployedRoot });
      links = {
        checked: check.checked,
        broken: check.broken,
        repaired: check.repaired,
        failed: check.failures.length,
        summary: check.summary,
      };
      deps.log('runtime.links.checked', {
        checked: check.checked,
        broken: check.broken,
        repaired: check.repaired,
        failed: check.failures.length,
        stillBroken: check.stillBroken.length,
      });
      if (check.repaired > 0) deps.log('runtime.links.repaired', { repaired: check.repaired });
      for (const f of check.failures) {
        deps.log('runtime.links.repair-failed', { path: f.path, target: f.target, reason: f.reason });
      }
      for (const n of check.notes) deps.log('runtime.links.note', { note: n });
    } catch (err) {
      deps.log('runtime.links.failed', { reason: (err as Error).message });
    }

    // ⑤ 解析一个能跑 openclaw 的 Node（**必须先探版本**）
    //
    // ⚠️ BUG-064（2026-10-10）：**结构化诊断全部落日志**（合同 #1）——
    //    版本契约加载耗时与每次探测（含自动重试）的耗时/分档/限长 detail 分开记；
    //    失败码按归因分档（missing/permission/timeout/exec-failed/version-unsupported），
    //    UI 依据闭集原因说各自的话（`@clawwork/shared` 的 GatewayFailureReason）。
    //    原始 message（含盘符路径等）**只进日志与本地 reason**，不上界面。
    const nodeStartedAt = deps.now();
    const nodeRes = await deps.resolveNode({
      userDataDir: runtimeCacheUserDataDir,
      deploymentKey: deployed.deploymentKey,
      deployedRoot: deployed.deployedRoot,
    });
    deps.log('runtime.node.resolve.done', {
      durationMs: Math.max(0, deps.now() - nodeStartedAt),
      ok: nodeRes.ok,
      contractMs: nodeRes.contractMs,
      attempts: nodeRes.attempts,
      probeRecords: nodeRes.probeRecords,
    });
    if (!nodeRes.ok) {
      return fail(nodeFailureCodeOf(nodeRes.failureClass), nodeRes.message, { deploymentKey: deployed.deploymentKey });
    }

    /**
     * BUG-040 ④ + BUG-059 附 F4：熔断期间**不去撞墙** —— 预检挂在**真 spawn 的分支**上。
     *
     * 内核（同一套判据）会拒绝启动，但每次**真 spawn** 都会新增一条"不干净启动"记录、
     * 把那 5 分钟窗口往后推 —— 用户越点「重新准备」越出不来。所以 spawn 之前先停手。
     *
     * ⚠️ BUG-059 附 F4：**不能**拦在 `deps.startGateway` 之前（旧位置 pre-start）——
     *    `ensureGatewayRunning` 是三态判定：端口上已经跑着我们**健康**的网关时走 `reused`，
     *    根本不碰内核的启动计数；拦在前面会让"复用"也被一并否决，用户白等窗口。
     *    ⇒ 预检随 `beforeSpawn` 下传，只在 spawn 分支（判定为 reuse/foreign 之后）生效。
     *
     * ⚠️ 只读、读不到按"没熔断"（`available:false`）；唯一会抛的是"熔断 ⇒ 故意换码"那一支。
     */
    const beforeSpawn = (): void => {
      const breaker = inspectBreaker(stateDir);
      if (!breaker.tripped) return;
      deps.log('runtime.gateway-crash-loop-breaker', {
        phase: 'pre-spawn',
        uncleanBoots: breaker.uncleanBoots,
        retryAfterMs: breaker.retryAfterMs,
      });
      // 抛 = 不去撞墙（每次真 spawn 失败都会新增一条"不干净启动"、把窗口往后推）。
      throw Object.assign(new Error(crashLoopBreakerGuidance(breaker)), { code: GATEWAY_CRASH_LOOP_BREAKER });
    };

    // ⑥ 三态判定后 spawn / 复用（判成 foreign 会抛 port-occupied，由下面接住）
    const gatewayStartedAt = deps.now();
    deps.log('runtime.gateway.start', {});
    const gateway = await deps.startGateway({
      nodeExe: nodeRes.node.exe,
      cliPath: deployed.cliPath,
      deployedRoot: deployed.deployedRoot,
      stateDir,
      identityPath: path.join(userDataDir, 'device-identity.json'),
      token,
      beforeSpawn,
    });
    deps.log('runtime.gateway.ready', {
      durationMs: Math.max(0, deps.now() - gatewayStartedAt),
      ownership: gateway.ownership,
    });

    // 记下来给退出收尾用（只有 spawned 会被真的停掉）。
    //
    // ⚠️ **只让 `spawned` 覆盖**（2026-09-13 实测出来的）：同一个进程里 bootstrap
    // 不止一次时，后一次若判成 `reused`，它的 `child` 是空的 —— 直接覆盖就把
    // "这个网关是我们起的、退出时要停掉"这条**丢了**，于是退出时谁都不去停它，
    // 下一轮启动直接 EADDRINUSE。所有权是**单调**的：起过就一直算我们的。
    const nextActive = {
      ownership: gateway.ownership,
      child: gateway.child,
      nodeExe: nodeRes.node.exe,
      cliPath: deployed.cliPath,
      deployedRoot: deployed.deployedRoot,
      stateDir,
    };
    if (gateway.ownership === 'spawned' || !activeGateway) activeGateway = nextActive;
    if (gateway.ownership === 'spawned') {
      gateway.child?.onExit(() => {
        if (activeGateway === nextActive) activeGateway = null;
      });
    }

    deps.log('runtime.bootstrap.ok', {
      deploymentKey: deployed.deploymentKey,
      ownership: gateway.ownership,
      nodeVersion: nodeRes.node.version,
    });

    return {
      ok: true,
      ownership: gateway.ownership,
      deploymentKey: deployed.deploymentKey,
      deployStatus,
      nodeVersion: nodeRes.node.version,
      nodeExe: nodeRes.node.exe,
      links,
      elapsedMs: deps.now() - startedAt,
    };
  } catch (err) {
    const e = err as Error & { code?: string };

    /**
     * BUG-040 ③④：失败时先看一眼网关是不是**被自己的崩溃循环熔断挡下了**
     * （`gateway.crash_loop_breaker`，状态在 state sqlite 的 `gateway_boot_lifecycle`）。
     *
     * 为什么要在这一层：用户看到的"起不来"和真因（内核自我保护）之间没有任何桥梁 ——
     * 而这里**刚好知道 stateDir**，且只有失败路径会走到（不会拖慢正常启动）。
     *
     * ⚠️ 只读、永不抛、读不到就按"没熔断"（`available:false`）。
     * ⚠️ 熔断时**换码**（不在可重试白名单里）：反复重试只会延长那 5 分钟窗口。
     */
    const breaker = diagnosisStateDir
      ? inspectBreaker(diagnosisStateDir)
      : ({ available: false, tripped: false, uncleanBoots: 0 } satisfies CrashLoopBreakerState);
    if (breaker.tripped) {
      deps.log('runtime.gateway-crash-loop-breaker', {
        uncleanBoots: breaker.uncleanBoots,
        retryAfterMs: breaker.retryAfterMs,
      });
      // `beforeSpawn` 抛出的错误**本身就带指引**（预检那一支），不重复拼一遍。
      const reason =
        e.code === GATEWAY_CRASH_LOOP_BREAKER ? e.message : `${e.message}；${crashLoopBreakerGuidance(breaker)}`;
      return fail(GATEWAY_CRASH_LOOP_BREAKER, reason, {
        ...(deployStatus ? { deployStatus } : {}),
      });
    }
    return fail(e.code, e.message, { ...(deployStatus ? { deployStatus } : {}) });
  }
}

/**
 * 上一次 bootstrap 的结果（网关只有一个，模块级记住就够了）。
 * `null` = 这次启动没拉起过网关 ⇒ 退出时什么都不用做。
 */
let activeGateway: {
  ownership: 'spawned' | 'reused';
  child?: GatewayChildProcess;
  nodeExe: string;
  cliPath: string;
  deployedRoot: string;
  stateDir: string;
} | null = null;

export function getActiveLocalGatewayDeploymentRoot(): string | null {
  return activeGateway?.ownership === 'spawned' && activeGateway.child ? activeGateway.deployedRoot : null;
}

/**
 * 活动网关的**状态目录**（我们自己 spawn 的才有）。
 *
 * 与 deploymentRoot 同一套"活动权"判据（`spawned && child`）：复用别人的网关时返回 null，
 * 免得误报"我们捏着一个可用的运行时"。2026-10-12 起被联网搜索可用性探针用
 *（搜索 provider 插件装在状态目录里，不在 runtime 包里）。
 */
export function getActiveLocalGatewayStateDir(): string | null {
  return activeGateway?.ownership === 'spawned' && activeGateway.child ? activeGateway.stateDir : null;
}

export function captureOwnedLocalGatewayRuntime(): { deployedRoot: string; current: () => boolean } | null {
  const owner = activeGateway;
  if (owner?.ownership !== 'spawned' || !owner.child) return null;
  return { deployedRoot: owner.deployedRoot, current: () => activeGateway === owner };
}

/** 整体收尾超时 —— `before-quit` 里**不能卡住退出**。 */
const SHUTDOWN_TIMEOUT_MS = 5000;

/**
 * 退出时收尾。
 *
 * ⚠️ **只有 `spawned` 才停**。判断本身在 `stopGatewayIfOwned` 里（有单测钉住），
 * 这里只负责取回状态、加超时 —— 逻辑不在编排层。
 */
export async function shutdownLocalGatewayRuntime(): Promise<boolean> {
  const active = activeGateway;
  activeGateway = null;
  if (!active) return false;

  const stop = () =>
    stopGateway({
      nodeExe: active.nodeExe,
      cliPath: active.cliPath,
      deployedRoot: active.deployedRoot,
      stateDir: active.stateDir,
      child: active.child,
    });

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), SHUTDOWN_TIMEOUT_MS);
  });

  try {
    return await Promise.race([stopGatewayIfOwned({ ownership: active.ownership, stop }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export { GATEWAY_PORT_OCCUPIED, CLAWROUTER_ENTRY };
export type { DeploymentStamp };
