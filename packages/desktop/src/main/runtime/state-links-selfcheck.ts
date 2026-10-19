/**
 * 启动自检：state 目录里指向**随包运行时**的链接，目标还在不在。
 *
 * 为什么要有这个（2026-09-20 第六/十刀量出来的）：
 * · `<state>\plugin-skills\*` 与 `<state>\npm\projects\*\node_modules\openclaw` 这两类链接
 *   指向**部署出来的那份运行时**（实测形状：`…\deployed\<key>\node_modules\openclaw\dist\
 *   extensions\<ext>\skills\<name>`）。盘符变了、或换了台机器插，目标就没了；
 * · 网关**不会修**它们：
 *   - `plugin-skills` 那侧的重建判据是 `fs.readlinkSync(linkPath) === target` 的**字符串比较**
 *     —— 盘符变了之后两边"恰好还相等"（`readlink` 不解析目标）⇒ 直接 `continue`；
 *   - managed npm 那侧的修复挂在"检查点过期"这道闸门后面（第十刀实测：盘符变化 **会**让检查点
 *     过期 ⇒ 那侧会自修），但 `plugin-skills` 那侧没有对应的路。
 * ⇒ 用户看到的是「插件用不了」「市场技能装不上」，而日志里只有一句 `log.warn`。
 *
 * 本模块做三件事，且**修得刻意地窄**：
 *   ① 只读探测（判据与给同事那支诊断工具**同一套**，词表由漂移守卫盯着）；
 *   ② 修 = 把链接里那个**旧根前缀**换成当前运行时的根前缀（**后缀逐字不动**），而且
 *      "换过去的目标"必须**在盘上真的存在**才动手 ⇒ 不猜路径；
 *   ③ 修不了要**说出来**（返回给编排层写日志/界面），不是悄悄算了。
 *
 * ⚠️ **绝不碰**真目录 / 真文件（"整目录拷过来的盘"就长这样，删了就是丢真技能文件）。
 * ⚠️ 本模块**只读 + 只动"悬空的那些链接自己"**；真目录、指向别处的活链接一律"只报告"。
 *
 * 本机实测（2026-09-20，临时目录）：`lstat` 是链接、`readlink` 出旧串、跟随 `stat` 抛 ENOENT；
 * `unlinkSync(链接)` **只掉链接**（目标目录与内容一字不动，活的悬空的都一样）；悬空链接的
 * `unlink` 不报 EPERM；`symlinkSync(target, link, 'junction')` 可重建、无需管理员。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 链接分类的**动作词表** —— 与 `scripts/lib/udisk-diagnose.mjs` 的 `classifyLink` 必须一致
 * （那边的 `BUCKETS` 用同一批字符串）。漂移守卫在 `test/runtime-links-drift.test.ts`。
 */
export const STATE_LINK_KINDS = [
  'ok',
  'not-needed',
  'not-created',
  'unknown',
  'dangling',
  'elsewhere',
  'real-dir',
  'real-file',
] as const;
export type StateLinkKind = (typeof STATE_LINK_KINDS)[number];

/** 真坏（会真的让插件装不上/加载不了）的那几种 —— 照工具那套。 */
const BROKEN_KINDS: readonly StateLinkKind[] = ['dangling', 'elsewhere', 'real-dir', 'real-file'];

export const PLUGIN_SKILLS_DIR_NAME = 'plugin-skills';
/** managed npm 的项目根（`<state>\npm\projects\<项目>`）。 */
export const MANAGED_NPM_PROJECTS_SEGMENTS = ['npm', 'projects'] as const;
/** 项目里那条 host 链接的相对位置。 */
export const MANAGED_NPM_LINK_SEGMENTS = ['node_modules', 'openclaw'] as const;
/**
 * 官方插件根（`<state>\extensions\<插件>`）。
 *
 * 2026-10-19 现场：`openclaw plugins install` 装的插件会在
 * `<插件>\node_modules\openclaw` 建一条指向随包运行时的 junction —— 第三种链接形状。
 * 盘符一变它就悬空，而网关**不会**重建它（它的判据是字符串相等），表现是插件加载不了。
 */
export const EXTENSIONS_DIR_NAME = 'extensions';

/**
 * 换根前缀时的**锚点**：链接目标里第一次出现 `node_modules\openclaw` 的地方。
 *
 * 为什么是它而不是"整个旧根"：旧根长什么样只有链接串自己知道（我们不做猜测式重建），
 * 而 `node_modules\openclaw` 是这两类链接**共有的稳定后缀起点**（技能链在它后面还有
 * `dist\extensions\…`）。取**第一次**出现（而不是最后一次）：留着更长的后缀，
 * "换过去存不存在"这道校验才更严；取最后一次反而容易"恰好命中"一个不是原意的目录。
 */
export const LINK_ANCHOR_SEGMENTS = ['node_modules', 'openclaw'] as const;

/**
 * Windows 上建 junction（不需要管理员）；Linux/macOS 上 Node 会退化成普通符号链接 ——
 * 两边都满足"这是个指向目录的链接"这个前提。
 */
export const DIRECTORY_LINK_TYPE = 'junction';

export interface LinkProbeFacts {
  lstat: { exists: boolean; symlink?: boolean; dir?: boolean };
  readlink: string | null;
  stat: { ok: boolean; code?: string; dir?: boolean };
}

export interface LinkJudgement {
  kind: StateLinkKind;
  /** 链接里存的**原始字符串**（没解析过）—— 修复全靠它。 */
  target: string | null;
  detail: string;
}

export interface StateLinkFinding extends LinkJudgement {
  path: string;
}

/** 比较路径用的归一：分隔符统一 + 去尾部分隔符 + 小写（Windows 大小写不敏感）。 */
function foldPathForCompare(p: string): string {
  return p
    .replace(/[\\/]+/g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

/** `child` 是否在 `root` 里面（含等于）—— 大小写不敏感，且**不是**裸前缀比较。 */
export function isUnderRoot(child: string, root: string): boolean {
  const c = foldPathForCompare(child);
  const r = foldPathForCompare(root);
  if (!c || !r) return false;
  if (c === r) return true;
  return c.startsWith(`${r}\\`);
}

/**
 * 分类一条链接 —— 分支顺序与诊断工具的 `classifyLink` **逐条对应**。
 *
 * ⚠️ "这里什么都没有"分三档（`needed` 来自项目自己的 `package.json`）：混成一个就会报假警报
 * （工具那边实测报过 2 条）。
 */
export function classifyStateLink(
  facts: LinkProbeFacts,
  opts: { expectedRoot: string; needed: boolean | null | undefined; alsoAllowedRoot?: string },
): LinkJudgement {
  const { expectedRoot, needed, alsoAllowedRoot } = opts;

  if (!facts.lstat || facts.lstat.exists === false) {
    if (needed === false) {
      return {
        kind: 'not-needed',
        target: null,
        detail: '项目没有声明 openclaw 依赖（照网关自己的判据）—— 本来就不需要这条链',
      };
    }
    if (needed === null || needed === undefined) {
      return {
        kind: 'unknown',
        target: null,
        detail: '这里没有链接，而项目里的 package.json 读不出来（或被清了）⇒ 判不了该不该有',
      };
    }
    return { kind: 'not-created', target: null, detail: '网关还没建过它（装过又卸掉、或者压根没走到那一步）' };
  }

  if (!facts.lstat.symlink) {
    if (facts.lstat.dir) {
      return {
        kind: 'real-dir',
        target: null,
        detail: '是一个真目录，不是链接（常见于"整目录拷过来的盘"）—— 网关要的是链接，但**里面是真文件，不许删**',
      };
    }
    return { kind: 'real-file', target: null, detail: '这里是个文件，不是链接也不是目录' };
  }

  const target = facts.readlink ?? null;

  if (!facts.stat || !facts.stat.ok) {
    return {
      kind: 'dangling',
      target,
      detail:
        `链接的目标不存在（${facts.stat?.code ?? 'ENOENT'}）：${target ?? '（读不出目标）'}` +
        ' —— 盘符变过、或盘上那份运行时被删/被换，都会成这样',
    };
  }

  if (!facts.stat.dir) {
    return { kind: 'real-file', target, detail: `链接指向的不是目录：${target ?? '?'}` };
  }

  const underAllowed =
    (expectedRoot !== undefined && target !== null && isUnderRoot(target, expectedRoot)) ||
    (alsoAllowedRoot !== undefined && target !== null && isUnderRoot(target, alsoAllowedRoot));
  if (!underAllowed && target) {
    return {
      kind: 'elsewhere',
      target,
      detail: `指到别处：${target} —— 不是这份程序正在用的那一份（${expectedRoot}）`,
    };
  }

  return { kind: 'ok', target, detail: '目标存在，且就在当前运行时下' };
}

/** 这一种算不算"坏链"（照工具的 `isBrokenLink`）。 */
export function isBrokenStateLink(kind: StateLinkKind): boolean {
  return BROKEN_KINDS.includes(kind);
}

/**
 * 项目声明了 `openclaw` 依赖吗 —— 判据**照抄**网关的 `resolveOpenClawHostDependency`
 * （`dist/plugin-peer-link-*.mjs`：先 `peerDependencies.openclaw`，再 `dependencies.openclaw`，
 * 非空字符串才算声明）。返回 `needed: null` 表示**判不了**，不许当成 false。
 */
export function openclawPeerLinkNeeded(manifest: unknown): {
  needed: boolean | null;
  declaration: string | null;
} {
  if (!manifest || typeof manifest !== 'object') return { needed: null, declaration: null };
  const record = manifest as Record<string, unknown>;
  for (const declaration of ['peerDependencies', 'dependencies']) {
    const deps = record[declaration];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    const spec = (deps as Record<string, unknown>).openclaw;
    if (typeof spec === 'string' && spec.length > 0) return { needed: true, declaration };
  }
  return { needed: false, declaration: null };
}

export type LinkRewrite = { ok: true; target: string } | { ok: false; why: string };

/**
 * 换根前缀：`target` 里第一次出现 `node_modules\openclaw` 之前的部分换成 `newRoot`，
 * **从锚点起的后缀逐字不动**。
 *
 * 判据刻意只有两条：
 *   · 找得到锚点；
 *   · 换完之后和原来不一样。
 * ⇒ 找不到锚点就**拒绝**（宁可报"修不了"，也不猜一个路径出来）。
 */
export function rewriteLinkTarget(target: string, newRoot: string): LinkRewrite {
  const segments = target.split(/[\\/]+/).filter((s) => s.length > 0);
  const anchorIndex = segments.findIndex(
    (s, i) =>
      s.toLowerCase() === LINK_ANCHOR_SEGMENTS[0] && (segments[i + 1] ?? '').toLowerCase() === LINK_ANCHOR_SEGMENTS[1],
  );
  if (anchorIndex < 0) {
    return {
      ok: false,
      why: `链接目标里找不到锚点 ${LINK_ANCHOR_SEGMENTS.join('\\')} ⇒ 不敢猜它是从哪份运行时代过来的：${target}`,
    };
  }
  const rewritten = path.join(newRoot, ...segments.slice(anchorIndex));
  if (foldPathForCompare(rewritten) === foldPathForCompare(target)) {
    return { ok: false, why: `链接已经指在当前运行时下（不用改）：${target}` };
  }
  return { ok: true, target: rewritten };
}

/** 去掉 Windows 扩展前缀（`\\?\` / `\\?\UNC\`）——只用于比较与重写，不写回。 */
function stripExtendedPrefix(value: string): string {
  return value.replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\/iu, '');
}

/**
 * 换**盘符**而不是换运行时根（2026-10-19 现场盘）。
 *
 * 插件自带的技能链（`plugin-skills\feishu-doc` 这类）指向的是 **state 目录**
 * （`<state>\extensions\feishu\skills\...`），里面**没有** `node_modules\openclaw`
 * 锚点 ⇒ 换根那条路按设计拒绝。可它与当前 state 根**只差一个盘符**：
 * 换掉盘符后目标在盘上真实存在 ⇒ 这是映射，不是猜。
 */
export function rewriteLinkVolume(target: string, root: string): string | null {
  const bare = stripExtendedPrefix(target);
  const targetDrive = /^([A-Za-z]):(?=[\\/])/u.exec(bare);
  const rootDrive = /^([A-Za-z]):(?=[\\/])/u.exec(stripExtendedPrefix(root));
  if (!targetDrive || !rootDrive) return null;
  if (targetDrive[1].toLowerCase() === rootDrive[1].toLowerCase()) return null;
  return rootDrive[1] + bare.slice(1);
}

/**
 * 换盘符的**安全版**：换完必须仍在 `stateDir`（当前 state 根）之下。
 *
 * 2026-10-19 自审：只判"换完之后目标存在"是不够的。旧盘符被另一台装了本产品的电脑
 * 占用时，`E:\<别人的运行数据>\state\<别的身份哈希>\...` 换到 F: 也可能"恰好存在"——
 * 那是别人那块盘上的数据，不是这份 state 的。路径里的身份哈希段就是身份证据：
 * 要求换完仍 `isUnderRoot(…, stateDir)`，不满足就一个字节都不改。
 */
export function rewriteLinkVolumeForState(target: string, stateDir: string): string | null {
  const rewritten = rewriteLinkVolume(target, stateDir);
  if (rewritten === null) return null;
  return isUnderRoot(rewritten, stateDir) ? rewritten : null;
}

/** 一条链的实际探测（只读）。 */
function probeOne(
  linkPath: string,
  expectedRoot: string,
  needed: boolean | null,
  alsoAllowedRoot?: string,
): StateLinkFinding {
  const empty: LinkProbeFacts = { lstat: { exists: false }, readlink: null, stat: { ok: false, code: 'ENOENT' } };
  let facts = empty;
  try {
    const st = fs.lstatSync(linkPath);
    facts = {
      lstat: { exists: true, symlink: st.isSymbolicLink(), dir: st.isDirectory() },
      readlink: null,
      stat: { ok: false, code: 'ENOENT' },
    };
  } catch {
    return { ...classifyStateLink(empty, { expectedRoot, needed, alsoAllowedRoot }), path: linkPath };
  }

  if (facts.lstat.symlink) {
    try {
      facts.readlink = fs.readlinkSync(linkPath);
    } catch {
      facts.readlink = null;
    }
  }
  try {
    const st = fs.statSync(linkPath);
    facts.stat = { ok: true, dir: st.isDirectory() };
  } catch (err) {
    facts.stat = { ok: false, code: (err as NodeJS.ErrnoException).code ?? 'UNKNOWN' };
  }
  return { ...classifyStateLink(facts, { expectedRoot, needed, alsoAllowedRoot }), path: linkPath };
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8').replace(new RegExp('^\uFEFF'), ''));
  } catch {
    return null;
  }
}

function dirEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 目录项本身存在（悬空链接的 `existsSync` 会是 false，所以用 lstat）。 */
function entryExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * npm 项目里每个包自己的 peer 链候选：`<pkg>/node_modules/openclaw`（含 `@scope/name`）。
 *
 * 只列**候选**，是否探测由调用方按"这条链本来就在"决定；跳过 `.bin` 与顶层那条
 * managed 链（顶层由 `MANAGED_NPM_LINK_SEGMENTS` 单独负责）。
 */
function nestedPeerLinks(projectRoot: string): string[] {
  const modules = path.join(projectRoot, 'node_modules');
  const out: string[] = [];
  for (const entry of dirEntries(modules)) {
    if (entry.name.startsWith('.') || entry.name.toLowerCase() === 'openclaw') continue;
    const packageNames = entry.name.startsWith('@')
      ? dirEntries(path.join(modules, entry.name)).map((pkg) => path.join(entry.name, pkg.name))
      : [entry.name];
    for (const name of packageNames) {
      out.push(path.join(modules, name, 'node_modules', 'openclaw'));
    }
  }
  return out;
}

/**
 * 只读探测 state 目录里那三类链接：`plugin-skills\*`、managed npm 的
 * `node_modules\openclaw`、以及官方插件的 `extensions\<插件>\node_modules\openclaw`。
 * 目录不存在 ⇒ 返回空（不是错误：新机器上本来就没有）。
 */
export function probeStateLinks(opts: {
  stateDir: string;
  deployedRoot: string;
  notes?: string[];
}): StateLinkFinding[] {
  const { stateDir, deployedRoot } = opts;
  const out: StateLinkFinding[] = [];

  const skillsDir = path.join(stateDir, PLUGIN_SKILLS_DIR_NAME);
  if (fs.existsSync(skillsDir)) {
    // 技能链是网关自己建的 ⇒ 少了是"还没建"，不当坏链（与工具一致：needed: true）
    for (const e of dirEntries(skillsDir)) {
      // 插件技能链可能指向**运行时**（随包插件）或 **state**（npm 装的插件）—— 两种都算正常。
      out.push(probeOne(path.join(skillsDir, e.name), deployedRoot, true, stateDir));
    }
  } else {
    opts.notes?.push(`${PLUGIN_SKILLS_DIR_NAME}：目录不存在（网关还没建过技能链）`);
  }

  const projectsDir = path.join(stateDir, ...MANAGED_NPM_PROJECTS_SEGMENTS);
  if (fs.existsSync(projectsDir)) {
    for (const project of dirEntries(projectsDir)) {
      if (!project.isDirectory()) continue;
      const projectRoot = path.join(projectsDir, project.name);
      const link = path.join(projectRoot, ...MANAGED_NPM_LINK_SEGMENTS);
      // ⭐ 先问"这个项目到底该不该有这条链"（判据照抄网关）。不问就会把"本来就不需要"
      //    报成"坏链" —— 工具那边实测报过 2 条假警报。
      const manifestFile = path.join(projectRoot, 'package.json');
      const needed = fs.existsSync(manifestFile) ? openclawPeerLinkNeeded(readJsonFile(manifestFile)).needed : null;
      out.push(probeOne(link, deployedRoot, needed));
      // ⭐ 2026-10-19（用户实测「登不进去」）：项目里**包自己**的 node_modules 下
      //    还可能有一条 peer 链（`node_modules/@openclaw/feishu/node_modules/openclaw`）。
      //    它同样指向运行时、同样会因换盘符悬空；旧探测看不到它 ⇒ 插件拿到旧盘的内核。
      //    只探**已经存在**的那条（没有就是没建，不算坏）。
      for (const peerLink of nestedPeerLinks(projectRoot)) {
        if (!entryExists(peerLink)) continue;
        out.push(probeOne(peerLink, deployedRoot, false));
      }
    }
  } else {
    opts.notes?.push(`${MANAGED_NPM_PROJECTS_SEGMENTS.join('\\')}：目录不存在（没装过 npm 插件项目）`);
  }

  const extensionsDir = path.join(stateDir, EXTENSIONS_DIR_NAME);
  if (fs.existsSync(extensionsDir)) {
    for (const plugin of dirEntries(extensionsDir)) {
      if (!plugin.isDirectory()) continue;
      // 装过就应当有这条链（插件靠它拿到宿主内核）⇒ needed: true。
      out.push(probeOne(path.join(extensionsDir, plugin.name, ...MANAGED_NPM_LINK_SEGMENTS), deployedRoot, true));
    }
  } else {
    opts.notes?.push(`${EXTENSIONS_DIR_NAME}：目录不存在（没装过官方插件）`);
  }

  return out;
}

export interface LinkSelfCheckFailure {
  path: string;
  /** 我们本来想把它修成什么（修不成时也要留下这条线索）。 */
  target: string | null;
  reason: string;
}

export interface LinkSelfCheckResult {
  /** 探了多少条。 */
  checked: number;
  /** 真坏的条数（悬空 / 指到别处 / 被真目录或文件占了位置）。 */
  broken: number;
  /** 我们**修好**的条数。 */
  repaired: number;
  /** 试过要修、没修成的（**要能说出来**，以前只有一句 log.warn）。 */
  failures: LinkSelfCheckFailure[];
  /** 坏、但**不归我们动**的（指向别处的活链接 / 真目录 / 真文件）—— 只报告。 */
  stillBroken: Array<{ path: string; kind: StateLinkKind; target: string | null }>;
  notes: string[];
  /** 一句话人话摘要（日志/界面直接用）。 */
  summary: string;
}

/**
 * 自检 + 修。
 *
 * **修的范围（刻意窄）**：只修 `dangling`（是链接、且目标不存在）——
 *   ① 换根前缀（后缀逐字不动）；
 *   ② 换过去的目标**必须在盘上存在**，否则**一个字节都不改**，只报出来。
 * 其它三种坏法（`elsewhere` / `real-dir` / `real-file`）**绝不自动动**：
 * 前一种是网关自己会按字符串比较重建的（第十刀），后两种里面可能是真文件。
 *
 * **本函数不抛**（启动路径上抛出去 = 白屏）：任何 fs 异常都变成 `failures` / `notes`。
 */
export function runStateLinksSelfCheck(opts: { stateDir: string; deployedRoot: string }): LinkSelfCheckResult {
  const notes: string[] = [];
  const failures: LinkSelfCheckFailure[] = [];
  let findings: StateLinkFinding[] = [];
  try {
    findings = probeStateLinks({ stateDir: opts.stateDir, deployedRoot: opts.deployedRoot, notes });
  } catch (err) {
    notes.push(`探测时出错：${(err as Error).message}`);
  }

  const broken = findings.filter((f) => isBrokenStateLink(f.kind));
  const stillBroken = broken
    .filter((f) => f.kind !== 'dangling')
    .map((f) => ({ path: f.path, kind: f.kind, target: f.target }));

  let repaired = 0;
  for (const f of broken.filter((x) => x.kind === 'dangling')) {
    const oldTarget = f.target;
    if (!oldTarget) {
      failures.push({ path: f.path, target: null, reason: '读不出链接里存的目标串 ⇒ 无从换根' });
      continue;
    }
    const rewrite = rewriteLinkTarget(oldTarget, opts.deployedRoot);
    // ① 指向运行时的链：换根前缀（既有行为）。
    // ② 指向 state 目录的链（插件自带技能）：没有锚点，但常常**只差一个盘符** ⇒ 换盘符。
    // 两条路都必须过"换过去的目标真的存在"，否则一个字节都不改。
    const byVolume = rewrite.ok ? null : rewriteLinkVolumeForState(oldTarget, opts.stateDir);
    const nextTarget = rewrite.ok ? rewrite.target : byVolume;
    if (nextTarget === null) {
      failures.push({ path: f.path, target: oldTarget, reason: rewrite.ok ? '换盘符后的目标不可用' : rewrite.why });
      continue;
    }
    if (!fs.existsSync(nextTarget)) {
      failures.push({
        path: f.path,
        target: nextTarget,
        reason: `换根后的目标也不存在：${nextTarget} ⇒ 不猜（这份运行时/这块盘上可能没有它指的那个扩展/技能）`,
      });
      continue;
    }

    try {
      fs.unlinkSync(f.path);
    } catch (err) {
      failures.push({
        path: f.path,
        target: nextTarget,
        reason: `删不掉那条悬空链接：${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`,
      });
      continue;
    }
    try {
      fs.symlinkSync(nextTarget, f.path, DIRECTORY_LINK_TYPE);
      repaired += 1;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      // 回滚尝试：把原来那个串再挂回去（挂不上也如实报 —— 这一条是"最坏情况"的兜底）
      let rollback = '';
      try {
        fs.symlinkSync(oldTarget, f.path, DIRECTORY_LINK_TYPE);
        rollback = '（已把原来那条挂回去）';
      } catch {
        rollback = '（原来那条也挂不回去了 ⇒ 这条链会变成"还没建过"，网关下次启动会重建）';
      }
      failures.push({ path: f.path, target: nextTarget, reason: `重建链接失败：${code}${rollback}` });
    }
  }

  const summary =
    `坏链自检：探了 ${findings.length} 条，坏的 ${broken.length} 条，` +
    `修好 ${repaired} 条` +
    (failures.length ? `，修不了 ${failures.length} 条（原因见日志）` : '') +
    (stillBroken.length ? `，不归我们动的 ${stillBroken.length} 条（指向别处的活链/真目录）` : '');

  return { checked: findings.length, broken: broken.length, repaired, failures, stillBroken, notes, summary };
}
