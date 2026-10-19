/**
 * 身份中心的**纯逻辑**（2026-09-19）。
 *
 * 放在这里的都是**不依赖 React、可以直接单测**的东西 —— 与 `lib/assistant-task-presets.ts`
 * 同一种做法（那边也是"id → i18n key"的映射表 + 纯函数）。
 */

import { INDUSTRY_BRIEFING_PREFIXES } from './industry-method';

/** 「人群画像标签组合」的五个标签。顺序 = 界面上从左到右。 */
export const IDENTITY_PERSONA_TAGS = ['goalOriented', 'efficiency', 'logical', 'reporting', 'timeManagement'] as const;

export type IdentityTagId = (typeof IDENTITY_PERSONA_TAGS)[number];

/** 设计稿上默认选中的四个（最后一个「时间管理」不选）。 */
export const IDENTITY_DEFAULT_TAGS: IdentityTagId[] = ['goalOriented', 'efficiency', 'logical', 'reporting'];

/**
 * 「换一个标签」：在当前选中的基础上**轮换一格**。
 *
 * 定义得很死：所有标签排成一个环，整体往后挪一位。
 * - 空选 ⇒ 返回默认那四个（"换"之前先有个起点）
 * - 全选 ⇒ 也轮换（没必要特判：结果是同一个集合，但顺序变了；我们按集合看，所以看起来没变）
 *
 * ⚠️ 刻意**不做**"随机抽一个"：随机不可测，而且用户连点两次会看到不稳定的结果。
 */
export function nextTagSelection(current: readonly IdentityTagId[]): IdentityTagId[] {
  if (current.length === 0) return [...IDENTITY_DEFAULT_TAGS];
  const ring = IDENTITY_PERSONA_TAGS;
  const offset = ring.indexOf(current[0]) + 1;
  return ring.map((_, i) => ring[(i + offset) % ring.length]).slice(0, current.length);
}

/* ────────────────────────── 写进助手记忆（2026-09-26 身份中心 v2） ────────────────────────── */

/**
 * ## ⚠️ `USER.md` 身份块**不是第二套档案真源**（2026-10-16，T28 残留）
 *
 * 每个助手的 `USER.md` 里那份身份块**看着像**一份档案副本（客群 / 介绍 / 标签 /
 * 行业方法），而且会在**每个**助手的 `USER.md` 里各存一份 —— 所以必须把它的角色钉死，
 * 否则很容易被当成"另一份档案"来读、来写。逐字段说清：
 *
 * - **客群 / 行业方法 / 介绍** = `userProfile` 的**投影**。唯一真源是 `localStorage` 的
 *   `rongying-cube:onboarding:v3:<userId>`（`lib/user-onboarding.ts`；
 *   `PRODUCT_ARCHITECTURE.md` §2「userProfile」）。这份块**只是**把这些字段
 *   投影成助手每轮读的提示词。
 * - **偏好标签**（`IDENTITY_PERSONA_TAGS`）**不是** `userProfile` 的字段（档案里根本没有它）——
 *   它的持久内容落在本块里（助手每轮读的就是它）。末尾那个
 *   `IDENTITY_TAGS_STORAGE_PREFIX` 缓存**不是源**，只是"上次保存时界面上选了几个"的回读缓存。
 * - **任何代码不得把这份块读回来当权威档案**（唯一的读回者是 `stripIdentityBlock`，
 *   而它是**重写辅助** —— 只负责在再次保存时把旧块摘干净，不让它堆积/污染）。
 * - **禁止**为"身份/档案"另起**第二套 store**（`PRODUCT_ARCHITECTURE.md` §2 的硬规则）：
 *   要加字段就加在 `userProfile` 上，本块只在保存时**投影**出来。
 *
 * ⇒ 三条链各自的角色：**真源**（档案）→ `buildIdentityBlock` **投影** → 各助手 `USER.md`
 *   （提示词）。缺档案 / 缺值时写如实的「未配置」（`common.notConfigured`），**不臆造**。
 */
/**
 * 身份块的标记。**必须是注释**：`USER.md` 是运行时**每轮全文注入**的提示词，
 * 标记要在模型看到的正文里不可见（与 `stampPresetPrompt` 同一个理由）。
 */
export const IDENTITY_BLOCK_START = '<!-- 身份中心：自动写入，请勿手改 -->';
export const IDENTITY_BLOCK_END = '<!-- /身份中心 -->';

/**
 * `USER.md` 的字符上限 —— **运行时的硬限制**，不是我们定的（记忆页同一口径）。
 * 超了要么被截断、要么整份写不进去，两种都比"如实报错、一个字不写"坏。
 */
export const USER_MD_MAX_CHARS = 4000;

/**
 * 身份块的正文（含标记）。`tagLabels` 为空时也要说清"未选"，不留一个空冒号。
 *
 * ⚠️ **投影，不是真源** —— 唯一真源是 `userProfile`（`rongying-cube:onboarding:v3:<userId>`，
 *    `PRODUCT_ARCHITECTURE.md` §2）。本函数只把档案**投影**成助手每轮读的提示词，
 *    产出的块**不许**被读回来当权威档案（见文件头 `USER.md 身份块不是第二套档案真源`）。
 *
 * `groupLabel` = **用户自己的行业/岗位**（首跑档案里的值），不是当前助手的名字 ——
 * 这一块会写进**每个**助手的 `USER.md`，写"客群：内容助手"等于告诉每个助手
 * "你服务的是内容助手"（2026-10-07 体检抓到的原话）。缺档案时由调用方给
 * 「未配置」这类如实值（`common.notConfigured`），这里不做臆造兜底。
 *
 * `introduction` = 首跑「一句话介绍」（可选，2026-10-07 补：只写不读的那个字段）。
 *
 * `industryLines` = **行业方法那三行**（2026-10-16，全量总单第 23 行，可选）。
 * 由 `lib/industry-method.ts` 的 `buildIndustryBriefing` 产出，落点是"用户选了这个行业
 * ⇒ 每个助手都按这个行业的方法与交付结构干活"。这是行业真正影响产出的那一条链：
 * 首跑档案 → 个性化中心 → 本函数 → 各助手 `USER.md` → **每轮全文注入的提示词**。
 * 不给 / 空数组 ⇒ 与旧行为**逐字相同**（既有调用方一个字都不用改）。
 */
export function buildIdentityBlock(input: {
  groupLabel: string;
  tagLabels: readonly string[];
  introduction?: string;
  industryLines?: readonly string[];
}): string {
  const tags = input.tagLabels.length > 0 ? input.tagLabels.join('、') : '（未选）';
  const introduction = input.introduction?.trim();
  const lines = [IDENTITY_BLOCK_START, '## 我的身份', `- 客群：${input.groupLabel}`];
  if (introduction) lines.push(`- 介绍：${introduction}`);
  lines.push(`- 标签：${tags}`);
  /**
   * ⚠️ **只收"剥离器认得出的行"**：必须以登记的前缀开头、且不含换行。
   *
   * 理由只有一个：身份块是**按前缀剥离再重写**的。放进一行剥离器不认的东西，
   * 下次保存时它不会被摘掉 ⇒ 越写越多 ⇒ 撑爆 4000 字上限 ⇒ **用户自己写的记忆
   * 整份写不进去**（不可逆）。这里宁可丢掉一行，也不能让 USER.md 被写坏。
   */
  for (const line of input.industryLines ?? []) {
    if (line.includes('\n')) continue;
    if (!INDUSTRY_BRIEFING_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;
    lines.push(line);
  }
  lines.push(IDENTITY_BLOCK_END);
  return lines.join('\n');
}

export type IdentityMergeResult = { ok: true; content: string } | { ok: false; reason: 'over-limit'; limit: number };

/** 把已有的身份块整段摘掉（含它前后的空行），只留用户自己写的内容。 */
function stripIdentityBlock(existing: string): string {
  const start = existing.indexOf(IDENTITY_BLOCK_START);
  if (start < 0) return existing.trim();
  const endMark = existing.indexOf(IDENTITY_BLOCK_END, start);
  if (endMark >= 0) {
    const end = endMark + IDENTITY_BLOCK_END.length;
    return `${existing.slice(0, start)}${existing.slice(end)}`.trim();
  }
  /**
   * ⚠️ 结束标记缺失（用户手删过一行、或文件被别的工具截断）：**不许**把标记后面的
   * 一切都当身份块删掉 —— 那是"用户自己写的一个字节都不许丢"的反面（2026-10-07 体检）。
   * 这里只吞掉身份块**自己那几行**（`## 我的身份` + `- 客群：/介绍：/标签：` 三个前缀），
   * 再往下的人话（包括用户自己的列表项）原样保留。
   */
  const lines = existing.slice(start + IDENTITY_BLOCK_START.length).split('\n');
  /**
   * ⚠️ 这个判据必须与 `buildIdentityBlock` **写得出来的行**一一对应。
   *    少认一个前缀 ⇒ 那行永远摘不掉 ⇒ 每次保存就多一份（2026-10-16 加行业块时
   *    同步补了 `INDUSTRY_BRIEFING_PREFIXES` 那三个）。
   */
  const isBlockLine = (line: string): boolean => {
    const trimmed = line.trim();
    return (
      trimmed === '## 我的身份' ||
      trimmed.startsWith('- 客群：') ||
      trimmed.startsWith('- 介绍：') ||
      trimmed.startsWith('- 标签：') ||
      INDUSTRY_BRIEFING_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
    );
  };
  let consumed = 0;
  for (const line of lines) {
    if (consumed === 0 && line.trim() === '') {
      // 标记行后面的那一个空行属于块的开头，吞掉；块中间的第二个空行连同后面内容都留下。
      consumed += 1;
      continue;
    }
    if (!isBlockLine(line)) break;
    consumed += 1;
  }
  return `${existing.slice(0, start)}${lines.slice(consumed).join('\n')}`.trim();
}

/**
 * **合并**身份块进 `USER.md`：用户自己写的一个字节都不许丢，重复保存是**替换**不是追加。
 *
 * ⚠️ 为什么不是整份覆盖写（记忆页那种）：那边是用户自己在编辑那个文件，覆盖是用户的意思；
 *    这里是**页面顺手写的**，把用户手写的记忆冲掉是不可逆的损坏。
 */
export function mergeIdentityIntoUserMd(existing: string, block: string): IdentityMergeResult {
  const base = stripIdentityBlock(existing);
  const content = base.length > 0 ? `${base}\n\n${block}` : block;
  if (content.length > USER_MD_MAX_CHARS) {
    return { ok: false, reason: 'over-limit', limit: USER_MD_MAX_CHARS };
  }
  return { ok: true, content };
}

/* ────────────────────────── 读回助手文件（2026-10-07 体检） ────────────────────────── */

/**
 * 从 `agents.files.get` 的**真机载荷**里取 `USER.md` 正文；取不出来返回 `null`。
 *
 * ## 🔴 为什么要有这个函数（血的教训）
 *
 * 真机返回的是 `{ agentId, workspace, file: { name, content, missing } }`（契约
 * `docs/openclaw-gateway-whitepaper.md`；对照三处正确读法：`preset-agent-installer.ts:122`、
 * `AgentsSection.tsx:1029`、`TeamDetailView.tsx:131`）。2026-10-07 体检时两个页面读的是
 * `result.content` —— 字段错位 ⇒ **恒读成空串** ⇒ 个性化中心"保存并应用"把每个助手的
 * `USER.md` 覆盖成只剩身份块，记忆页显示为空。
 *
 * ⚠️ 读失败（`ok:false`）与"形状不认识"都由调用方按 **读失败** 处理（跳过、如实报），
 *    **绝不**当"空文件"——那正是覆盖用户记忆的那条路。`missing:true`（文件不存在）
 *    与空文件都如实返回 `''`：这两种情况下本来就没有要保住的字节。
 */
export function userMdContentFromReadResult(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const file = (payload as { file?: unknown }).file;
  if (!file || typeof file !== 'object') return null;
  const entry = file as { content?: unknown; missing?: unknown };
  if (entry.missing === true) return '';
  const content = entry.content;
  if (content === undefined || content === null) return ''; // 契约里 content 是可选的（空文件）
  return typeof content === 'string' ? content : null;
}

/* ────────────────────────── 偏好标签的回读缓存（2026-10-07 体检） ────────────────────────── */

/**
 * 偏好标签的**本地缓存键前缀**（按 userId 分键）。
 *
 * ⚠️ 这不是第二套档案真源：标签的**持久内容真源**仍是各助手 `USER.md` 里的身份块
 *    （助手每轮读的是它）。这里缓存的只是"上次保存时界面上选了哪几个"，
 *    用来在**再次进页面时回读选择** —— 没有它，重进页面 = 静默改回默认四标签，
 *    再点一次保存就把用户的意图覆盖回去了（体检问题 4）。
 */
export const IDENTITY_TAGS_STORAGE_PREFIX = 'rongying-cube:identity-tags:v1:';

/** 存储视图（只要求 getItem/setItem，单测塞假货即可）。 */
export interface IdentityTagsStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** 回读上次保存的标签选择；没有 / 坏了 / 存储不可用一律 `null`（调用方回默认四标签）。 */
export function readStoredIdentityTags(
  userId: string | null | undefined,
  storage?: IdentityTagsStorage,
): IdentityTagId[] | null {
  if (!userId) return null;
  try {
    const source = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
    if (!source) return null;
    const raw = source.getItem(`${IDENTITY_TAGS_STORAGE_PREFIX}${userId}`);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const tags = parsed.filter((value): value is IdentityTagId =>
      (IDENTITY_PERSONA_TAGS as readonly unknown[]).includes(value),
    );
    // 有陌生项 ⇒ 整份不认识（宁回默认，不静默丢一个用户的勾选）。
    if (tags.length !== parsed.length) return null;
    return [...new Set(tags)];
  } catch {
    return null;
  }
}

/** 记住这次保存的标签选择（写不进去就算了 —— 是体验增强，不是真源）。 */
export function saveStoredIdentityTags(
  userId: string | null | undefined,
  tags: readonly IdentityTagId[],
  storage?: IdentityTagsStorage,
): void {
  if (!userId || tags.length === 0) return;
  try {
    const target = storage ?? (typeof window === 'undefined' ? null : window.localStorage);
    target?.setItem(`${IDENTITY_TAGS_STORAGE_PREFIX}${userId}`, JSON.stringify(tags));
  } catch {
    // 隐私模式 / 配额满：不回读就是了，绝不让保存流程因此失败。
  }
}
