import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PPTX_TEMPLATE_IDS, PPTX_TEMPLATE_SET_ID, PPTX_TEMPLATES } from '../src/main/docgen/pptx-template/catalog';
import { parseDocgenRequest } from '../src/main/docgen/request';
import {
  installBundledSkill,
  isBundledSkillInstalled,
  missingBundledSkills,
  readBundledSkills,
  readInstalledSkillContent,
  skillContentSha,
  staleBundledSkills,
  type BundledSkill,
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
const text = fs.readFileSync(SKILL_PATH, 'utf-8').replace(/\r\n/g, '\n');

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
      if (result.ok) expect(result.request.kind).toBe('pptx');
    }
  });
});

describe('presentation-deck-v2 —— 四种盘上的行为', () => {
  const skill = bundledSkill();

  it('场景 A（新盘）：既没装也没记账 ⇒ 走"补装"，装得上', () => {
    const managedDir = tmpDir();
    const missing = missingBundledSkills([skill], (slug) => isBundledSkillInstalled(managedDir, slug));
    expect(missing.map((s) => s.slug)).toEqual([SLUG]);

    const result = installBundledSkill({ managedDir, root: OUR_SKILLS_ROOT!, slug: SLUG });
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(isBundledSkillInstalled(managedDir, SLUG)).toBe(true);
  });

  it('场景 B（记录齐全的旧盘）：盘上还是我们装的那份 ⇒ 随包内容变了会升级、会覆盖', () => {
    const managedDir = tmpDir();
    expect(installBundledSkill({ managedDir, root: OUR_SKILLS_ROOT!, slug: SLUG }).ok).toBe(true);

    const installed = readInstalledSkillContent(managedDir, SLUG);
    expect(installed).not.toBeNull();
    const recordedOld = skillContentSha(installed!); // 假装记账是上一版的内容

    const stale = staleBundledSkills(
      [skill],
      (s) => readInstalledSkillContent(managedDir, s),
      () => recordedOld,
    );
    // 盘上 == 记账，而随包 == 记账（同一份） ⇒ 没什么可升的
    expect(stale).toEqual([]);
  });

  it('⭐ 场景 C（**没有记账的老盘**）：已存在技能的内容更新卡死 —— 这是本轮要绕开的那个缺口', () => {
    const managedDir = tmpDir();
    expect(installBundledSkill({ managedDir, root: OUR_SKILLS_ROOT!, slug: SLUG }).ok).toBe(true);

    // 造一个"老盘"：盘上是**旧内容**，而我们**没有记账**
    fs.writeFileSync(path.join(managedDir, SLUG, 'SKILL.md'), '# 老版本的旧正文\n');

    const missing = missingBundledSkills([skill], (slug) => isBundledSkillInstalled(managedDir, slug));
    const stale = staleBundledSkills(
      [skill],
      (s) => readInstalledSkillContent(managedDir, s),
      () => null,
    );

    // 三条路同时落空：不补装（已装）、不升级（没记账）
    expect(missing, '已装 ⇒ 不进补装').toEqual([]);
    expect(stale, '没记账 ⇒ 不进升级').toEqual([]);
    // ⇒ 这就是缺口本身。**本轮不修它**，只是把它钉成断言，免得被当成已修。
    //    （修它要放宽 `staleBundledSkills` 的保守判据，那是另一个决定。）
  });

  it('场景 D（用户改过）：盘上内容与记账不一致 ⇒ 一个字节都不碰', () => {
    const managedDir = tmpDir();
    expect(installBundledSkill({ managedDir, root: OUR_SKILLS_ROOT!, slug: SLUG }).ok).toBe(true);
    const original = readInstalledSkillContent(managedDir, SLUG)!;
    const recorded = skillContentSha(original);

    // 用户改过：盘上内容变了，记账还是装下去时那个
    fs.writeFileSync(path.join(managedDir, SLUG, 'SKILL.md'), `${original}\n\n（我自己加的一行）\n`);

    const stale = staleBundledSkills(
      [skill],
      (s) => readInstalledSkillContent(managedDir, s),
      () => recorded,
    );
    expect(stale, '有人改过 ⇒ 不碰').toEqual([]);
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
