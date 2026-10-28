import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { readBundledSkills } from '../src/main/skills/bundled.js';
import { resolveOurSkillsRoot } from '../src/main/skills/locate.js';
import {
  DOMAIN_PREFIXES,
  EXPERT_CATALOG,
  EXPERT_DOMAINS,
  buildExpertLaunchPrompt,
  expertsByDomain,
  findExpert,
  type ExpertDomain,
} from '../src/renderer/lib/expert-catalog';

/**
 * 「专家库」随包目录的**投影完整性**（2026-10-16，全量总单第 24 行）。
 *
 * ## 这一层是什么
 *
 * 18 份 Octop 专家技能（`our-skills/octop-*`）是**随包发给用户的全部专家提示词**
 * （见 `octop-provenance-integrity.test.ts` 的自述）。但渲染层**读不到**
 * `our-skills`（那是主进程的磁盘目录）—— 于是界面上根本没有"专家"这个面。
 * `expert-catalog.ts` 是它的一份**只读投影**：把 slug / 名字 / 一句话能力 / 头像字
 * 搬进渲染层，让"专家库"页面有东西可渲染。
 *
 * ## 投影的最大风险 = 漂移
 *
 * 手抄一份目录，改 SKILL.md 的人不会回来改这份目录 ⇒ 界面上显示的名字与助手实际
 * 读到的东西对不上，而且**没人会发现**。所以这份测试把投影**逐条钉死在磁盘上**：
 * 名字、能力、头像字都必须与**产品解析器**（`readBundledSkills`，会随包发出去的那份）
 * 读出来的一致；多一个、少一个、写错一个字都红。
 *
 * ## 这一层**不**做什么
 *
 * · 不下载、不复制上游头像：上游头像在 `dashboard/public/experts/avatars/`，
 *   **不在**专家库 Apache-2.0 目录内（`octop-provenance-integrity.test.ts` 已写明
 *   "本包一个字节都没有取"）。这里用的头像字是**随包内容自带**的 frontmatter emoji。
 * · 不编造人名 / 履历：专家的"名字"就是技能的 name，"能力"就是它的 description。
 */

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = resolveOurSkillsRoot({ isPackaged: false, appPath: project });
if (!root) throw new Error('our-skills 根目录解析失败 —— 这份测试就失去意义了');

const onDisk = readBundledSkills(root).filter((skill) => skill.slug.startsWith('octop-'));
const onDiskBySlug = new Map(onDisk.map((skill) => [skill.slug, skill]));

describe('专家目录 = 随包 octop 技能的投影（不是第二个真源）', () => {
  it('⭐ 一一对应：盘上有几个 octop 技能，目录里就有几个专家', () => {
    expect(EXPERT_CATALOG.length).toBe(onDisk.length);
    expect(EXPERT_CATALOG.length).toBeGreaterThan(0);
  });

  it('⭐ 每个专家的 id 就是它那份技能的 slug，且盘上真有这份技能', () => {
    for (const expert of EXPERT_CATALOG) {
      expect(expert.id).toBe(expert.skillSlug);
      expect(onDiskBySlug.has(expert.skillSlug), `目录里有 ${expert.skillSlug}，盘上没有`).toBe(true);
    }
  });

  it('⭐ 反向：盘上每一个 octop 技能都被登记成专家（新增技能不登记 ⇒ 这里红）', () => {
    const missing = onDisk.map((skill) => skill.slug).filter((slug) => !findExpert(slug));
    expect(missing, `这些技能没有对应的专家条目：${missing.join(', ')}`).toEqual([]);
  });

  it('⭐ 名字 / 一句话能力 / 头像字都逐字等于盘上那份技能（改了 SKILL.md 不回填 ⇒ 这里红）', () => {
    for (const expert of EXPERT_CATALOG) {
      const skill = onDiskBySlug.get(expert.skillSlug);
      expect(skill, `${expert.id} 在盘上找不到`).toBeTruthy();
      expect(expert.name, `${expert.id} 的名字与 SKILL.md 不一致`).toBe(skill?.name);
      expect(expert.capability, `${expert.id} 的说明与 SKILL.md 不一致`).toBe(skill?.description);
      expect(expert.glyph, `${expert.id} 的头像字与 SKILL.md 的 emoji 不一致`).toBe(skill?.emoji);
    }
  });

  it('⭐ 名字两两不重复（重名会让用户分不清点的是谁）', () => {
    const names = EXPERT_CATALOG.map((expert) => expert.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('⭐ 每个专家都真的有名字、有能力、有头像字（空串等于卡片是白板）', () => {
    for (const expert of EXPERT_CATALOG) {
      expect(expert.name.length, `${expert.id} 没有名字`).toBeGreaterThan(0);
      expect(expert.capability.length, `${expert.id} 没有能力说明`).toBeGreaterThan(0);
      expect(expert.glyph.length, `${expert.id} 没有头像字`).toBeGreaterThan(0);
    }
  });
});

describe('分组：领域来自 slug，不靠人肉维护第二张表', () => {
  it('⭐ 领域码就是登记的那四个', () => {
    expect([...EXPERT_DOMAINS].sort()).toEqual(['design', 'engineering', 'knowledge', 'news']);
  });

  it('⭐ 每个专家的 slug 都带着自己领域的前缀', () => {
    for (const expert of EXPERT_CATALOG) {
      const prefixes = DOMAIN_PREFIXES[expert.domain];
      expect(
        prefixes.some((prefix) => expert.skillSlug.startsWith(prefix)),
        `${expert.id} 归到 ${expert.domain} 但 slug 不带这个领域的前缀`,
      ).toBe(true);
    }
  });

  it('⭐ 按领域取人：每个领域都非空，且加起来正好是全量（不重不漏）', () => {
    const collected: string[] = [];
    for (const domain of EXPERT_DOMAINS) {
      const list = expertsByDomain(domain);
      expect(list.length, `${domain} 一个专家都没有`).toBeGreaterThan(0);
      for (const expert of list) {
        expect(expert.domain).toBe(domain);
        collected.push(expert.id);
      }
    }
    expect(new Set(collected).size).toBe(EXPERT_CATALOG.length);
  });

  it('⭐ 领域是穷举的：没有落在四个领域之外的专家', () => {
    for (const expert of EXPERT_CATALOG) {
      expect(EXPERT_DOMAINS as readonly ExpertDomain[]).toContain(expert.domain);
    }
  });
});

describe('findExpert：找不到就是找不到，不猜', () => {
  it('⭐ 认识的 slug 取得到本人', () => {
    const first = EXPERT_CATALOG[0];
    expect(findExpert(first.id)?.id).toBe(first.id);
  });

  it('⭐ 不认识的 id / 空串 ⇒ undefined（不是随便返回一个）', () => {
    expect(findExpert('octop-does-not-exist')).toBeUndefined();
    expect(findExpert('')).toBeUndefined();
  });
});

describe('buildExpertLaunchPrompt：点了之后发出去的那句话', () => {
  const t = (key: string, options?: Record<string, unknown>): string =>
    options ? `${key}|${JSON.stringify(options)}` : key;

  it('⭐ 句子里点名了这位专家（用户点谁就该是谁）', () => {
    const expert = EXPERT_CATALOG[0];
    expect(buildExpertLaunchPrompt(expert, t)).toContain(expert.name);
  });

  it('⭐ 不同专家发出去的话不同（否则点了等于没点）', () => {
    const a = buildExpertLaunchPrompt(EXPERT_CATALOG[0], t);
    const b = buildExpertLaunchPrompt(EXPERT_CATALOG[1], t);
    expect(a).not.toBe(b);
  });

  it('⭐ 文案骨架走 i18n 键，不在代码里写死（9 语言要靠键位对等）', () => {
    const prompt = buildExpertLaunchPrompt(EXPERT_CATALOG[0], t);
    expect(prompt.startsWith('experts.launchPrompt')).toBe(true);
  });
});
