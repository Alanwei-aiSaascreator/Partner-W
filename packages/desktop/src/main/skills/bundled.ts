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
 *
 * ## 记账与升级（H1，2026-10-09）
 *
 * 装/升的账 = `ManagedSkillRecordV2`（`pkg2:` + JSON）：**随包版本 + 逐文件的装后 sha**。
 * 计划（`planSkillSync` / `planOwnedUpdate`）只在**已证明来源**的基线上算差分；
 * 应用（`applyOwnedSkillUpdate`）先备份核验再写删、失败回滚。未知来源（旧账/无账）
 * 一律保守：能认领就认领（`adopt`），认不领就落**具名冲突**，绝不让"SKILL.md 一致"
 * 去认证辅助文件（旧口径 `staleBundledSkills` 的整目录覆盖正是 H1 要修的缺陷）。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function controlledContent(slug: string, content: string): string {
  if (process.env.ROYIN_NATIVE_PPT_VALIDATION !== '1' || !parseOurSkillFrontmatter(content)) return content;
  const normalized = stripBom(content).replace(/\r\n/g, '\n');
  const close = normalized.indexOf('\n---', 3);
  const header = normalized.slice(0, close);
  let body = normalized.slice(close + 4);
  let description: string;
  if (slug === 'presentation-deck-v2') {
    // ⭐ 2026-10-03 版本对齐：受控环境**只教一个契约** = 固定槽位 templateDeck（16 版式，
    //    唯一真源 TEMPLATE-DECK.md / TEMPLATE-DECK-SLOTS.json）。原先这里讲的是
    //    business-deck-v5（四页型试运行）——而实际出片与认可成品走的都是 templateDeck
    //    槽位引擎（收据 sourceFormat 可对），模型被教 v5、验收要 16 版式，两套口径打架。
    // ⭐ P0-A（2026-10-08 pre19，用户指令）：契约拆两层——
    //    A) Machine Contract = TEMPLATE-DECK-SLOTS.json（84KB，渲染器/校验器读，模型不读）；
    //    B) Model Quick Reference = 正文里的版式索引 + 每版式一个 `layouts/layout-NN.md`
    //       （由 SLOTS.json 程序生成，每个只几十行 = read 单窗内；一致性由
    //       test/our-skills-bundled.test.ts「P0-A 两层契约」钉住）。
    //    真机实证：read 工具单窗 = 2000 行（内核 DEFAULT_MAX_LINES=2e3，offset 为行偏移）；
    //    run6b 模型读 SLOTS.json 3 次都只拿首窗（4/5/6 的定义本就在首窗内，但模型侧
    //    计数仍错且未用 offset 续读其余版式）→ 41 次写入从未同时满足计数。
    //    证据：V1-CLOSEOUT-LEDGER-20261008.md「PPT 失败机制剖析」。
    description =
      'Controlled fixed slot PPT generation and revisions. For every selected layout read only its layouts/layout-NN.md in this skill directory. Never read TEMPLATE-DECK-SLOTS.json (84KB machine contract).';
    body =
      '\n\n# Controlled fixed slot PPT contract (templateDeck-v2)\n\n' +
      'Write one file ending .native-ppt.json:\n\n' +
      '```json\n{\n  "kind": "pptx",\n  "template": "templateDeck",\n  "title": "User requested title",\n  "content": {\n    "1": ["Each ordered slot receives one string"],\n    "4": ["标题", "导语", "1", "卡片标题", "卡片正文", "2", "卡片标题", "卡片正文", "3", "卡片标题", "卡片正文", "底部结论"]\n  }\n}\n```\n\n' +
      'Choose a nonempty subset of the 16 existing layouts using content keys 1 through 16, naturally ordered once. ' +
      'Only replace text and chart data; never author geometry, fonts, CSS or layouts.\n\n' +
      'Layout index（只读你选中版式的 layouts/layout-NN.md；禁止读 TEMPLATE-DECK-SLOTS.json）：\n\n' +
      '1 封面(4)｜2 目录(17)｜3 章节过渡(3)｜4 三段并列(12)｜5 四段并列(14)｜6 两列对比(21)｜' +
      '7 三列对比(22)｜8 三步递进(10)｜9 时间线(18)｜10 柱状数据(8+chart)｜11 折线趋势(8+chart)｜' +
      '12 KPI看板(20)｜13 原生表格(26)｜14 层级结构(10)｜15 编号清单(14)｜16 结尾页(4)\n\n' +
      'For each selected layout read ONLY its layouts/layout-NN.md（槽位顺序与角色、每槽 max chars/chars per line/max lines/字号、溢出行为、禁止项、完整示例；每个文件只几十行，一次 read 读完）。' +
      ' Do not read TEMPLATE-DECK-SLOTS.json：84KB 机器契约，渲染器与校验器读它，模型不读。TEMPLATE-DECK.md 是总览（按需）。\n\n' +
      'Hard rules：\n' +
      '① 每个选中版式的**全部槽位非空**，空串 "" 直接判失败；没有可选槽位；\n' +
      '② **目录恒为 17 项 = 页面标题 + 8×(目录序号、目录项)**——大纲不足 8 条时扩写成 8 条真实条目，**禁止用空串凑数**；\n' +
      '③ 写完源文件后**必须运行 deck-layout helper 且渲染成功**才可收尾——只写文件不渲染 = 未完成；诊断报 `slot-content-count … expected N`（含角色清单）/"nonempty string required" 时，**按 layouts/layout-NN.md 补数量/补真实内容**，不要加空行凑数；\n' +
      '④ 图表版式 10/11 只在有来源的数字数据时选用；文本槽位与图表数据都要填满。\n\n' +
      'Use the installed deck-layout helper, retain the final receipt, and use --previous for user revisions. ' +
      'The final reply must use the exact generated filename and path from that receipt, including its hash suffix. ' +
      'Missing evidence or capacity failure must be reported; do not invent data to fill charts or omit required text. ' +
      'The managed executor verifies, reviews and registers the final version. Never claim completion from text alone.\n';
  } else if (slug === 'deck-layout') {
    description =
      'Controlled native PPT render helper. PPT content and revisions use presentation-deck-v2; this helper renders its .native-ppt.json source. Free JSX/CSS layouts are unavailable inside controlled A validation.';
    body =
      '\n\n# Controlled native PPT render helper\n\n' +
      // ⭐ 2026-10-08 真机实证：网关不替换 {baseDir} 占位（安装盘上仍是字面量），
      //    run6b 模型拿着占位符在 runtime node_modules 里瞎找 helper 路径浪费一整轮。
      //    改成自定位指引：helper 与本 SKILL.md 同目录。
      'PPT content and revisions use the presentation-deck-v2 skill (its SKILL.md and TEMPLATE-DECK.md overview). ' +
      'This helper renders its .native-ppt.json source with the trusted bundled Node executable.\n\n' +
      "The helper script is scripts/generate.cjs inside THIS skill's directory（与本 SKILL.md 同目录）。" +
      " First resolve this directory's absolute path (list the skills directory or read this file's path), then run:\n\n" +
      '```text\nnode "<this-skill-dir>/scripts/generate.cjs" "report.native-ppt.json"\n' +
      'node "<this-skill-dir>/scripts/generate.cjs" "report.native-ppt.json" --previous "verified.receipt.json"\n```\n\n' +
      'Poll the available process tool if exec is still running. Keep the final JSON receipt. ' +
      'Use the exact generated filename and path from the receipt in the final reply, including its hash suffix. ' +
      'The managed product executor verifies the output, checks the final version, registers it and ends the task. ' +
      'Do not duplicate export in chat, invoke absent tools or announce completion from text alone. ' +
      'Native font sizes use points; CSS uses pixels (24px = 18pt) only on the separate legacy route.\n';
  } else if (slug === 'document-deck') {
    description =
      'Generate Word, Excel and PDF documents using the existing document contract. All PPT tasks in controlled validation use presentation-deck-v2 and the deck-layout native helper.';
    body = body
      .replace(
        /### 1\.[\s\S]*?(?=### 2\.)/,
        '### PPT\n\nUse presentation-deck-v2 and its .native-ppt.json contract for this controlled test.\n\n',
      )
      .replace(/### \u6f14\u793a\u6587\u7a3f\n[\s\S]*?(?=### Word)/, '')
      .replace('.pptx / .docx / .xlsx / .pdf', '.docx / .xlsx / .pdf')
      .replace(/^.*`kind`.*`"pptx"`.*$/m, '- `kind` is docx, xlsx or pdf here. PPT uses presentation-deck-v2 only.')
      .replace(/^.*\u666e\u901a\u8981\u70b9\u7248\u6b63\u6587.*\n.*\u6a21\u677f\u5b57\u6bb5.*$/m, '')
      .replaceAll('PPT / Word / Excel', 'Word / Excel')
      .replace(
        /\u4e00(?:\u4efd|\u9875)\s*PPT\s*\+\s*\u4e00\u4efd(?:\u8bb2\u7a3f\s*)?Word/iu,
        'a Word document and an Excel sheet',
      );
  } else return content;
  return header.replace(/^description:.*$/m, `description: '${description}'`) + '\n---' + body;
}

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
  /**
   * 技能包**整目录**清单指纹（`skillDirManifestSha(root/<slug>)`；读不出来时 `undefined`）。
   *
   * ⭐ BUG-052（2026-10-09）：升级判据从"只看 SKILL.md"扩到整个目录 —— scripts/、
   * layouts/ 这些辅助文件更新同样要能触发升级（真机后果：旧盘永远跑旧版）。
   */
  packageSha?: string;
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
        content = controlledContent(e.name, fs.readFileSync(file, 'utf-8'));
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
        // 整目录清单（BUG-052）：升级判据要能看见 SKILL.md 之外的更新。
        packageSha: skillDirManifestSha(path.join(root, e.name)) ?? undefined,
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
 * 目录下**每个文件**的相对路径（posix、排序）；读不动 ⇒ `null`。
 *
 * 「厂商清单」就是它：升级计划只碰这些路径 —— 运行时独有文件（deck-layout 的
 * `generate-runtime.json`）不在随包目录里，天然不进计划。
 */
export function skillDirFilePaths(dir: string): string[] | null {
  try {
    const files: string[] = [];
    const walk = (relative: string): void => {
      const absolute = relative ? path.join(dir, relative) : dir;
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(rel);
        else if (entry.isFile()) files.push(rel);
      }
    };
    walk('');
    files.sort();
    return files;
  } catch {
    return null;
  }
}

/**
 * 技能包**整目录**清单指纹（BUG-052；与旧 `pkg1:` 口径同一个算法）。
 *
 * 用途只剩一个：**随包版本的身份**（"这一包和上次装下去的那一包是不是同一版"）。
 * 内容层面的账（哪些文件、各自什么 sha）改由 `ManagedSkillRecordV2` 逐文件承载 ——
 * 只记一个目录指纹时，"哪些文件是我们的、哪些是用户加的"分不出来，升级只能在
 * "整目录覆盖"与"永远不升"之间二选一（就是 H1 要修的那个缺陷）。
 *
 * 读目录失败 ⇒ `null`（调用方按"核验不了"保守处理）。
 */
export function skillDirManifestSha(dir: string): string | null {
  const files = skillDirFilePaths(dir);
  if (!files) return null;
  try {
    const hash = createHash('sha256');
    hash.update('pkg1\n');
    for (const rel of files) {
      hash.update(rel);
      hash.update('\u0000');
      hash.update(
        createHash('sha256')
          .update(fs.readFileSync(path.join(dir, rel)))
          .digest('hex'),
      );
      hash.update('\n');
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

// ——————————————————————————————————————————————————————————————————————————
// 记账（H1）：**版本化来源记录** + 升级计划
//
// 旧口径只有一条 sha（裸 sha 或 `pkg1:<目录清单>.<SKILL.md 指纹>`）：它能回答
// "SKILL.md 被改过没有"，回答不了"**辅助文件**（layouts/scripts）是谁的"。
// 于是自动升级只剩两个坏选择：整目录覆盖（用户改过的辅助文件被冲掉）或永远不升
// （旧盘永远跑旧版）。新口径把"装了哪些文件、各自什么 sha"逐条记下来，升级就能
// 在**已证明来源**的基线上做差分：只写该写的、只删该删的、碰用户的东西就停下。
// ——————————————————————————————————————————————————————————————————————————

/** 记账值的新口径前缀：`pkg2:<JSON>`；`pkg1:`/裸 sha = 旧口径（见 readSkillRecordBaseline）。 */
export const SKILL_RECORD_V2_PREFIX = 'pkg2:';

/** 旧口径（BUG-052 起）：`pkg1:<随包整目录清单 sha>.<装后 SKILL.md 指纹>`。只用来读旧盘。 */
const SKILL_RECORD_PACKAGE_PREFIX = 'pkg1:';

const HEX_SHA_RE = /^[0-9a-f]{64}$/;

/**
 * ⭐ H1：**装了哪些文件、装的是哪一版**（配置里那一格的值）。
 *
 * `packageSha` = 随包整目录清单（`BundledSkill.packageSha`）：判"随包变了没有"，
 * 只看随包侧，天然不受托管目录里运行时附加文件干扰。
 * `files` = 受管理相对路径 → **装后原始字节**的 sha256：判"盘上还是不是我们装下去的那份"，
 * 逐文件、可枚举 ⇒ 升级能算差分，用户改过的那个文件能被**点名**而不是被整目录覆盖。
 */
export interface ManagedSkillRecordV2 {
  version: 2;
  /** 实际安装的随包版本。 */
  packageSha: string;
  /** 受管理相对路径（posix）→ 装后 SHA256。 */
  files: Record<string, string>;
}

/**
 * 受管理相对路径的白名单（posix、每一段都是普通名字）。
 *
 * 拒绝：空段、`.`、`..`、反斜杠（Windows 分隔符）、冒号（盘符/ADS）、绝对路径、
 * 段首尾空格与段尾点（NTFS 会把它们吃掉 ⇒ 同一个文件两个名字）。
 * 记录是**盘上的配置文件**，可以被人手改 —— 这里一律按不可信输入校验。
 */
export function isSafeManagedRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 240) return false;
  if (value.includes('\\') || value.includes('\0') || value.includes(':')) return false;
  return value
    .split('/')
    .every(
      (segment) =>
        segment !== '' &&
        segment !== '.' &&
        segment !== '..' &&
        segment !== '__proto__' &&
        segment !== 'constructor' &&
        segment !== 'prototype' &&
        segment.trim() === segment &&
        !segment.endsWith('.'),
    );
}

export function encodeSkillRecord(record: ManagedSkillRecordV2): string {
  return `${SKILL_RECORD_V2_PREFIX}${JSON.stringify(record)}`;
}

/**
 * 解码一条 `pkg2:` 记账。**接受 unknown**（配置是盘上的 JSON，谁都能改）。
 * 字段、64 位 sha、相对路径全部校验通过才返回记录；任何一项不对 ⇒ `null`
 * （调用方按"没有可信记账"走保守路径 —— 绝不能拿半懂的值去动文件）。
 */
export function decodeSkillRecord(value: unknown): ManagedSkillRecordV2 | null {
  if (typeof value !== 'string' || !value.startsWith(SKILL_RECORD_V2_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(SKILL_RECORD_V2_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as { version?: unknown; packageSha?: unknown; files?: unknown };
  if (candidate.version !== 2 || typeof candidate.packageSha !== 'string' || !HEX_SHA_RE.test(candidate.packageSha))
    return null;
  if (typeof candidate.files !== 'object' || candidate.files === null || Array.isArray(candidate.files)) return null;
  const entries = Object.entries(candidate.files as Record<string, unknown>);
  // 一份技能不可能有这么多文件；超大账按"不认"处理（避免一份被改坏的配置把计划拖死）。
  if (entries.length > 4096) return null;
  const files: Record<string, string> = {};
  for (const [relativePath, sha] of entries) {
    if (!isSafeManagedRelativePath(relativePath) || typeof sha !== 'string' || !HEX_SHA_RE.test(sha)) return null;
    files[relativePath] = sha;
  }
  return { version: 2, packageSha: candidate.packageSha, files };
}

/**
 * 一条记账值的**保守解读**：v2 / 旧口径 / 认不出。
 *
 * ⚠️ 旧口径（裸 sha、`pkg1:`）**只能证明 SKILL.md** —— 它记不下辅助文件的清单，
 * 所以永远不能因为"SKILL.md 一致"就认定整个技能包是我们的（这正是要修的
 * "认领把旧辅助文件记成最新包"）。辅助文件的可信来源只有 v2 记账，或者
 * `confirmed-repair`（用户明确选择替换）之后重新记的账。
 */
export type SkillRecordBaseline =
  | { kind: 'v2'; record: ManagedSkillRecordV2 }
  | { kind: 'legacy'; skillSha: string }
  | { kind: 'none' };

export function readSkillRecordBaseline(value: unknown): SkillRecordBaseline {
  const decoded = decodeSkillRecord(value);
  if (decoded) return { kind: 'v2', record: decoded };
  if (typeof value !== 'string') return { kind: 'none' };
  if (HEX_SHA_RE.test(value)) return { kind: 'legacy', skillSha: value };
  if (value.startsWith(SKILL_RECORD_PACKAGE_PREFIX)) {
    const [packageSha, skillSha] = value.slice(SKILL_RECORD_PACKAGE_PREFIX.length).split('.');
    if (packageSha && skillSha && HEX_SHA_RE.test(packageSha) && HEX_SHA_RE.test(skillSha))
      return { kind: 'legacy', skillSha };
  }
  return { kind: 'none' };
}

export type SkillConflictReason = 'unverified-origin' | 'user-modified';

export type SkillUpdatePlan =
  | { kind: 'unchanged' }
  | { kind: 'adopt'; record: ManagedSkillRecordV2 }
  | { kind: 'update'; write: string[]; remove: string[] }
  | { kind: 'conflict'; paths: string[]; reason: SkillConflictReason };

/**
 * ⭐ H1 的差分计划：**已证明来源**的旧基线 → 新基线。
 *
 * 语义（每一条都有真机后果撑着）：
 *  · `changed` —— 基线里的文件在盘上不是基线那个 sha（被人改过、**或被删了**）
 *    ⇒ 冲突，整个计划作废（一个都不动）。删掉了也算偏离：自动流程不替用户"补回来"。
 *  · `collided` —— 新包新增的路径上**盘上已经有东西**（用户自己放的）⇒ 冲突。
 *  · `remove` —— 只在**基线里明确归我们**、且新包已经没有的路径上删。
 *    用户在技能目录里放的额外文件不在基线里 ⇒ 永远不会被删。
 *  · `readInstalledSha` 回 `null` 表示"**不存在**"；**读不动要抛** ——
 *    "读不了"被当成"没有"的话，一个读不动的用户文件会被规划成"可以安全写入"。
 *
 * ⚠️ 它只负责"已经证明来源"的那段（v2 基线）。未知来源（无账 / 只有旧口径）的处置
 *    在 `planSkillSync` 里：先认领、再落具名冲突，绝不拿这条函数去推断。
 */
export function planOwnedUpdate(
  previous: ManagedSkillRecordV2,
  nextFiles: Readonly<Record<string, string>>,
  readInstalledSha: (relativePath: string) => string | null,
): SkillUpdatePlan {
  const oldPaths = Object.keys(previous.files);
  const newPaths = Object.keys(nextFiles);

  const changed = oldPaths.filter((relativePath) => readInstalledSha(relativePath) !== previous.files[relativePath]);
  const collided = newPaths.filter(
    (relativePath) =>
      !Object.prototype.hasOwnProperty.call(previous.files, relativePath) && readInstalledSha(relativePath) !== null,
  );
  const conflicts = [...new Set([...changed, ...collided])];
  if (conflicts.length) return { kind: 'conflict', paths: conflicts, reason: 'user-modified' };

  return {
    kind: 'update',
    write: newPaths.filter((relativePath) => nextFiles[relativePath] !== previous.files[relativePath]),
    remove: oldPaths.filter((relativePath) => !Object.prototype.hasOwnProperty.call(nextFiles, relativePath)),
  };
}

/** 盘上那份技能的**已装视图**（计划函数的输入）。 */
export interface InstalledSkillView {
  /** SKILL.md 的**内容**指纹（行尾归一，与旧记账同一口径）；没有 SKILL.md ⇒ `null`。 */
  skillSha: string | null;
  /** 受管理文件指纹：不存在 ⇒ `null`；**读不动 ⇒ 抛**。 */
  fileSha: (relativePath: string) => string | null;
}

/**
 * ⭐ 一条技能该走哪条路（纯函数）：v2 基线走差分；旧账/无账先按"无账迁移四态"处置。
 *
 * 四态（用户拍板的合同）：
 *  ① **当前受管理文件与当前包可证一致** ⇒ `adopt`：只认领**真实装后基线**，
 *     一个字节都不写。允许用户额外文件存在，但不把它们认领成厂商文件。
 *  ② 与产品提供的**可信旧版厂商清单**可证一致 ⇒ 差分升级。
 *     ⚠️ 不落地：旧口径（裸 sha / `pkg1:`）只记下 SKILL.md 的指纹，**枚举不出文件清单**，
 *     随包侧也没有历史版本的副本 —— 没有可信来源就不能假装有（见报告）。
 *  ③ 未知来源 / 用户改过 ⇒ `conflict`，**保留内容**，返回**具名**冲突（谁、哪些路径）。
 *  ④ 用户明确选择替换 ⇒ `confirmed-repair` 出口（handlers 的显式安装，带备份与核验）。
 *
 * 旧口径的可信残留只有一条：SKILL.md 还是我们装下去的那份 ⇒ 把它当**单文件基线**
 * 做差分 —— 纯 SKILL.md 的技能因此还能正常升级并顺势迁移到 v2 记账；
 * 带辅助文件的技能会落到 ③（辅助文件无从核验 = `unverified-origin`），
 * 由 ④ 交用户明确选择。
 */
export function planSkillSync(input: {
  /** 随包整目录清单（`BundledSkill.packageSha`）。 */
  packageSha: string;
  /** 当前包 staging 后的受管理文件（相对路径 → sha）。 */
  nextFiles: Readonly<Record<string, string>>;
  /** 配置里那一格原始值（未知来源都必须吃得下）。 */
  recorded: unknown;
  installed: InstalledSkillView;
}): SkillUpdatePlan {
  const decoded = decodeSkillRecord(input.recorded);
  if (decoded && decoded.packageSha === input.packageSha) return { kind: 'unchanged' };
  if (decoded) return planOwnedUpdate(decoded, input.nextFiles, input.installed.fileSha);

  // ① 认领：盘上每个受管理文件都与**当前包**逐字一致 ⇒ 记下真实基线（不写盘）。
  const consistent = Object.keys(input.nextFiles).every(
    (relativePath) => input.installed.fileSha(relativePath) === input.nextFiles[relativePath],
  );
  if (consistent)
    return { kind: 'adopt', record: { version: 2, packageSha: input.packageSha, files: { ...input.nextFiles } } };

  const baseline = readSkillRecordBaseline(input.recorded);
  if (baseline.kind === 'legacy' && input.installed.skillSha !== null) {
    if (input.installed.skillSha === baseline.skillSha) {
      const plan = planOwnedUpdate(
        { version: 2, packageSha: '', files: { 'SKILL.md': baseline.skillSha } },
        input.nextFiles,
        (relativePath) =>
          // SKILL.md 走旧口径的**内容**指纹（行尾归一）；辅助文件没有旧基线，读原始字节。
          relativePath === 'SKILL.md' ? input.installed.skillSha : input.installed.fileSha(relativePath),
      );
      // 冲突只可能出在辅助文件上（SKILL.md 刚验过与旧账一致）：来源无从核验 ⇒ 具名 unverified-origin。
      return plan.kind === 'conflict' ? { kind: 'conflict', paths: plan.paths, reason: 'unverified-origin' } : plan;
    }
    return { kind: 'conflict', paths: ['SKILL.md'], reason: 'user-modified' };
  }

  const deviating = Object.keys(input.nextFiles).filter(
    (relativePath) => input.installed.fileSha(relativePath) !== input.nextFiles[relativePath],
  );
  return { kind: 'conflict', paths: deviating.length ? deviating : ['SKILL.md'], reason: 'unverified-origin' };
}

/**
 * ⭐ T31（缺口 3）：把**孤儿键**的技能账并回当前托管目录。
 *
 * 背景：账按网关报的 `managedSkillsDir`（= `<stateDir>/skills`）做键。换网关 / 换盘 /
 * 目录布局变过之后，旧键成了孤儿 ⇒ 新键下没有账 ⇒ 开机 ensure 把"我们自己装的旧版"
 * 判成 `unverified-origin`，在**健康盘**上冒一屏虚假冲突。
 *
 * 规则（保守到只做一件事）：
 *  · `managedDir` 那份账原样保留，**一个条目都不覆盖**。
 *  · 只有"键的目录**已经不在盘上**"（`pathExists` 为假）的旧键才被并进来 ——
 *    目录还在的键可能只是这次没连上的另一套 state，动它就是猜。
 *  · 同 slug 冲突时保留 `managedDir` 那份（它才是"这一版"的账）。
 *
 * 纯函数（`pathExists` 注入），不改盘；调用方决定要不要把结果落盘。
 */
export function adoptOrphanedSkillRecords(input: {
  records: Readonly<Record<string, Record<string, string>>>;
  /** 当前托管目录（网关报的 `managedSkillsDir`）。 */
  managedDir: string;
  /** 一个绝对路径在盘上存不存在（目录也算存在）。 */
  pathExists: (absolutePath: string) => boolean;
}): { records: Record<string, string>; migratedFrom: string[] } {
  const current = input.records[input.managedDir] ?? {};
  const merged: Record<string, string> = { ...current };
  const migratedFrom: string[] = [];
  for (const [key, value] of Object.entries(input.records)) {
    if (key === input.managedDir) continue;
    if (input.pathExists(key)) continue;
    migratedFrom.push(key);
    for (const [slug, record] of Object.entries(value)) {
      if (!Object.prototype.hasOwnProperty.call(merged, slug)) merged[slug] = record;
    }
  }
  return { records: merged, migratedFrom };
}

export interface InstallResult {
  ok: boolean;
  error?: string;
  /**
   * 保留下来的恢复备份位置（`royin-skill-backup-*` 目录）。
   *
   * 只有两种情形会出现：① 显式修复成功且按合同保留了恢复资产（E2）；② 失败回滚**没**验过
   * 逐字节恢复 ⇒ 备份是唯一可恢复的东西，必须留着并让调用方能把位置告诉用户。
   *
   * 目录布局（E2 命名空间）：`manifest.json` = 系统恢复清单（含 `payloadDir: 'files'` 与逐文件 sha）；
   * `files/` = 用户字节原样（人工恢复从这里拷回目标目录）。
   */
  backupDir?: string;
}

/**
 * 受管理路径的**逐段链接守卫**：`<dir>/<相对路径>` 的每一段（已存在的）都不许是链接。
 *
 * 为什么要它：Windows 的 junction/symlink 能让一个"看起来在技能目录里"的路径写到盘上别处，
 * 而记录里的路径是**不可信输入**（配置文件谁都能改），UPDATE 却是真的写/删文件。
 * `createParents` 时**逐段**建目录（不用 `mkdirSync(recursive)`：它不会替我们检查
 * 中间段是不是链接）。
 */
function managedAbsolutePath(dir: string, relativePath: string, createParents: boolean): string {
  if (!isSafeManagedRelativePath(relativePath)) throw new Error(`unsafe-relative-path: ${relativePath}`);
  const segments = relativePath.split('/');
  let current = dir;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    const isLast = index === segments.length - 1;
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      if (isLast || !createParents) return current;
      fs.mkdirSync(current);
      continue;
    }
    if (stat.isSymbolicLink()) throw new Error('skill-path-link-blocked');
    if (!isLast && !stat.isDirectory()) throw new Error('skill-path-not-directory');
  }
  return current;
}

/** 读/删用的绝对路径（不建目录）。 */
function managedFilePath(dir: string, relativePath: string): string {
  return managedAbsolutePath(dir, relativePath, false);
}

/** 写用的绝对路径（建缺失的父目录；任何一段是链接就拒绝）。 */
function ensureManagedFilePath(dir: string, relativePath: string): string {
  return managedAbsolutePath(dir, relativePath, true);
}

/**
 * 读 `dir` 下受管理文件（相对路径 posix）的**原始字节** sha256。
 *
 * ⚠️ 不存在回 `null` —— "没有"是合法状态（计划要靠它认"厂商新增的文件撞没撞用户文件"）；
 *    **读失败一律抛** —— "读不了"绝不能被当成"没有"，否则一个读不动的文件会被
 *    计划当成"可以安全写入"。
 */
export function readSkillFileSha(dir: string, relativePath: string): string | null {
  const absolute = managedFilePath(dir, relativePath);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return createHash('sha256').update(bytes).digest('hex');
}

/** 读一组受管理文件的指纹；**任一缺失 ⇒ `null`**（宁可不记账，也不记半截账）。读失败抛。 */
export function managedFileShas(dir: string, relativePaths: readonly string[]): Record<string, string> | null {
  const files: Record<string, string> = {};
  for (const relativePath of relativePaths) {
    const sha = readSkillFileSha(dir, relativePath);
    if (sha === null) return null;
    files[relativePath] = sha;
  }
  return files;
}

/** 删空目录（只删**空着的**父目录；里面还有东西就原样留着）。 */
function pruneEmptyParents(root: string, relativePath: string): void {
  const segments = relativePath.split('/');
  for (let length = segments.length - 1; length > 0; length -= 1) {
    const dir = path.join(root, ...segments.slice(0, length));
    try {
      if (fs.readdirSync(dir).length !== 0) return;
      fs.rmdirSync(dir);
    } catch {
      return;
    }
  }
}

/** 受控口径（`ROYIN_NATIVE_PPT_VALIDATION=1`）：三个技能装下去时改写 SKILL.md。 */
function applyControlledSkillContent(targetDir: string, slug: string): void {
  if (process.env.ROYIN_NATIVE_PPT_VALIDATION !== '1') return;
  if (!['presentation-deck-v2', 'deck-layout', 'document-deck'].includes(slug)) return;
  const file = path.join(targetDir, 'SKILL.md');
  fs.writeFileSync(file, controlledContent(slug, fs.readFileSync(file, 'utf8')));
}

export interface StagedSkillPackage {
  /** staging 根（`cleanup()` 删的就是它；**临时目录**，绝不指向用户盘上的技能目录）。 */
  root: string;
  /** 该技能在 staging 里的目录（与将要落盘的文件逐字节一致）。 */
  dir: string;
  /** 受管理文件：相对路径（posix）→ sha256。 */
  files: Record<string, string>;
  cleanup(): void;
}

/**
 * 把随包技能拷进**临时 staging**，并施加与安装同一套内容改写（受控口径）。
 *
 * 为什么非要 staging 而不能"拿随包原始文件当预期"：装下去的内容 ≠ 随包目录里的原始字节
 * （受控环境会改写 SKILL.md；将来还会有别的装后步骤）。升级计划必须拿**将要落盘的那份**
 * 算 shas，否则算出来的账第二天就把自己认成"被改过"。
 *
 * ⚠️ 运行时独有文件（deck-layout 的 `generate-runtime.json`）**不进** `files`：
 *    它们由 `configureSlidegenRuntime` 在**装到的目录**里生成，不属于厂商清单，
 *    也不该被下一次升级的删除清单碰到。
 */
export function stageBundledSkillPackage(opts: {
  root: string | undefined;
  slug: unknown;
}): { ok: true; staged: StagedSkillPackage } | { ok: false; error: string } {
  if (!opts.root) return { ok: false, error: '随包技能目录不可用' };
  if (!isSafeSlug(opts.slug)) return { ok: false, error: `技能标识非法：${String(opts.slug)}` };
  const slug = opts.slug;
  const source = path.join(opts.root, slug);
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) return { ok: false, error: `随包目录里没有这个技能：${slug}` };
  let root = '';
  try {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'royin-skill-stage-'));
    const dir = path.join(root, slug);
    fs.cpSync(source, dir, { recursive: true });
    applyControlledSkillContent(dir, slug);
    const paths = skillDirFilePaths(dir);
    const files = paths ? managedFileShas(dir, paths) : null;
    if (!files) throw new Error('staging-unreadable');
    const stagedRoot = root;
    return {
      ok: true,
      staged: { root: stagedRoot, dir, files, cleanup: () => fs.rmSync(stagedRoot, { recursive: true, force: true }) },
    };
  } catch (error) {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    return { ok: false, error: error instanceof Error ? error.message : 'staging-failed' };
  }
}

/**
 * 回滚：删掉本次**新建**的文件，把本次**覆盖**过的文件从备份拷回，并**逐字节核验**。
 *
 * ⚠️ E2 的两条纪律：
 *  ① "copy 没抛异常"**不是**恢复证明 —— 拷完必须与备份时刻的 sha 对上，对不上算恢复失败
 *     （只是"我们试过了"而已，盘上可能还是新内容）；
 *  ② 恢复走**原来的目录/链接安全守卫**（`ensureManagedFilePath` 逐段查链接）——
 *     回滚不能成为绕过守卫的那条路。
 *
 * ⚠️ E2 命名空间：`backupFilesRoot` 是**用户字节**的 payload 根（`<备份根>/files`），
 *    不是放系统恢复清单的元数据根 —— 用户技能自带同名文件（如 `manifest.json`）时，
 *    恢复只能从 payload 读，绝不许把元数据当用户文件拷回去。
 */
function restoreSkillFiles(
  target: string,
  backupFilesRoot: string,
  replaced: readonly string[],
  created: readonly string[],
  backupShas: Readonly<Record<string, string>>,
): string[] {
  const failures: string[] = [];
  for (const relativePath of created) {
    try {
      fs.rmSync(managedFilePath(target, relativePath), { force: true });
      pruneEmptyParents(target, relativePath);
      if (readSkillFileSha(target, relativePath) !== null) failures.push(relativePath);
    } catch {
      failures.push(relativePath);
    }
  }
  for (const relativePath of replaced) {
    try {
      const absolute = ensureManagedFilePath(target, relativePath);
      fs.copyFileSync(path.join(backupFilesRoot, ...relativePath.split('/')), absolute);
      if (readSkillFileSha(target, relativePath) !== backupShas[relativePath]) failures.push(relativePath);
    } catch {
      failures.push(relativePath);
    }
  }
  return failures;
}

/**
 * 备份一个受管理文件；不存在 ⇒ 记进"回滚时要删掉"的清单。读不动/链接段一律抛。
 *
 * ⚠️ `backupFilesRoot` = 用户字节的 payload 根（`<备份根>/files`），**不是**元数据根：
 *    两个命名空间分开后，用户自己的 `manifest.json` 才不会被系统恢复清单覆盖。
 */
function snapshotManagedFile(
  target: string,
  backupFilesRoot: string,
  relativePath: string,
  current: string | null,
  replaced: string[],
  created: string[],
  backupShas: Record<string, string>,
): void {
  if (current === null) {
    created.push(relativePath);
    return;
  }
  const backup = path.join(backupFilesRoot, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(managedFilePath(target, relativePath), backup);
  if (readSkillFileSha(backupFilesRoot, relativePath) !== current) throw new Error('skill-backup-mismatch');
  backupShas[relativePath] = current;
  replaced.push(relativePath);
}

export interface SkillUpdateApplication {
  /** staging 目录：`write` 里的文件都从这里拷（与将要落盘的内容逐字节一致）。 */
  stagedDir: string;
  managedDir: string;
  slug: string;
  /** 装后应有的**全部**受管理文件（相对路径 → sha）；核验阶段按它做全清单比对。 */
  files: Readonly<Record<string, string>>;
  /** 要写的相对路径。 */
  write: readonly string[];
  /** 要删的相对路径（必须是记账里"厂商已删"的那些）。 */
  remove: readonly string[];
  /**
   * 应用前必须仍然成立的盘上状态（**计划那一刻**读到的值；`null` = 当时不存在）。
   * 整体为 `null` = 用户已确认替换（confirmed-repair）：不核对基线，只做备份与核验。
   */
  baseline: Readonly<Record<string, string | null>> | null;
  /**
   * ⭐ H1/E1：装后**收尾**（runtime 配置 → 装后再次核验 → 写来源账）。
   *
   * 它属于**本事务**：跑在装后整清单核验之后、成功返回（备份释放）之前；**抛错 = 事务失败**，
   * 走同一个回滚出口 —— 文件、侧车快照、来源账必须一起回到应用之前的样子。
   * ⚠️ 回调里不许把失败吞成返回值（那就又回到"盘上是新字节、账还是旧的"的假冲突老路）。
   */
  finalize?: () => void;
  /**
   * 事务备份的父目录（缺省 = 系统临时目录）。
   * 显式修复要传**持久恢复目录**：系统会清理临时目录，而那条路上备份是用户的后悔药。
   */
  backupParentDir?: string;
  /** 成功后是否保留备份（只有显式修复 = true：用户明确换掉了自己的文件，恢复资产必须留下）。 */
  retainBackupOnSuccess?: boolean;
  /**
   * 额外纳入本次事务恢复快照的受管理文件（不在厂商清单里，如 deck-layout 的
   * `scripts/generate-runtime.json`）：本事务会覆盖它们，回滚时必须一起回退 ——
   * 否则会出现"文件旧了、runtime 侧车是新版"的半截现场。
   */
  snapshotPaths?: readonly string[];
  /** 完整快照（显式修复）：整个技能目录（含用户额外文件）都进备份，而不只是被写的那些。 */
  snapshotWholeDirectory?: boolean;
  /** 写进备份目录的清单（旧来源记录等）；随快照保留，人工恢复时对读现场用。 */
  snapshotManifest?: Record<string, unknown>;
  /** 清理临时资产失败时的诊断出口（**绝不**因为清理没成功把已完成的安装伪装成未完成事务）。 */
  diagnostic?: (message: string) => void;
}

/**
 * ⭐ H1 的差分写路径：**先整体定计划、备份涉及的每个文件并核验备份，再按 write/remove 差分应用**；
 * 任何一步失败（含收尾 `finalize` 失败）都把动过的文件恢复原状。
 *
 * 四条不许退让的性质：
 *  ① 没有基线就不动文件（`baseline: null` 只给"用户明确选择替换"的修复入口用）；
 *  ② 备份**核验过**才算备份成功 —— 没核验的备份等于没有备份；
 *  ③ 装后核验按**整份受管理清单**比 —— 只比"写过的那些"会让漏写/漏删悄悄过关；
 *  ④ 备份的生命周期对着**恢复证明**走（E2）：只有"成功"或"失败且恢复已逐字节核验"才清临时备份；
 *     恢复失败时备份必须留下并报出位置 —— 它是此刻唯一还能把用户的东西找回来的地方。
 */
export function applyOwnedSkillUpdate(input: SkillUpdateApplication): InstallResult {
  const target = resolveInstallDir(input.managedDir, input.slug);
  if (!target) return { ok: false, error: `技能标识非法：${String(input.slug)}` };
  const touched = [...new Set([...input.write, ...input.remove])];
  // 快照面 = 本次会动的文件 + 声明要一起恢复的侧车；显式修复时 = 整个技能目录（含用户额外文件）。
  // ⚠️ 三条不许退让（F2/F3 反例）：① `skillDirFilePaths` 返回 `null` = 核验失败（用户子目录
  //    读不动），**不许当空目录** —— 快照核不全就具名失败，替换前停手；② 目录枚举看不到
  //    "原先不存在"的**声明路径**（被删掉的 runtime 侧车），而修复会把它重建出来 ⇒
  //    必须并 `snapshotPaths`，回滚才能恢复"不存在"；③ 目标**不存在**（首次安装）不是失败 ——
  //    没有东西要备份，目录快照就是空；只有"存在但枚举失败"才是 ①。
  const directorySnapshot = input.snapshotWholeDirectory && fs.existsSync(target) ? skillDirFilePaths(target) : [];
  if (directorySnapshot === null) return { ok: false, error: 'skill-backup-snapshot-unreadable' };
  const snapshot = [...new Set([...touched, ...directorySnapshot, ...(input.snapshotPaths ?? [])])];
  const backupShas: Record<string, string> = {};
  const replaced: string[] = [];
  const created: string[] = [];
  /** 事务之前技能目录在不在：不在的话，回滚要把"新装出来的空壳"也收掉。 */
  const targetExisted = fs.existsSync(target);
  let backupRoot = '';
  /**
   * 用户字节的备份根（`<backupRoot>/files`）——与系统恢复元数据**分命名空间**（E2）：
   * 用户技能可以自带任何文件名（包括 `manifest.json`），系统清单不得覆盖用户的备份字节。
   * ⚠️ 声明在 `try` **外面**：失败回滚（catch）必须能用同一个 payload 根把用户字节读回来。
   */
  let backupFilesRoot = '';
  let keepBackup = input.retainBackupOnSuccess === true;
  try {
    const backupParent = input.backupParentDir ?? os.tmpdir();
    fs.mkdirSync(backupParent, { recursive: true });
    backupRoot = fs.mkdtempSync(path.join(backupParent, 'royin-skill-backup-'));
    // 用户字节进独立 payload 根；元数据（恢复清单）留在备份根顶部 —— 两者永不互相覆盖。
    backupFilesRoot = path.join(backupRoot, 'files');
    fs.mkdirSync(backupFilesRoot, { recursive: true });
    // ① 基线与备份：动文件之前，把每个涉及的受管理文件先看住。
    for (const relativePath of touched) {
      const current = readSkillFileSha(target, relativePath);
      if (input.baseline) {
        const planned = Object.prototype.hasOwnProperty.call(input.baseline, relativePath)
          ? (input.baseline[relativePath] ?? null)
          : null;
        // 计划之后又被人动过（TOCTOU）⇒ 停手：宁可不升，也不覆盖刚写进来的东西。
        if (planned !== current) throw new Error('skill-baseline-changed');
      }
      snapshotManagedFile(target, backupFilesRoot, relativePath, current, replaced, created, backupShas);
    }
    // 侧车快照：不在厂商清单里（没有"期望 sha"），只要求回滚时能拷回原样。
    for (const relativePath of snapshot) {
      if (touched.includes(relativePath)) continue;
      snapshotManagedFile(
        target,
        backupFilesRoot,
        relativePath,
        readSkillFileSha(target, relativePath),
        replaced,
        created,
        backupShas,
      );
    }
    // 恢复清单：备份目录要**自解释**（谁、什么时候、哪些文件、各自的指纹、事务前的账）。
    // ⚠️ 这份清单可能被留下（恢复失败时它是唯一可恢复资产的说明书），所以无条件写。
    // ⚠️ 字段顺序 = 调用方快照在前、权威字段在后：`snapshotManifest` 永远覆盖不了
    //    schemaVersion/payloadDir/slug/managedDir/createdAt/files 这些权威字段。
    const recoveryManifest = {
      ...input.snapshotManifest,
      schemaVersion: 1,
      /** 用户字节在备份目录里的**相对位置** —— 人工恢复照它找，不要再猜。 */
      payloadDir: 'files',
      slug: input.slug,
      managedDir: input.managedDir,
      createdAt: new Date().toISOString(),
      files: backupShas,
    };
    fs.writeFileSync(path.join(backupRoot, 'manifest.json'), `${JSON.stringify(recoveryManifest, null, 2)}\n`);
    // ⭐ E2：写清单之后、动目标之前，把**清单里记的每一个备份字节**复核一遍 ——
    // 清单说有什么、payload 根里就必须真有什么；对不上就停手（坏备份不许当恢复资产用）。
    for (const [relativePath, expectedSha] of Object.entries(backupShas)) {
      if (readSkillFileSha(backupFilesRoot, relativePath) !== expectedSha) {
        throw new Error('skill-backup-mismatch');
      }
    }
    // ② 差分应用（首装时技能目录本身还不存在 ⇒ 先建；`ensureManagedFilePath` 只负责往下一层建）。
    if (input.write.length) fs.mkdirSync(target, { recursive: true });
    for (const relativePath of input.write) {
      fs.copyFileSync(
        path.join(input.stagedDir, ...relativePath.split('/')),
        ensureManagedFilePath(target, relativePath),
      );
    }
    for (const relativePath of input.remove) {
      fs.rmSync(managedFilePath(target, relativePath), { force: true });
      pruneEmptyParents(target, relativePath);
    }
    // ③ 装后核验：整份受管理清单都要在盘上逐字到位。
    for (const [relativePath, sha] of Object.entries(input.files)) {
      if (readSkillFileSha(target, relativePath) !== sha) throw new Error('skill-install-verify-failed');
    }
    // ④ 收尾（runtime → 记账）：与上面任何一步同权 —— 抛错就整批回滚。
    input.finalize?.();
    return keepBackup ? { ok: true, backupDir: backupRoot } : { ok: true };
  } catch (error) {
    const failures = restoreSkillFiles(target, backupFilesRoot, replaced, created, backupShas);
    // 首装失败的回滚要把刚建出来的空壳目录也收掉（只删**空的**；里面有东西就留着）。
    if (!targetExisted) {
      try {
        if (fs.existsSync(target) && fs.readdirSync(target).length === 0) fs.rmdirSync(target);
      } catch {
        /* 收不掉就算了：空目录不影响任何判据（SKILL.md 才是"装没装"的判据） */
      }
    }
    const message = error instanceof Error ? error.message : 'skill-update-failed';
    if (failures.length) {
      // ⚠️ E2：恢复没验过 ⇒ 备份是**唯一**还能把旧内容找回来的资产，绝不能删（旧实现在 finally 里无条件 rm）。
      keepBackup = true;
      return {
        ok: false,
        error: `${message}; restore-failed:${failures.join(',')}; 恢复备份已保留：${backupRoot}`,
        backupDir: backupRoot,
      };
    }
    return { ok: false, error: message };
  } finally {
    // ⚠️ E1.5：清理失败**只**记诊断 —— 绝不把已经完成的事务伪装成未完成。
    if (backupRoot && !keepBackup) {
      try {
        fs.rmSync(backupRoot, { recursive: true, force: true });
      } catch (error) {
        input.diagnostic?.(
          `backup-cleanup-failed: ${backupRoot}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

/** 事务选项：显式安装 / 自装升级 / 显式修复三条路共用同一套（语义见 `SkillUpdateApplication`）。 */
export type SkillUpdateTransactionOptions = Pick<
  SkillUpdateApplication,
  | 'finalize'
  | 'backupParentDir'
  | 'retainBackupOnSuccess'
  | 'snapshotPaths'
  | 'snapshotWholeDirectory'
  | 'snapshotManifest'
  | 'diagnostic'
>;

/**
 * 把 `<root>/<slug>` 整个技能包装进 `managedDir`（显式安装与"缺了补装"共用）。
 *
 * ⚠️ 语义（H1 起）：**只写不删** —— 逐文件覆盖写，绝不 `rmSync(目标目录)`。
 *    目标里不在厂商清单的文件（用户自己放的）原样保留；"厂商删掉的文件"归
 *    差分升级的删除清单管（`planOwnedUpdate` 的 remove），而且要有记账撑腰。
 *
 * ⭐ H1/E1：整包装也走**同一事务**（备份 → 写 → 整清单核验 → `finalize` → 失败整批回滚）。
 *    旧实现是"逐文件覆盖写 + 核验"，失败时把**刚写下去的残骸留在盘上**；
 *    紧接着 runtime/记账再失败，就成了"文件已是新版、来源账还没有"的半截现场 ——
 *    下一次 ensure 会把自己的写入判成 `user-modified` 假冲突（E1 实证）。
 */
export function installBundledSkill(opts: {
  root: string | undefined;
  managedDir: string | undefined;
  slug: unknown;
  /** 事务选项（显式安装传 finalize：runtime → 记账；语义与 `applyOwnedSkillUpdate` 同一套）。 */
  transaction?: SkillUpdateTransactionOptions;
}): InstallResult {
  if (!opts.managedDir) return { ok: false, error: '网关没有报出技能目录（managedSkillsDir）' };
  if (!isSafeSlug(opts.slug)) return { ok: false, error: `技能标识非法：${String(opts.slug)}` };
  const staged = stageBundledSkillPackage({ root: opts.root, slug: opts.slug });
  if (!staged.ok) return { ok: false, error: staged.error };
  try {
    return applyOwnedSkillUpdate({
      stagedDir: staged.staged.dir,
      managedDir: opts.managedDir,
      slug: opts.slug,
      files: staged.staged.files,
      write: Object.keys(staged.staged.files),
      remove: [],
      baseline: null,
      ...opts.transaction,
    });
  } finally {
    // staging 清理失败不能被当成"装失败"：装已经成功、账也写了（E1.5 的同一条纪律）。
    try {
      staged.staged.cleanup();
    } catch (error) {
      opts.transaction?.diagnostic?.(
        `staging-cleanup-failed: ${staged.staged.root}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
