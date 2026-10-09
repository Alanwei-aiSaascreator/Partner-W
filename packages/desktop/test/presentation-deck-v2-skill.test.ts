import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PPTX_TEMPLATE_IDS, PPTX_TEMPLATE_SET_ID, PPTX_TEMPLATES } from '../src/main/docgen/pptx-template/catalog';
import { parseTemplateDeck } from '../src/main/docgen/pptx-template/parse';
import { parseDocgenRequest } from '../src/main/docgen/request';
import {
  encodeSkillRecord,
  installBundledSkill,
  isBundledSkillInstalled,
  missingBundledSkills,
  planSkillSync,
  readBundledSkills,
  readInstalledSkillContent,
  readSkillFileSha,
  skillContentSha,
  skillDirFilePaths,
  type BundledSkill,
  type ManagedSkillRecordV2,
} from '../src/main/skills/bundled';
import { resolveOurSkillsRoot } from '../src/main/skills/locate';

/**
 * `presentation-deck-v2` —— **为什么要有这个技能，以及它到底解决什么**。
 *
 * ## 它是给谁的：老盘
 *
 * 0.0.35 那一代盘上，`document-deck` 已经被装过，但**那一版没有记账机制**
 * （记账是后来一个提交才加的）。于是升级判定里三条路同时落空：
 *
 * | 路 | 判据 | 在 0.0.35 盘上 |
 * | --- | --- | --- |
 * | 补装 `missing` | 目录不存在 | ✗（已装） |
 * | 升级 `stale`  | **有记账** 且 盘上 == 记账 且 随包 ≠ 记账 | ✗（**没有记账**） |
 * | 认领（补记账） | 没记账 且 盘上 == 随包 | ✗（而两者**恰好不等**） |
 *
 * ⇒ 已装技能的内容更新**永久卡死**，每次开机重算结果一样，**没有任何报错或日志**。
 * 危害是硬的：让客户端开始「排不下就整份拒绝」的那两个提交，**同时**才把
 * 「怎么写才不被拒」写进 `SKILL.md` —— 老盘卡住的正是这份指导。
 *
 * ## 它为什么能绕过：新技能走的是「补装」那条路
 *
 * 目录在老盘上**不存在** ⇒ `missing` 命中 ⇒ 装得上。卡死的只有
 * 「**已存在**技能的内容更新」，与「装一个**新**技能」无关。
 * 这就是新增一个版本化技能而不是去改 `document-deck` 的全部理由。
 *
 * ⚠️ **本文件同时把那个缺口钉成断言**（`场景 C`），这样它不会因为"没人记得"而被当成已修。
 *    本轮**不修**它 —— 修它要动 `staleBundledSkills` 的保守判据，那是另一个决定。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, '..');
const OUR_SKILLS_ROOT = resolveOurSkillsRoot({ isPackaged: false, appPath: PROJECT_DIR });
if (!OUR_SKILLS_ROOT) throw new Error('解析不到随包技能根目录 —— 这个测试就失去意义了');

const SLUG = 'presentation-deck-v2';
const SKILL_PATH = path.join(OUR_SKILLS_ROOT, SLUG, 'SKILL.md');
const entryText = fs.readFileSync(SKILL_PATH, 'utf-8').replace(/\r\n/g, '\n');
// The production contract moved out of the entry document when the controlled
// slot route was separated. Keep validating the actual referenced contract;
// do not restore competing production instructions into the controlled Skill.
const PRODUCTION_ROUTE = 'PRODUCTION-ROUTE.md';
const text = fs.readFileSync(path.join(OUR_SKILLS_ROOT, SLUG, PRODUCTION_ROUTE), 'utf-8').replace(/\r\n/g, '\n');

const temps: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presentation-deck-v2-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 从真实随包目录里读这个技能（拿到的就是运行时真正会装的那份内容）。 */
function bundledSkill(): BundledSkill {
  const found = readBundledSkills(OUR_SKILLS_ROOT!).find((s) => s.slug === SLUG);
  if (!found) throw new Error(`随包目录里没有 ${SLUG}`);
  return found;
}

describe('presentation-deck-v2 —— 内容与契约层不漂移', () => {
  it('installs the entry and its referenced production contract without merging the two routes', () => {
    expect(entryText).toContain(PRODUCTION_ROUTE);
    expect(entryText).not.toContain('```docgen');
    const managedDir = tmpDir();
    expect(installBundledSkill({ managedDir, root: OUR_SKILLS_ROOT!, slug: SLUG }).ok).toBe(true);
    expect(fs.readFileSync(path.join(managedDir, SLUG, 'SKILL.md'))).toEqual(fs.readFileSync(SKILL_PATH));
    expect(fs.readFileSync(path.join(managedDir, SLUG, PRODUCTION_ROUTE))).toEqual(
      fs.readFileSync(path.join(OUR_SKILLS_ROOT!, SLUG, PRODUCTION_ROUTE)),
    );
  });

  it('⭐ 八种 templateId 一个不漏（技能里少一种，那种版式助手就永远用不出来）', () => {
    // ⚠️ 判据是「**表格里有一行**」而不是「正文里出现过」。
    //    第一版就是这个疏漏：`timeline` 在下面"怎么挑页"那句里也出现，
    //    于是把这行从表里删掉，`toContain` 照样过 —— 变异验证当场戳穿了它。
    //    表格是助手挑版式时真正照着看的那张表，所以只认表格行。
    for (const id of PPTX_TEMPLATE_IDS) {
      const row = new RegExp(`^\\|\\s*\`${id}\`\\s*\\|`, 'm');
      expect(text, `表格里没有 \`${id}\` 这一行`).toMatch(row);
    }
  });

  it('⭐ 每个可填字段都写着（助手的字段名唯一来源就是这份文档）', () => {
    const missing: string[] = [];
    for (const spec of Object.values(PPTX_TEMPLATES)) {
      for (const token of Object.keys(spec.tokens)) {
        if (!text.includes(token)) missing.push(`${spec.id}.${token}`);
      }
    }
    expect(missing, `这些字段技能里没提：${missing.join(', ')}`).toEqual([]);
  });

  it('模板集 id 写着，且与 catalog 常量一致', () => {
    expect(text).toContain(PPTX_TEMPLATE_SET_ID);
  });

  it('标了必填的字段，技能里也标了必填', () => {
    // 抽正文里 `字段`(必填) 的形状
    for (const spec of Object.values(PPTX_TEMPLATES)) {
      for (const [token, tokenSpec] of Object.entries(spec.tokens)) {
        if (!tokenSpec.required) continue;
        const marked = new RegExp(`${token}\`?\\(必填\\)|${token}\`?\\(必填\\)`);
        expect(text, `${spec.id}.${token} 是必填，技能里没标`).toMatch(marked);
      }
    }
  });

  it('⚠️ 明确说了"别写样式"（否则助手会试着承诺配图/设计感）', () => {
    expect(text).toMatch(/别写样式|不要写样式/);
    expect(text).toMatch(/没有地方写|根本不存在/);
  });

  it('⭐ 技能里那段示例，**喂给真契约层**必须是合法请求', () => {
    // 这条才是真正会咬人的那种守卫。合并两条线时它当场抓到一个真漏：
    // 示例里写了 `kind` / `template` / `slides`，却漏了 **`title`** ——
    // 而 `title` 是所有 docgen 格式的必填项（它同时是文件名）。
    // 助手照着示例写 ⇒ 整份被 `request-invalid` 拒掉，而**两条线各自的单测全绿**，
    // 因为它们都直接调 `parseTemplateDeck`，**绕过了契约层**。
    //
    // ⇒ 判据只能是"把示例原文喂给 `parseDocgenRequest`"，而不是"看起来像那么回事"。
    const blocks = [...text.matchAll(/```docgen\n([\s\S]*?)\n```/g)];
    expect(blocks.length, '技能里一段 docgen 示例都没有').toBeGreaterThan(0);

    for (const [, body] of blocks) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        throw new Error(`技能里的示例不是合法 JSON：${String(error)}\n${body}`);
      }
      const result = parseDocgenRequest(parsed);
      expect(result.ok, `技能里的示例被契约层拒了：${result.ok ? '' : result.error}`).toBe(true);
      if (result.ok) {
        expect(result.request.kind).toBe('pptx');
        if (result.request.kind === 'pptx') {
          const deck = parseTemplateDeck(result.request.rawTemplateDeck);
          expect(deck.ok, JSON.stringify(deck)).toBe(true);
        }
      }
    }
  });

  it('documents a valid cooperation table example with three explicit column headers', () => {
    const slides = [...text.matchAll(/```docgen\n([\s\S]*?)\n```/g)].flatMap(([, body]) => {
      const result = parseDocgenRequest(JSON.parse(body));
      if (!result.ok || result.request.kind !== 'pptx') throw new Error('Invalid documented PPTX request');
      const deck = parseTemplateDeck(result.request.rawTemplateDeck);
      if (!deck.ok) throw new Error(JSON.stringify(deck.failure));
      return deck.deck.slides;
    });
    expect(slides).toContainEqual({
      templateId: 'actions',
      data: expect.objectContaining({
        slide_title: '\u5408\u4f5c\u65b9\u6848',
        action_header: '\u5408\u4f5c\u65b9\u5f0f',
        owner_header: '\u9002\u7528\u5bf9\u8c61',
        due_header: '\u4ea4\u4ed8\u5468\u671f',
        action_1: '\u5355\u54c1\u8bca\u65ad',
        owner_1: '\u4e2d\u5c0f\u5546\u5bb6',
        due_1: '3 \u4e2a\u5de5\u4f5c\u65e5',
      }),
    });
  });

  it('技能正文里写了"别用裸英文双引号"这条，并给了替代写法', () => {
    // 原始 JSON 仍不合法；客户端的受控修复是最后保险，不是模型的写法契约。
    expect(text, '没写"别用英文双引号"这条').toMatch(/别用英文双引号/);
    expect(text, '没给替代写法（「」或 \\"）').toMatch(/中文引号/);
  });

  it('⭐ ask_user 契约写清楚：最多 3 问、自由文本不用它、失败不能当成用户已回答', () => {
    expect(text).toMatch(/ask_user/);
    expect(text).toMatch(/最多\s*3/);
    expect(text).toMatch(/自由文本|开放式问题/);
    expect(text).toMatch(/普通消息|直接在对话里问/);
    expect(text).toMatch(/失败.*(?:不代表|不能当作|不得视为).*回答|不能.*失败.*当.*回答/);
  });

  it('⭐ 技能里的 section_context 字数必须与真 catalog 一致', () => {
    const max = PPTX_TEMPLATES.section.tokens.section_context.maxLength;
    expect(text).toMatch(new RegExp(`section_context[^\\n]{0,80}${max}`));
  });

  it('⭐ 不许先向用户宣称 PPT 已交付，必须以右侧实际出现 .pptx 为准', () => {
    expect(text).toMatch(/以.*右侧.*实际出现.*\.pptx.*为准/);
    expect(text).toMatch(/不要.*(?:改走|换成).*slidegen|不要.*\.slidegen.*兜底/);
  });

  it('⭐ 裸英文双引号让原始 JSON 非法；换成技能推荐的写法就没事', () => {
    const body = text.match(/```docgen\n([\s\S]*?)\n```/)![1];
    expect(() => JSON.parse(body), '示例原文必须是合法 JSON').not.toThrow();

    const broken = body.replace('"私域增长与渠道结构"', '"私域"增长"与渠道结构"');
    expect(broken, '替换锚点失效了，这个测试要重写').not.toBe(body);
    expect(() => JSON.parse(broken), '裸引号样例必须真的是非法 JSON').toThrow();

    for (const safe of ['"私域「增长」与渠道结构"', '"私域\\"增长\\"与渠道结构"']) {
      const fixed = body.replace('"私域增长与渠道结构"', safe);
      expect(() => JSON.parse(fixed), `技能推荐的写法 ${safe} 本身不合法`).not.toThrow();
    }
  });
});

describe('presentation-deck-v2 —— 四种盘上的行为', () => {
  const skill = bundledSkill();
  const vendorPaths = () => skillDirFilePaths(path.join(OUR_SKILLS_ROOT!, SLUG))!;
  /** 装下去那一刻的**真实**记账（逐文件 sha）。 */
  const recordOf = (managedDir: string): ManagedSkillRecordV2 => ({
    version: 2,
    packageSha: skill.packageSha!,
    files: Object.fromEntries(vendorPaths().map((rel) => [rel, readSkillFileSha(path.join(managedDir, SLUG), rel)!])),
  });
  /** 盘上那份的已装视图（真实读盘，走产品的读取出口）。 */
  const viewOf = (managedDir: string) => {
    const target = path.join(managedDir, SLUG);
    const content = readInstalledSkillContent(managedDir, SLUG);
    return {
      skillSha: content === null ? null : skillContentSha(content),
      fileSha: (relativePath: string) => readSkillFileSha(target, relativePath),
    };
  };
  const install = (managedDir: string) => {
    const result = installBundledSkill({ managedDir, root: OUR_SKILLS_ROOT!, slug: SLUG });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
  };

  it('场景 A（新盘）：既没装也没记账 ⇒ 走"补装"，装得上', () => {
    const managedDir = tmpDir();
    const missing = missingBundledSkills([skill], (slug) => isBundledSkillInstalled(managedDir, slug));
    expect(missing.map((s) => s.slug)).toEqual([SLUG]);

    install(managedDir);
    expect(isBundledSkillInstalled(managedDir, SLUG)).toBe(true);
  });

  it('场景 B（记录齐全的旧盘）：盘上还是我们装的那份 ⇒ 随包内容变了只差分升级、别的文件不碰', () => {
    const managedDir = tmpDir();
    install(managedDir);
    const record = recordOf(managedDir);

    // 随包更新：SKILL.md 与 TEMPLATE-DECK.md 都变了（版本号也变 ⇒ 不命中 unchanged 快路径）。
    const nextFiles = {
      ...record.files,
      'SKILL.md': 'a'.repeat(64),
      'TEMPLATE-DECK.md': 'b'.repeat(64),
    };
    expect(
      planSkillSync({
        packageSha: 'c'.repeat(64),
        nextFiles,
        recorded: encodeSkillRecord(record),
        installed: viewOf(managedDir),
      }),
    ).toEqual({ kind: 'update', write: ['SKILL.md', 'TEMPLATE-DECK.md'], remove: [] });
  });

  it('⭐ 场景 C-1（**没有记账的老盘，且盘上与当前包不一致**）：不许瞎猜 —— 具名冲突，等用户走修复出口', () => {
    const managedDir = tmpDir();
    install(managedDir);
    const packageFiles = recordOf(managedDir).files; // 当前包的那一份（装下去时的真实字节）
    fs.writeFileSync(path.join(managedDir, SLUG, 'TEMPLATE-DECK.md'), '老版本的旧模板说明\n');

    const missing = missingBundledSkills([skill], (slug) => isBundledSkillInstalled(managedDir, slug));
    expect(missing, '已装 ⇒ 不进补装').toEqual([]);
    // H1 之前这里三条路同时落空、连一条日志都没有；现在是一个**具名**冲突：
    // 无账 + 与当前包不一致 ⇒ 来源无从核验（unverified-origin），保留现场。
    expect(
      planSkillSync({
        packageSha: skill.packageSha!,
        nextFiles: packageFiles,
        recorded: undefined,
        installed: viewOf(managedDir),
      }),
    ).toMatchObject({ kind: 'conflict', reason: 'unverified-origin' });
  });

  it('⭐ 场景 C-2（没有记账、但盘上与当前包逐字一致）⇒ 认领真实基线（不写盘、不改用户文件）', () => {
    const managedDir = tmpDir();
    install(managedDir);
    const files = recordOf(managedDir).files;
    const plan = planSkillSync({
      packageSha: skill.packageSha!,
      nextFiles: files,
      recorded: undefined,
      installed: viewOf(managedDir),
    });
    expect(plan).toEqual({ kind: 'adopt', record: { version: 2, packageSha: skill.packageSha!, files } });
  });

  it('场景 D（用户改过）：盘上内容与记账不一致 ⇒ 一个字节都不碰', () => {
    const managedDir = tmpDir();
    install(managedDir);
    const record = recordOf(managedDir);
    const original = readInstalledSkillContent(managedDir, SLUG)!;
    fs.writeFileSync(path.join(managedDir, SLUG, 'SKILL.md'), `${original}\n\n（我自己加的一行）\n`);

    expect(
      planSkillSync({
        packageSha: 'c'.repeat(64), // 随包也更新了：依然不许碰
        nextFiles: { ...record.files, 'SKILL.md': 'a'.repeat(64) },
        recorded: encodeSkillRecord(record),
        installed: viewOf(managedDir),
      }),
    ).toMatchObject({ kind: 'conflict', reason: 'user-modified', paths: ['SKILL.md'] });
    expect(readInstalledSkillContent(managedDir, SLUG)).toContain('我自己加的一行');
  });
});

describe('同一条路上，HTML 线新增的技能也装得上', () => {
  it('「网页交付」在老盘上同样走"补装"（目录不存在 ⇒ 装得上）', () => {
    const managedDir = tmpDir();
    const all = readBundledSkills(OUR_SKILLS_ROOT!);
    const htmlSkill = all.find((s) => s.slug === 'html-deliverable');
    expect(htmlSkill, '随包目录里应当有 html-deliverable').toBeDefined();

    const missing = missingBundledSkills(all, (slug) => isBundledSkillInstalled(managedDir, slug));
    expect(missing.map((s) => s.slug)).toContain('html-deliverable');
    expect(installBundledSkill({ managedDir, root: OUR_SKILLS_ROOT!, slug: 'html-deliverable' }).ok).toBe(true);
    expect(isBundledSkillInstalled(managedDir, 'html-deliverable')).toBe(true);
  });
});
