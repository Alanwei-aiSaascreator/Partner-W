/**
 * 出厂运行时包的两份 manifest：OpenClaw 运行时本体 + 随行的 Node。
 *
 * OpenClaw 那份由 `scripts/pack-runtime.mjs` 产出；Node 那份由
 * `scripts/fetch-node-runtime.mjs` 产出。**两份都在 U 盘上、都在部署时被消费**。
 *
 * ⚠️ 这一层只做「读 + 校验 + 选变体 + 算身份」，**不碰文件系统**（除了拼路径）——
 * 装载器最容易出静默错误的地方就是路径解析，把它做成纯函数才测得住。
 *
 * ⚠️ 三条已实测的坑，改代码前先看：
 *   ① `archive` 是**相对运行时根**的路径。`runtime-out/` 下有两份 manifest
 *      （根一份、`openclaw-runtime/` 里一份副本），按副本自身目录解析会得到
 *      `openclaw-runtime/win32-x64/...` —— 一个**不存在**的路径。
 *      ⇒ 本模块所有 resolve* 都必须显式接收 `runtimeRoot`，**绝不从 manifest 路径反推**。
 *   ② `size` 字段是硬编码 0，真体积在 `archiveSize`。
 *   ③ `extractor` 字段指向**不存在的文件**（`win32-x64/extractor/7za.exe`）。
 *      ⇒ 本模块**刻意不提供**任何把它解析成可执行路径的导出。装载器一律自解压。
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

/** 部署布局的版本。改了 `deployed/<key>/` 的结构就要 +1 —— 它进 deployment key，
 *  所以旧目录不会被误当成新布局复用。 */
export const DEPLOYMENT_SCHEMA_VERSION = 1;

/** 运行时 manifest 的格式版本（`pack-runtime.mjs` 写的那个）。 */
const RUNTIME_FORMAT_VERSION = 1;
/** 随行 Node manifest 的格式版本。 */
const NODE_FORMAT_VERSION = 1;

export interface RuntimeVariant {
  platform: string;
  arch: string;
  version: string;
  runtimeDeploymentKey: string;
  /** ⚠️ 相对**运行时根**，不是相对 manifest 自身。 */
  archive: string;
  archiveSize: number;
  /** ⚠️ 指向不存在的文件，**不要用**。装载器自解压。 */
  extractor: string;
  /** ⚠️ 硬编码 0，**不要用**；真体积看 `archiveSize`。 */
  size: number;
  fileCount: number;
  packageRoot: string;
  /** 拉起网关要用的入口，相对运行时根。 */
  cliPath: string;
  source: string;
  sha256: string;
}

export interface RuntimeManifest {
  formatVersion: number;
  packageName: string;
  version: string;
  runtimes: RuntimeVariant[];
}

export interface NodeVariant {
  platform: string;
  arch: string;
  version: string;
  /** ⚠️ 相对**运行时根**（形如 `node/node.exe`）。 */
  path: string;
  sha256: string;
  size: number;
  source: string;
}

export interface NodeManifest {
  formatVersion: number;
  packageName: string;
  nodes: NodeVariant[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function requireString(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`${where}: 字段 \`${key}\` 必须是非空字符串，实际是 ${JSON.stringify(v)}`);
  }
  return v;
}

function requireNumber(o: Record<string, unknown>, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${where}: 字段 \`${key}\` 必须是数字，实际是 ${JSON.stringify(v)}`);
  }
  return v;
}

/**
 * 校验运行时 manifest。
 *
 * ⚠️ 缺字段必须**报错**而不是回退默认值 —— `pack-runtime.mjs` 那边的测试逐个钉死了字段名，
 * 就是为了「少一个字段那边就是 undefined」。这边同样：宁可启动时炸，不要静默用一个空 sha256。
 */
export function parseManifest(raw: unknown): RuntimeManifest {
  if (!isRecord(raw)) throw new Error('运行时 manifest: 顶层必须是对象');
  const formatVersion = requireNumber(raw, 'formatVersion', '运行时 manifest');
  if (formatVersion !== RUNTIME_FORMAT_VERSION) {
    throw new Error(
      `运行时 manifest: 不认识的 formatVersion ${formatVersion}（本装载器只认 ${RUNTIME_FORMAT_VERSION}）`,
    );
  }
  if (!Array.isArray(raw.runtimes) || raw.runtimes.length === 0) {
    throw new Error('运行时 manifest: `runtimes` 必须是非空数组');
  }
  const runtimes = raw.runtimes.map((r, i): RuntimeVariant => {
    const where = `运行时 manifest: runtimes[${i}]`;
    if (!isRecord(r)) throw new Error(`${where} 必须是对象`);
    return {
      platform: requireString(r, 'platform', where),
      arch: requireString(r, 'arch', where),
      version: requireString(r, 'version', where),
      runtimeDeploymentKey: requireString(r, 'runtimeDeploymentKey', where),
      archive: requireString(r, 'archive', where),
      archiveSize: requireNumber(r, 'archiveSize', where),
      // extractor / size 只读进来放着（保持与打包器同形），**不参与任何解析**
      extractor: typeof r.extractor === 'string' ? r.extractor : '',
      size: typeof r.size === 'number' ? r.size : 0,
      fileCount: requireNumber(r, 'fileCount', where),
      packageRoot: requireString(r, 'packageRoot', where),
      cliPath: requireString(r, 'cliPath', where),
      source: typeof r.source === 'string' ? r.source : '',
      sha256: requireString(r, 'sha256', where),
    };
  });
  return {
    formatVersion,
    packageName: typeof raw.packageName === 'string' ? raw.packageName : 'openclaw',
    version: typeof raw.version === 'string' ? raw.version : runtimes[0].version,
    runtimes,
  };
}

/** 校验随行 Node manifest。缺 `nodes` 直接报错 —— 没有它就无法校验**真正被执行的 node.exe**。 */
export function parseNodeManifest(raw: unknown): NodeManifest {
  if (!isRecord(raw)) throw new Error('Node manifest: 顶层必须是对象');
  const formatVersion = requireNumber(raw, 'formatVersion', 'Node manifest');
  if (formatVersion !== NODE_FORMAT_VERSION) {
    throw new Error(`Node manifest: 不认识的 formatVersion ${formatVersion}（本装载器只认 ${NODE_FORMAT_VERSION}）`);
  }
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new Error('Node manifest: `nodes` 必须是非空数组');
  }
  const nodes = raw.nodes.map((n, i): NodeVariant => {
    const where = `Node manifest: nodes[${i}]`;
    if (!isRecord(n)) throw new Error(`${where} 必须是对象`);
    return {
      platform: requireString(n, 'platform', where),
      arch: requireString(n, 'arch', where),
      version: requireString(n, 'version', where),
      path: requireString(n, 'path', where),
      sha256: requireString(n, 'sha256', where),
      size: typeof n.size === 'number' ? n.size : 0,
      source: typeof n.source === 'string' ? n.source : '',
    };
  });
  return { formatVersion, packageName: typeof raw.packageName === 'string' ? raw.packageName : 'node', nodes };
}

function selectVariant<T extends { platform: string; arch: string }>(
  variants: T[],
  platform: string,
  arch: string,
  what: string,
): T {
  const hit = variants.find((v) => v.platform === platform && v.arch === arch);
  if (!hit) {
    const have = variants.map((v) => `${v.platform}/${v.arch}`).join(', ');
    throw new Error(`${what}: 找不到 ${platform}/${arch} 的变体（清单里只有: ${have}）`);
  }
  return hit;
}

export function selectRuntimeVariant(m: RuntimeManifest, platform: string, arch: string): RuntimeVariant {
  return selectVariant(m.runtimes, platform, arch, '运行时 manifest');
}

export function selectNodeVariant(m: NodeManifest, platform: string, arch: string): NodeVariant {
  return selectVariant(m.nodes, platform, arch, 'Node manifest');
}

/**
 * `archive` 相对路径 → 绝对路径。
 * ⚠️ 基准是**调用方给的运行时根**，不是 manifest 文件所在目录（见文件头坑 ①）。
 */
export function resolveArchivePath(runtimeRoot: string, variant: RuntimeVariant): string {
  return joinUnderRoot(runtimeRoot, variant.archive);
}

/** 同上，用于随行 Node。 */
export function resolveNodePath(runtimeRoot: string, variant: NodeVariant): string {
  return joinUnderRoot(runtimeRoot, variant.path);
}

function joinUnderRoot(root: string, relative: string): string {
  // manifest 里的分隔符是正斜杠；统一交给 path.join 处理平台差异。
  return path.join(root, relative);
}

/** `computeDeploymentKey` 的输入 —— 每一项都必须影响结果。 */
export interface DeploymentIdentity {
  /** OpenClaw 运行时版本（只为可读性，唯一性由 archiveSha256 保证）。 */
  version: string;
  archiveSha256: string;
  nodeVersion: string;
  nodeSha256: string;
  platform: string;
  arch: string;
  schemaVersion: number;
}

/**
 * 算 deployment key —— 本机缓存目录名，也是「要不要重新部署」的判据。
 *
 * ⚠️ **Node 必须进这个身份。** 只按 OpenClaw 版本算的话，换了 Node 却复用旧缓存，
 * 跑起来的还是缓存里那个旧 `node.exe` —— 而 Node 是**真正被执行的东西**。
 *
 * 结果形如 `2026.9.3-win32-x64-1a2b3c4d5e6f`：可读前缀便于排查，后缀保证唯一。
 */
export function computeDeploymentKey(id: DeploymentIdentity): string {
  // 顺序固定 —— 这是身份的一部分，改顺序会让所有既有缓存失效（可接受，但要知情）。
  const canonical = [
    `schema=${id.schemaVersion}`,
    `platform=${id.platform}`,
    `arch=${id.arch}`,
    `archive=${id.archiveSha256}`,
    `node=${id.nodeVersion}:${id.nodeSha256}`,
  ].join('\n');
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12);
  return `${id.version}-${id.platform}-${id.arch}-${digest}`;
}
