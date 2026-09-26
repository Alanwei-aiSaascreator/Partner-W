/**
 * 「我们自己的技能」的**读写逻辑**（T-a2）。
 *
 * 这一层刻意不碰 electron、不碰网关：根目录由调用方给 ⇒ 能用临时目录真跑
 * 「装一次、再装一次、卸掉、路径逃逸」这些路径（见 `test/our-skills-bundled.test.ts`）。
 * IPC 那一层（`handlers.ts`）只是把网关报的目录喂进来。
 *
 * ## 安装目标为什么是 `managedSkillsDir`
 *
 * 网关的 `skills.status` 会同时报 `workspaceDir/skills`（**每个 agent 一份**）
 * 与 `managedSkillsDir`（**所有 agent 共享**）。市场语义要的是"装一次人人可用"，
 * 所以装到 managed。⚠️ 路径**不自己拼**，一律用网关报的那个（实测 2026-09-20）。
 *
 * ## 为什么 frontmatter 解析要写在这里而不是测试里
 *
 * 之前测试里有一份自己的解析器 ⇒ 那是"夹具的解析器"跟"产品的解析器"各写一遍，
 * 一旦产品那份宽松了，两边会一起绿、而运行时照旧丢掉文件。现在只有一份，
 * 测试用的就是会跟着发布出去的那份。
 *
 * ⚠️ 它**只认我们自己写的形状**（单行 `key: value`），比 YAML 规范严得多：
 *    多行/块标量一律判无效。这不是能力缺失，是刻意的 —— 我们**写**的时候只用这一种形状，
 *    于是"解析器跟运行时会不会有分歧"这个问题根本不成立。
 *    真正的权威仍是运行时自己的加载器：dev 实机装一次、查 `skills.status` 才算数。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface BundledSkill {
  slug: string;
  /** ⚠️ `undefined` 表示**这份文件格式不对**（不是"还没加载"）。由内容闸判红。 */
  name?: string;
  description?: string;
  emoji?: string;
  /** 网关侧用的稳定键（`metadata.openclaw.skillKey`）。契约：**必须等于 slug**。 */
  skillKey?: string;
  /**
   * SKILL.md 的**原文**（读不出来时是 `undefined`）。
   *
   * 加它只有一个用途：**比对已装内容是否陈旧**（见 `staleBundledSkills`）。
   * 读那份文件本来就要读全文去解析 frontmatter，多留一个字段是白拿。
   */
  content?: string;
}

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  emoji?: string;
  skillKey?: string;
}

/**
 * slug 白名单：**纯 ascii 小写 + 数字 + 单个连字符分隔**。
 *
 * 这是防路径逃逸的**第一道**（第二道在 `resolveInstallDir`）。
 * 白名单而不是黑名单：黑名单永远漏（`..\\`、UNC、`%2e%2e`、大小写变体、NTFS 的
 * 尾随点与空格……）。而这个集合天然覆盖我们要发的所有技能名。
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSafeSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

/** 剥 UTF-8 BOM（运行时的 frontmatter 解析器也剥）。 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 去掉成对包裹的引号；块标量标记（`|` / `>` 及其修饰）一律视为无效。 */
function readScalar(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (/^[|>][+-]?\d*$/.test(value)) return undefined;
  const quoted = value
    .replace(/^"(.*)"$/s, '$1')
    .replace(/^'(.*)'$/s, '$1')
    .trim();
  return quoted || undefined;
}

function readKey(frontmatter: string, key: string): string | undefined {
  const line = frontmatter.split('\n').find((l) => l.startsWith(`${key}:`));
  return line ? readScalar(line.slice(key.length + 1)) : undefined;
}

/**
 * 解析我们自己的 SKILL.md 的 frontmatter。
 *
 * `null` = 这份文件**根本不是我们认的形状**（没起手 `---`、没闭合、用了块标量）——
 * 与"字段缺了"是两回事，调用方要分开处理。
 */
export function parseOurSkillFrontmatter(text: string): ParsedFrontmatter | null {
  const normalized = stripBom(text).replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const close = normalized.indexOf('\n---', 3);
  if (close === -1) return null;
  const frontmatter = normalized.slice(4, close + 1);

  // 块标量检测：`description: |` 这种在多行里读出来是 `|`，靠逐个 key 判不准 ——
  // 直接扫一遍有没有以 `|`/`>` 开头的值行，有就整份判无效（我们不用那种形状）。
  for (const line of frontmatter.split('\n')) {
    const m = /^[A-Za-z_][\w-]*:\s*([|>][+-]?\d*)\s*$/.exec(line);
    if (m) return null;
  }

  return {
    name: readKey(frontmatter, 'name'),
    description: readKey(frontmatter, 'description'),
    emoji: readMetaString(frontmatter, 'emoji'),
    skillKey: readMetaString(frontmatter, 'skillKey'),
  };
}

/**
 * 从 frontmatter 里取 `metadata.openclaw.<key>` 的字符串值。
 *
 * 只认两种真实存在的形状：prettier 会把 metadata 压成**单行 flow 映射**
 * （`metadata: { 'openclaw': { 'emoji': '📝' } }`），人写的时候常写成多行嵌套。
 * 两种都能被同一个正则覆盖（它们的引号位置一样）；取不到就返回 undefined
 *（emoji 是可选的；skillKey 缺失由内容闸判红）。
 */
function readMetaString(frontmatter: string, key: string): string | undefined {
  const pattern = new RegExp(`["']${key}["']\\s*:\\s*["']([^"']*)["']`);
  return pattern.exec(frontmatter)?.[1] || undefined;
}

/**
 * 读随包技能目录。
 *
 * ⚠️ 缺 `name`/`description` 的技能**照读出来**（字段为 `undefined`），不悄悄过滤掉 ——
 *    过滤会让"格式写错了"表现成"这个技能我没写"，作者永远发现不了。
 *    判红是内容闸（`test/our-skills-packaging-gate.test.ts`）的事。
 * ✅ 根目录不存在时回空数组而不是抛：打包漏了应该让界面显示"没有技能"，
 *    而不是让整个技能页崩掉。
 */
export function readBundledSkills(root: string | undefined): BundledSkill[] {
  if (!root) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && isSafeSlug(e.name))
    .map((e) => {
      const file = path.join(root, e.name, 'SKILL.md');
      let parsed: ParsedFrontmatter | null = null;
      let content: string | undefined;
      try {
        content = fs.readFileSync(file, 'utf-8');
        parsed = parseOurSkillFrontmatter(content);
      } catch {
        /* 没有 SKILL.md / 读不动 —— 字段留空，交给内容闸报 */
      }
      return {
        slug: e.name,
        name: parsed?.name,
        description: parsed?.description,
        emoji: parsed?.emoji,
        skillKey: parsed?.skillKey,
        content,
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * `target` 是不是**正好落在 `baseDir` 里（且恰好下一层）**。
 *
 * ⚠️ 这是**第二道**防线，而且刻意做成独立可测的纯函数 ——
 *    因为它其实**够不着**：能走到这里的 slug 都先过了 `isSafeSlug`，
 *    而 `isSafeSlug` 已经不允许 `..`、分隔符这些。
 *    放在这里的理由只有一个：**将来谁放宽了第一道，这一道还在**。
 *    既然够不着，就没法通过公开入口去测它 —— 所以单独导出，直接喂对抗性输入。
 */
export function isContainedPath(baseDir: string, target: string): boolean {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(target);
  if (resolved === base) return false;
  const rel = path.relative(base, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return !rel.includes(path.sep) && !rel.includes('/');
}

/**
 * 算出安装目录，**并且保证它真的落在 `managedDir` 里**。
 *
 * 两道：先 `isSafeSlug`（白名单），再 `isContainedPath`（拼完到底落在哪）。
 */
export function resolveInstallDir(managedDir: string, slug: unknown): string | null {
  if (!managedDir || !isSafeSlug(slug)) return null;
  const target = path.join(managedDir, slug);
  return isContainedPath(managedDir, target) ? path.resolve(target) : null;
}

export function isBundledSkillInstalled(managedDir: string | undefined, slug: unknown): boolean {
  if (!managedDir) return false;
  const dir = resolveInstallDir(managedDir, slug);
  return dir ? fs.existsSync(path.join(dir, 'SKILL.md')) : false;
}

/**
 * 挑出**还没装**的随包技能（纯函数：判据由调用方传进来，便于测试）。
 *
 * 用于开机自装（2026-09-24）：随包技能原来**只在用户点「安装」时**才进 managed 目录，
 * 于是"随包内置"对新盘等于没发生 —— 助手看不到技能就用不上
 * （例如「文档生成（PPT / Word / Excel）」：看不到它，助手只会说"只能给文字稿"）。
 *
 * ⚠️ 语义刻意是"**缺了就补**"，不是"每次覆盖"：
 *   · 已经装了的**不动**；
 *   · 我们的 SKILL.md 更新了怎么办，是**另一个决定**（不该在这里顺手做，
 *     否则一次升级会静默覆盖别人盘上的一切）。
 */
export function missingBundledSkills(
  skills: readonly BundledSkill[],
  isInstalled: (slug: string) => boolean,
): BundledSkill[] {
  return skills.filter((skill) => !isInstalled(skill.slug));
}

/**
 * 行尾归一：CRLF 与 LF 是**同一份内容**。
 *
 * ⚠️ 不加这一条，本仓库在 Windows 上会**常态化误报"陈旧"**（git 的 autocrlf
 * 把工作区文件写成 CRLF，而随包的那份可能是 LF）—— 一次误报 = 一次多余的覆盖写。
 */
function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

/**
 * 读**已装**的那份 SKILL.md 原文；没装（或读不动）回 `null`。
 *
 * ⚠️ `null` 的语义是"**不是陈旧，是缺失**" —— 缺失那条路归 `missingBundledSkills` 管。
 *    两条路刻意分开：混在一起的话，"没装"会被当成"旧了"，而两种动作的边界
 *    （要不要覆盖用户盘上的东西）本来就不一样。
 */
export function readInstalledSkillContent(managedDir: string | undefined, slug: string): string | null {
  if (!managedDir) return null;
  const dir = resolveInstallDir(managedDir, slug);
  if (!dir) return null;
  try {
    return fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 内容的指纹（行尾归一之后算）——**"我们上次装下去的是哪一份"**。
 *
 * 用它是为了把两件长得很像、后果却相反的事分开：
 *   · **我们自己把它放旧了**（随包更新了，盘上还是上一版）⇒ 该升级；
 *   · **别人改过它**（用户或运行时动过）⇒ 一个字节都不许碰。
 * 只比内容分不出这两者，所以必须记一笔"上次装的是哪一份"。
 */
export function skillContentSha(content: string): string {
  return createHash('sha256').update(normalizeLineEndings(content)).digest('hex');
}

/**
 * 挑出**该升级**的那些（纯函数）。
 *
 * ⚠️ 这是"我们的 SKILL.md 更新了怎么办"那个**另一个决定**（`missingBundledSkills`
 *    的注释里点名的那个）。2026-09-26 真机：老盘升级后助手照旧按旧契约说
 *    "PDF 做不到" —— 因为随包技能在磁盘这一层从来没被升级过（只有"缺了才补"）。
 *
 * ⚠️ 它的后果是**覆盖用户 managed 目录里那一份**，所以判据必须三条全中：
 *    ① 已装（没装是 `missingBundledSkills` 的事）；
 *    ② **盘上那份正是我们上次装下去的那份**（指纹对得上）—— 对不上说明有人改过，
 *       **不碰**。这条是本函数存在的全部理由：只比内容的话，"用户改过"会被
 *       当成"我们放旧了"，于是每次开机都把他的修改冲掉；
 *    ③ 随包那份与装下去那份**不同**（真的更新了）。
 *    三条缺一 ⇒ 不动。
 *
 * ⚠️ **没有记账**（老盘第一次跑这一版）时按**不动**处理 —— 保守方向。
 *    宁可这次不升级，也不能拿不准就覆盖。
 */
export function staleBundledSkills(
  skills: readonly BundledSkill[],
  readInstalled: (slug: string) => string | null,
  readRecordedSha: (slug: string) => string | null,
): BundledSkill[] {
  return skills.filter((skill) => {
    if (typeof skill.content !== 'string') return false;
    const installed = readInstalled(skill.slug);
    if (installed === null) return false;
    const recorded = readRecordedSha(skill.slug);
    if (recorded === null) return false;
    // ② 盘上那份已经不是我们装的了 ⇒ 有人改过，不碰
    if (skillContentSha(installed) !== recorded) return false;
    // ③ 随包那份和装下去那份一样 ⇒ 没什么可升的
    return skillContentSha(skill.content) !== recorded;
  });
}

export interface InstallResult {
  ok: boolean;
  error?: string;
}

/** 把 `<root>/<slug>` 整个目录拷进 `managedDir`。幂等：已存在则覆盖。 */
export function installBundledSkill(opts: {
  root: string | undefined;
  managedDir: string | undefined;
  slug: unknown;
}): InstallResult {
  if (!opts.managedDir) return { ok: false, error: '网关没有报出技能目录（managedSkillsDir）' };
  if (!isSafeSlug(opts.slug)) return { ok: false, error: `技能标识非法：${String(opts.slug)}` };
  const slug = opts.slug;

  const source = opts.root ? path.join(opts.root, slug) : undefined;
  if (!source || !fs.existsSync(path.join(source, 'SKILL.md'))) {
    return { ok: false, error: `随包目录里没有这个技能：${slug}` };
  }
  const target = resolveInstallDir(opts.managedDir, slug);
  if (!target) return { ok: false, error: `技能标识非法：${slug}` };

  try {
    fs.mkdirSync(opts.managedDir, { recursive: true });
    // 覆盖语义：先删旧的再拷，避免源里删掉的文件残留在目标里。
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, { recursive: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
  }
}

/** 删掉 `managedDir` 下的那个技能目录。幂等：不存在也算成功。 */
export function removeBundledSkill(opts: { managedDir: string | undefined; slug: unknown }): InstallResult {
  if (!opts.managedDir) return { ok: false, error: '网关没有报出技能目录（managedSkillsDir）' };
  if (!isSafeSlug(opts.slug)) return { ok: false, error: `技能标识非法：${String(opts.slug)}` };
  const target = resolveInstallDir(opts.managedDir, opts.slug);
  if (!target) return { ok: false, error: `技能标识非法：${opts.slug}` };

  try {
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
  }
}
