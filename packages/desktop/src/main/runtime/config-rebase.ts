import path from 'node:path';

/**
 * 换盘重写（config rebase）—— **按键名**深度重写配置树里的路径字段。
 *
 * 单独一个模块的理由：这是"换盘换机自愈"的最后一公里，判据必须能**脱离 Electron 单测**
 * （只依赖 `node:path`，没有任何本地依赖），所以遍历与判据集中在这里，由
 * `portable-state-migration.ts` 的 `rebasePortableConfig` 调用。
 *
 * ## 为什么从"逐字段列举"改成"按键名遍历"（事故记录，勿回退）
 *
 * 旧实现（2026-10-15 之前）显式列举了四个位置：
 * `agents.defaults|entries[*]|list[*].workspace|agentDir`、`session.store`、
 * `cron.store`、`skills.load.extraDirs`。**`plugins.load.paths` 不在名单里** ——
 * 而它正是三个承重插件唯一的加载入口（收件箱只读守卫 / 联网搜索 provider /
 * 重试守卫，见 `state-config.ts` 的"装载三条件"：`plugins.load.paths` +
 * `plugins.entries.<id>.enabled` + 插件文件本体），且它的值恰好指向
 * `<stateDir>/<族>/<插件 id>`。换盘符后 stateDir 变了而这三个条目没变 ⇒
 * 网关照常起、插件静默失效、**一条日志都不打**（最坏形态：主线正常、局部坏）。
 *
 * 名单式实现的结构性问题不是"漏了哪一个字段"，而是"新增字段永远要记得回来加一行"。
 * 所以判据改到**键名**这一层：看起来是路径字段的键才参与重写，将来新增同类字段自动覆盖。
 *
 * ## 判据（两层，缺一不可）
 *
 * **① 值层**：只有"字符串 + 绝对路径 + 落在旧 `workspacePath` 或旧 `stateDir` **之下**"
 *    才重写；重写方式沿用原实现（取相对段拼到 `next` 的同名根上）。不落在两个旧根之下的
 *    绝对路径（用户手填的外链、别的盘的目录、别的程序目录）**一律不碰**。
 *    另外沿用原有守卫：`workspacePath` 这条要求"**盘符之后**的部分换盘前后一致"
 *    （`E:\Partner-W工作区` → `F:\Partner-W工作区` 算换盘；`E:\a` → `F:\b` 不算换盘，不改）。
 *
 * **② 键层**：只有键名像"路径字段"的值才参与（见 `isPathKey`）。这条是保护层：配置里同时
 *    存在大量**文本**字段（`prompt`、标题、备注、消息正文），它们的内容可能**正好等于**
 *    一个盘上路径（例如模型提示里引用了工作区绝对路径），那**不是**路径，改了就篡改了
 *    用户数据。两层都满足才动手 ⇒ 误改面被压到最小。
 *
 * ## `file` 这个后缀要按"词"判，不能按字符串后缀（BUG-096，勿回退）
 *
 * 2026-10-16 审计抓到：`channels.telegram.tokenFile` 换盘后仍指向旧盘。它不是虚构字段 ——
 * 随包 OpenClaw 2026.9.3 的 config schema 里 `TelegramAccountSchemaBase.tokenFile:
 * string().optional()`，并明示"从该文件读 token"。旧判据漏它，是因为后缀正则
 * 只有 `(dir|dirs|directory|path|paths|store|root|workspace)`，**没有 `file`**。
 *
 * 但**不能**把 `file` 直接塞进后缀正则：`profile` / `userProfile` 的后四个字符**也是**
 * `file`，它们是画像那类正文键名 —— 一旦值层命中旧根（比如画像里记了"我的工作区在
 * E:\workspace"），后缀正则就会去改写用户数据。所以判据收在 `endsWithFileWord`：
 * `f` 必须是**词首**（大写驼峰 `token|File`，或 `_` / `-` / `.` / 空格分隔）。
 *
 * ## 已知的判据边界（如实记录，不要当成保证）
 *
 * - 后缀判据是**纯后缀**：`restore` 这类以 `store` 结尾、但语义不是路径的键名也会被当成
 *   路径键。这不会篡改数据（值层还要求"绝对路径且落在旧根之下"），但值得知道。
 * - 全小写的复合键（如 `outputdir`）不满足后缀判据，靠 `PATH_KEY_EXACT` 的精确名单兜住；
 *   未列出的冷门全小写拼法**不会**被重写（漏改 > 误改）。`tokenfile` 就是这么进名单的
 *   （它和 `profile` 在小写形态下**形状完全相同**，判不出词边界）。
 * - 键名判据不区分平台；值层的绝对路径判定按值自身形态选 `win32` 或当前平台方言。
 */

/** 会被当成路径字段重写的键名（全部小写比较）。覆盖后缀判据兜不住的全小写/特殊拼法。 */
const PATH_KEY_EXACT = new Set([
  'workspace',
  'workspacedir',
  'workspaceroot',
  'workspacepath',
  'agentdir',
  'agentdirectory',
  'dir',
  'directory',
  'dirs',
  'path',
  'paths',
  'filepath',
  'filepaths',
  'store',
  'storedir',
  'storepath',
  'root',
  'rootdir',
  'cwd',
  'workdir',
  'workdirectory',
  'extradirs',
  'sessionfile',
  'tokenfile',
  'configfile',
  'configpath',
  'file',
  'files',
  'logfile',
  'logdir',
  'tempdir',
  'tmpdir',
  'cachedir',
  'plugindir',
  'policydir',
  'datadir',
  'statedir',
  'basedir',
  'homedir',
  'outputdir',
  'uploaddir',
  'scriptroot',
  'scriptsroot',
]);

/** 键名后缀判据（覆盖 `agentDir`、`workspacePath`、`stateRoot`、`allowedPaths` 这类派生写法）。 */
const PATH_KEY_SUFFIX = /(dir|dirs|directory|path|paths|store|root|roots|workspace)$/u;

/**
 * 键名是否以 `file` / `files` 这个**词**结尾（`tokenFile`、`tokenFiles`、`session_file`、
 * `token-file`、`token.file`）。
 *
 * ⚠️ 不能写成后缀正则：`profile` / `userProfile` 的后四个字符**也是** `file` —— 后缀匹配会
 *    把它们一起卷进来（值层一旦命中旧根就会去改画像这类用户数据）。所以要求 `f` 是**词首**：
 *    大写驼峰（`token|File`）或紧跟在非字母数字的分隔符后面。
 *    整体小写的 `tokenfile` 与 `profile` 形状无法区分 ⇒ 靠 `PATH_KEY_EXACT` 兜（漏改 > 误改）。
 */
function endsWithFileWord(key: string): boolean {
  const lower = key.toLowerCase();
  const plural = lower.endsWith('files');
  const wordLength = plural ? 5 : 4;
  if (key.length < wordLength) return false;
  if (lower.slice(-wordLength) !== (plural ? 'files' : 'file')) return false;
  const index = key.length - wordLength;
  if (index === 0) return true; // 整个键名就是 `file` / `files`
  if (key[index] === 'F') return true; // 驼峰词首：tokenFile
  return !/[A-Za-z0-9]/u.test(key[index - 1] ?? ''); // 分隔符：token_file / token-file
}

/**
 * 键名是否"看起来是路径字段"。调用方只对**值**再套一层绝对路径 + 旧根之下判据，
 * 所以这里的宽进不会篡改文本内容。
 */
export function isPathKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (PATH_KEY_EXACT.has(lower)) return true;
  if (endsWithFileWord(key)) return true;
  // 长度下限 4：最短的后缀是 3 字符的 `dir`（它已在精确名单里），这条纯属保守起见 ——
  // 别把 1–3 字符的短键名卷进后缀匹配。
  return lower.length >= 4 && PATH_KEY_SUFFIX.test(lower);
}

export interface RebaseLocation {
  /** 运行数据/状态根（换盘前后各自的绝对路径）。 */
  stateDir: string;
  /** 工作区根（换盘前后各自的绝对路径）。 */
  workspacePath: string;
}

/**
 * 单个路径值的重写（原 `portable-state-migration.ts` 的 `rebasePath`，判据一字未改）。
 * 不满足判据时**原样返回**（调用方用 `!==` 判断是否发生变化）。
 */
export function rebasePathValue(value: unknown, previous: RebaseLocation, next: RebaseLocation): unknown {
  if (typeof value !== 'string') return value;
  const flavor = /^[A-Za-z]:[\\/]/u.test(value) ? path.win32 : path;
  if (!flavor.isAbsolute(value)) return value;
  for (const key of ['workspacePath', 'stateDir'] as const) {
    if (!previous[key]) continue;
    if (
      key === 'workspacePath' &&
      path.win32.normalize(previous[key]).slice(2).toLowerCase() !==
        path.win32.normalize(next[key]).slice(2).toLowerCase()
    )
      continue;
    const relative = flavor.relative(previous[key], value);
    if (
      relative === '' ||
      (!relative.startsWith(`..${flavor.sep}`) && relative !== '..' && !flavor.isAbsolute(relative))
    ) {
      return flavor.join(next[key], relative);
    }
  }
  return value;
}

export interface RebaseConfigResult<T> {
  config: T;
  /** 被改写的字段路径（JSON 指针风格，如 `/plugins/load/paths[0]`），供日志/排查用。 */
  changed: string[];
}

/** 只有"字面对象"才逐键遍历；日期/Map/类实例等原样保留，避免重建时丢数据。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * 深度遍历配置树，**按键名判据**重写路径字段。返回新对象，不改入参。
 *
 * `pathKeyed` 表示"当前节点位于一个路径键之下"：字符串与它下面的整串数组/对象
 * 都按路径处理（`plugins.load.paths` 就是字符串数组，`paths: [{dir: …}]` 也照顾到）。
 * 数组/对象元素本身不是路径 ⇒ 它们的子键各自再按键名判据决定，靠值层兜底。
 */
export function rebaseConfigPaths<T>(config: T, previous: RebaseLocation, next: RebaseLocation): RebaseConfigResult<T> {
  const changed: string[] = [];
  const walk = (node: unknown, pathKeyed: boolean, trail: string): unknown => {
    if (typeof node === 'string') {
      if (!pathKeyed) return node;
      const rebased = rebasePathValue(node, previous, next);
      if (rebased !== node) changed.push(trail);
      return rebased;
    }
    if (Array.isArray(node)) return node.map((item, index) => walk(item, pathKeyed, `${trail}[${index}]`));
    if (isPlainRecord(node)) {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) result[key] = walk(value, isPathKey(key), `${trail}/${key}`);
      return result;
    }
    return node;
  };
  return { config: walk(structuredClone(config), false, '') as T, changed };
}
