/**
 * 某个**助手的工作区目录** —— 网关配置里的 `agents.entries.<agentId>.workspace`。
 *
 * ## 为什么产物侧要问这个（2026-09-27 真机取证）
 *
 * 助手把文件写在**它自己的工作区**里，而产物原先只认**应用工作区**
 * （`<appWorkspace>/<taskId>/…`）。两者是**兄弟目录**，永不重叠 ⇒
 * 助手直接用 exec 生成的文件从来没进过产物表（真机 `.clawwork.db` 实测 `COUNT(*) = 0`，
 * 用户看到的是"文件在那儿、产物面板空的"）。
 *
 * 于是新增的那个受信根（见 `access.ts` 的 `ArtifactRoots`）需要一个来源：
 * **这个模块**。
 *
 * ## 两条设计约束
 *
 * 1. **不许抛。** 它跑在一轮消息收尾的产物链上 —— 网关没连、RPC 超时、agent 没有显式
 *    workspace，都只能让这条链**少收一点东西**，绝不能把 auto-extract / docgen /
 *    对账链一起掀翻（那条路径上已经踩过一次）。
 * 2. **不许猜。** 读不到就是 `null` ⇒ 调用方当作"没有这个根"，**不扫、不回落**。
 *    回落会把 `root:'agent'` 的行解析到别的目录，出错方向恰好是
 *    "把别的目录的文件当成这个任务的产物"。
 *
 * ## 为什么不直接在这儿 `getGatewayClient()`
 *
 * 那会把 `electron` 拖进本模块（`ws/gateway-client.ts` 顶层 `import { app } from 'electron'`），
 * 于是单测必须先 mock electron 才能碰纯逻辑。改成**注入** `listAgentFiles`：
 * 本模块只依赖 `node:` 与自己的类型，行为全部可单测。
 */

/** 取 workspace 的那一次 RPC。调用方注入（生产实现见 `data-handlers.ts`）。 */
export type ListAgentFiles = (gatewayId: string, agentId: string) => Promise<unknown>;

/**
 * 成功结果的缓存时长。
 *
 * 助手的工作区很少变（用户在设置里改 agent 才会变），但一轮消息可能要问好几次
 * （基线那一刻 + 收尾那一刻），所以必须缓存 —— 否则每一轮都多两次 RPC。
 */
const CACHE_TTL_MS = 5 * 60_000;

/**
 * **失败**结果的缓存时长，短得多。
 *
 * ⚠️ 失败也必须缓存：网关没连上时，不缓存就要**每一轮**等一次 RPC（最长 15 秒超时）。
 * ⚠️ 但也不能缓存久：网关是**后起来**的（冷启动时产物链可能比它先跑），
 *    把"刚启动那一次读不到"钉死 5 分钟，会让这台机器整整 5 分钟收不到任何产物。
 */
const FAILURE_TTL_MS = 20_000;

interface CacheEntry {
  workspace: string | null;
  at: number;
}

const cache = new Map<string, CacheEntry>();

const keyOf = (gatewayId: string, agentId: string): string => `${gatewayId}\u0000${agentId}`;

/** 测试与"用户改了 agent 配置"时清缓存。 */
export function clearAgentWorkspaceCache(): void {
  cache.clear();
}

/**
 * 从 `agents.files.list` 的回包里取出工作区。
 *
 * 形状（白皮书 §`agents.files.*`）：`{ agentId, workspace, files }`。
 * 取不到 / 不是非空字符串 / 含 NUL ⇒ `null`。**不抛**。
 */
function readWorkspaceFrom(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>)['workspace'];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  return trimmed;
}

/**
 * 解析出助手的工作区；**读不到一律 `null`，绝不抛**。
 *
 * @param deps.listAgentFiles 注入的 RPC（生产实现见 `data-handlers.ts`）
 */
export async function resolveAgentWorkspace(params: {
  gatewayId: string;
  agentId: string;
  listAgentFiles: ListAgentFiles;
}): Promise<string | null> {
  const { gatewayId, agentId, listAgentFiles } = params;
  if (!gatewayId || !agentId) return null;

  const key = keyOf(gatewayId, agentId);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit) {
    const ttl = hit.workspace === null ? FAILURE_TTL_MS : CACHE_TTL_MS;
    if (now - hit.at < ttl) return hit.workspace;
  }

  let workspace: string | null = null;
  try {
    workspace = readWorkspaceFrom(await listAgentFiles(gatewayId, agentId));
  } catch {
    // 这里**刻意吞掉**：见文件头第 1 条约束。失败会被缓存成 null，所以不会每轮重试。
    workspace = null;
  }

  cache.set(key, { workspace, at: Date.now() });
  return workspace;
}
