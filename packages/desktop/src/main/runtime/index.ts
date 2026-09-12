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

import { GATEWAY_WS_PORT } from '@clawwork/shared';
import {
  GATEWAY_PORT_OCCUPIED,
  ensureGatewayRunning,
  stopGateway,
  stopGatewayIfOwned,
  type EnsureGatewayRunningResult,
  type GatewayChildProcess,
} from './gateway-process.js';
import { loadNodeVersionContract, nodeCandidates, pickNode, probeNodeVersion } from './node-runtime.js';
import type { PickNodeResult } from './node-runtime.js';
import {
  RUNTIME_MANIFEST_FILE,
  candidateRuntimeRoots,
  fallbackDriveCandidates,
  findDevRuntimeRoots,
  findRuntimeRoot,
  listRemovableDrives,
} from './locate.js';
import { CLAWROUTER_ENTRY, ensureRuntimeDeployed, readCurrentDeployment } from './deploy.js';
import type { CurrentDeployment, DeployResult, DeploymentStamp } from './deploy.js';
import { parseManifest, parseNodeManifest, selectNodeVariant, selectRuntimeVariant } from './manifest.js';
import { ensureClientGatewayEntry } from './state-config.js';
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
  elapsedMs?: number;
}

/**
 * 编排的依赖（可整体替换，便于钉住顺序 —— 真机上"顺序错了"极难复现）。
 *
 * 默认实现全部来自各自模块；测试传一个记录调用的假集合即可。
 */
export interface RuntimeBootstrapDeps {
  alignClientConfig: (opts: { userDataDir: string }) => Promise<{ token: string; stateDir: string }>;
  readCached: (userDataDir: string) => CurrentDeployment;
  deployFromMedia: (opts: { userDataDir: string }) => Promise<DeployResult>;
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
    token: string;
  }) => Promise<EnsureGatewayRunningResult>;
  setStateDirEnv: (stateDir: string) => void;
  log: (event: string, data?: Record<string, unknown>) => void;
  now: () => number;
}

/** 定位部署源 + 读两份 manifest，算出这次要部署什么。 */
async function locateAndPlan(userDataDir: string): Promise<{
  runtimeRoot: string;
  deploy: (o: { userDataDir: string }) => Promise<DeployResult>;
} | null> {
  const devRoots = findDevRuntimeRoots(process.cwd());
  const drives = listRemovableDrives();
  const candidates = candidateRuntimeRoots({
    envDir: process.env.CLAWWORK_RUNTIME_DIR,
    devRoots,
    drives: drives.map((d) => `${d}\\`),
  });
  const hit = findRuntimeRoot(candidates) ?? findRuntimeRoot(fallbackDriveCandidates());
  if (!hit) return null;

  const runtimeRoot = hit.root;
  const manifestPath = hit.manifestPath;
  const raw: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const manifest = parseManifest(raw);
  const runtime = selectRuntimeVariant(manifest, process.platform, process.arch);

  const nodeManifestFile = path.join(runtimeRoot, 'node', 'node-manifest.json');
  if (!fs.existsSync(nodeManifestFile)) return null;
  const nodeManifestRaw: unknown = JSON.parse(fs.readFileSync(nodeManifestFile, 'utf-8'));
  const nodeManifest = parseNodeManifest(nodeManifestRaw);
  const node = selectNodeVariant(nodeManifest, process.platform, process.arch);

  return {
    runtimeRoot,
    deploy: (o) =>
      ensureRuntimeDeployed({
        userDataDir: o.userDataDir,
        runtimeRoot,
        runtime,
        node,
        manifestPath,
      }),
  };
}

function makeDefaultDeps(): RuntimeBootstrapDeps {
  return {
    alignClientConfig: async ({ userDataDir }) => {
      const res = await ensureClientGatewayEntry({ userDataDir });
      return { token: res.token, stateDir: res.stateDir };
    },
    readCached: (userDataDir) => readCurrentDeployment(userDataDir),
    deployFromMedia: async ({ userDataDir }) => {
      const plan = await locateAndPlan(userDataDir);
      if (!plan) {
        throw new Error(
          `找不到运行时盘（认盘的标志是根部有 ${RUNTIME_MANIFEST_FILE}）—— 请插入运行时盘，` +
            '或用 CLAWWORK_RUNTIME_DIR 指定它的位置',
        );
      }
      return plan.deploy({ userDataDir });
    },
    resolveNode: async ({ deployedRoot }) => {
      const deployedNode = path.join(deployedRoot, 'node', 'node.exe');

      // 版本区间来自**部署后的** openclaw 包 —— 不硬编码
      const contract = await loadNodeVersionContract(path.join(deployedRoot, 'node_modules', 'openclaw'));

      return pickNode({
        candidates: nodeCandidates({
          envNode: process.env.CLAWWORK_NODE,
          deployedNodePath: fs.existsSync(deployedNode) ? deployedNode : undefined,
        }),
        probe: probeNodeVersion,
        isSupported: contract.isSupported,
        supportedRange: contract.supportedRange,
      });
    },
    startGateway: async ({ nodeExe, cliPath, deployedRoot, stateDir, token }) =>
      ensureGatewayRunning({
        nodeExe,
        cliPath,
        deployedRoot,
        stateDir,
        token,
        port: GATEWAY_WS_PORT,
        identityPath: path.join(stateDir, '..', 'device-identity.json'),
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
  deps?: Partial<RuntimeBootstrapDeps>;
}): Promise<RuntimeBootstrapResult> {
  const deps: RuntimeBootstrapDeps = { ...makeDefaultDeps(), ...opts.deps };
  const { userDataDir } = opts;
  const startedAt = deps.now();

  const fail = (
    code: string | undefined,
    reason: string,
    extra: Partial<RuntimeBootstrapResult> = {},
  ): RuntimeBootstrapResult => {
    deps.log('runtime.bootstrap.failed', { code, reason });
    return { ok: false, code, reason, elapsedMs: deps.now() - startedAt, ...extra };
  };

  try {
    // ① token 真相源在 state 文件；config 里的那份是副本，在这里对齐
    const { token, stateDir } = await deps.alignClientConfig({ userDataDir });
    deps.setStateDirEnv(stateDir);

    // ② 先认本机缓存（拔盘 / 已部署都走这条，一次都不碰盘）
    let deployed: { deploymentKey: string; deployedRoot: string; cliPath: string; nodePath: string };
    let deployStatus: 'deployed' | 'skipped' | undefined;

    const cached = deps.readCached(userDataDir);
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
      // ③ 没有可用缓存 ⇒ 从盘上部署一份
      const res = await deps.deployFromMedia({ userDataDir });
      deployed = {
        deploymentKey: res.deploymentKey,
        deployedRoot: res.deployedRoot,
        cliPath: res.cliPath,
        nodePath: res.nodePath,
      };
      deployStatus = res.status;
      deps.log('runtime.deploy.done', { deploymentKey: res.deploymentKey, status: res.status });
    }

    // ④ 解析一个能跑 openclaw 的 Node（**必须先探版本**）
    const nodeRes = await deps.resolveNode({
      userDataDir,
      deploymentKey: deployed.deploymentKey,
      deployedRoot: deployed.deployedRoot,
    });
    if (!nodeRes.ok) return fail('runtime.no-usable-node', nodeRes.message, { deploymentKey: deployed.deploymentKey });

    // ⑤ 三态判定后 spawn / 复用（判成 foreign 会抛 port-occupied，由下面接住）
    const gateway = await deps.startGateway({
      nodeExe: nodeRes.node.exe,
      cliPath: deployed.cliPath,
      deployedRoot: deployed.deployedRoot,
      stateDir,
      token,
    });

    // 记下来给退出收尾用（只有 spawned 会被真的停掉）
    activeGateway = {
      ownership: gateway.ownership,
      child: gateway.child,
      nodeExe: nodeRes.node.exe,
      cliPath: deployed.cliPath,
      deployedRoot: deployed.deployedRoot,
      stateDir,
    };

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
      elapsedMs: deps.now() - startedAt,
    };
  } catch (err) {
    const e = err as Error & { code?: string };
    return fail(e.code, e.message, {});
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
