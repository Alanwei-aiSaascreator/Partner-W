import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OUR_SKILLS_DIR_NAME, resolveOurSkillsRoot } from '../src/main/skills/locate.js';
import { isSafeSlug, readBundledSkills } from '../src/main/skills/bundled.js';

/**
 * 随包技能（`packages/desktop/our-skills/`）的**两道闸**：打包映射 + 内容格式。
 *
 * ## 为什么必须靠测试钉
 *
 * 运行时的技能加载器对**格式不对 = 静默丢弃**（`local-loader` 里 `name`/`description`
 * 任一为空就 `onDiagnostic` 后 return null，目录扫描也不会报错）。
 * 表现和"这个技能没打进去"一模一样：技能市场空着、一键装永远失败、
 * **没有任何报错**。这种问题只会在用户那里变成一句"你们的技能用不了"。
 *
 * ## ⚠️ 这个文件**不是**权威
 *
 * 权威是**运行时自己的加载器**。这里只做快速预检（提交时就能红），
 * 真正的端到端证明是 dev 实机那一步：把技能装进 `managedSkillsDir` 再查 `skills.status`。
 * 反过来说：**这里绿了不等于运行时认**；格式规则若有出入，以实测为准并回来改这里。
 *
 * ## 为什么解析器从这里搬走了
 *
 * 原来这个文件自带一份 frontmatter 解析器 —— 那是"夹具的解析器"和"产品的解析器"
 * 各写一遍：产品的那个一放宽，两边会**一起绿**，而运行时照旧丢文件。
 * 现在解析器只有一份（`src/main/skills/bundled.ts`，会跟着发布出去），这里 import 它。
 *
 * ⚠️ 尽管如此，那个解析器仍**比 YAML 规范严得多**（只认单行 `key: value`，
 *    块标量一律判无效）。这不是能力缺失，是刻意的：我们**写**的时候只用这一种形状，
 *    "解析器会不会跟运行时分歧"这个问题就不成立。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, '..');
const OUR_SKILLS_DIR = path.join(PROJECT_DIR, OUR_SKILLS_DIR_NAME);
const YML_PATH = path.join(PROJECT_DIR, 'electron-builder.yml');

const raw = fs.readFileSync(YML_PATH, 'utf-8');
/** 注释掉的行不算配置（同 `kb-model-packaging-gate.test.ts` 的教训）。 */
const yml = raw
  .split(/\r?\n/)
  .map((line) => (line.trimStart().startsWith('#') ? '' : line.replace(/\s#.*$/, '')))
  .join('\n');
const entries = [...yml.matchAll(/-\s*from:\s*(\S+)\s*\n\s*to:\s*(\S+)/g)].map((m) => ({ from: m[1], to: m[2] }));

/** 运行时上限：单文件 256KiB，超了直接丢（`skill-root-discovery` 的 `maxSkillFileBytes`）。 */
const MAX_SKILL_FILE_BYTES = 256e3;

/**
 * 读取原文并规范化换行。
 *
 * ⚠️ **不剥 BOM**：这里要查的是 `\n---` 的位置与 `description:` 那一行，
 *    两者都不受开头 BOM 影响。刻意不写 `replace(BOM, '')` ——
 *    字面量的 U+FEFF 会被 eslint 的 `no-irregular-whitespace` 判红，
 *    而且在编辑器里**看不见**（改坏了都不知道）。
 */
function readSkillText(slug: string): string {
  return fs.readFileSync(path.join(OUR_SKILLS_DIR, slug, 'SKILL.md'), 'utf-8').replace(/\r\n/g, '\n');
}

/** frontmatter 结束的位置（正文从这里开始）。 */
function bodyOf(text: string): string {
  const close = text.indexOf('\n---', 3);
  return close === -1 ? '' : text.slice(close + 4);
}

/**
 * ⚠️ 用**产品那份解析器**读，并且从**代码解析出来的根目录**读
 *（而不是拿测试自己拼的路径）—— 这样连"根目录解析错了"也一起测到。
 */
const ROOT = resolveOurSkillsRoot({ isPackaged: false, appPath: PROJECT_DIR });
const skills = readBundledSkills(ROOT);

describe('随包技能：打包配置', () => {
  it('⭐ yml 里有 `from: our-skills` → `to: our-skills`', () => {
    expect(entries).toContainEqual({ from: OUR_SKILLS_DIR_NAME, to: OUR_SKILLS_DIR_NAME });
  });

  it('⭐ 基准是 projectDir(= packages/desktop) ⇒ 解出来正好是我们的技能目录', () => {
    const from = entries.find((e) => e.to === OUR_SKILLS_DIR_NAME)?.from ?? '';
    expect(path.resolve(PROJECT_DIR, from)).toBe(OUR_SKILLS_DIR);
  });

  it('⭐ 名字三方一致：yml 的 `to` == locate.ts 的常量 == 磁盘上的目录名', () => {
    expect(OUR_SKILLS_DIR_NAME).toBe('our-skills');
    expect(entries.some((e) => e.to === OUR_SKILLS_DIR_NAME)).toBe(true);
    expect(path.basename(OUR_SKILLS_DIR)).toBe(OUR_SKILLS_DIR_NAME);
  });

  it('⭐ 代码解析出来的根目录 == 测试自己拼的那个（解析层跑偏会在这里红）', () => {
    expect(ROOT).toBe(OUR_SKILLS_DIR);
  });
});

describe('随包技能：内容格式（格式不对 = 运行时静默丢弃）', () => {
  it('技能目录存在且至少带一个技能（空目录会让"技能市场"页面空着）', () => {
    expect(fs.existsSync(OUR_SKILLS_DIR), `缺目录 ${OUR_SKILLS_DIR}`).toBe(true);
    expect(skills.length).toBeGreaterThan(0);
  });

  it('⭐ 每个技能都是 `<slug>/SKILL.md`（少一层、多一层运行时都扫不到）', () => {
    for (const skill of skills) {
      expect(fs.existsSync(path.join(OUR_SKILLS_DIR, skill.slug, 'SKILL.md')), `${skill.slug} 缺 SKILL.md`).toBe(true);
    }
  });

  it('⭐ 每个技能都有非空的 name 与 description（任一为空 ⇒ 运行时直接丢掉，不报错）', () => {
    for (const skill of skills) {
      expect(skill.name, `${skill.slug} 缺 name（或 frontmatter 不是我们认的形状）`).toBeTruthy();
      expect(skill.description, `${skill.slug} 缺 description`).toBeTruthy();
    }
  });

  it('⭐ 每个技能的正文不能是空的（只有 frontmatter 的技能等于没写）', () => {
    for (const skill of skills) {
      expect(bodyOf(readSkillText(skill.slug)).trim().length, `${skill.slug} 正文是空的`).toBeGreaterThan(0);
    }
  });

  it('⭐ slug 必须是纯 ascii 小写连字符（要当稳定 skillKey、也要拼进路径）', () => {
    for (const skill of skills) {
      expect(isSafeSlug(skill.slug), `slug 不合法：${skill.slug}`).toBe(true);
    }
    // 反向：目录里真有这么多个技能（避免"一个都没读到"时整段空转通过）
    const dirs = fs.readdirSync(OUR_SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
    expect(skills.length).toBe(dirs.length);
  });

  it('⭐ name 与 description 必须是中文（用户要的汉化；英文残留会露在界面上）', () => {
    const CJK = /[一-鿿]/;
    for (const skill of skills) {
      expect(CJK.test(skill.name ?? ''), `name 不是中文：${skill.name}`).toBe(true);
      expect(CJK.test(skill.description ?? ''), `description 不是中文：${skill.description}`).toBe(true);
    }
  });

  it('⭐ `skillKey` 必须显式写、且**等于 slug**（界面上按它跟 `skills.status` 对号）', () => {
    // 不写 skillKey 时它默认等于 `name`（中文）—— 中文键能跑，但拿它去跟
    // `skills.status` 的条目对号、或在配置里当键，都太脆。
    // 钉成 ascii slug 之后，"装上没有"这件事可以只看目录，不用比名字。
    for (const skill of skills) {
      expect(skill.skillKey, `${skill.slug} 没有显式 skillKey`).toBeTruthy();
      expect(skill.skillKey, `${skill.slug} 的 skillKey 与 slug 不一致`).toBe(skill.slug);
    }
  });

  it('⭐ name 两两不重复（重名会在索引里互相覆盖）', () => {
    const names = skills.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('⭐ description 单行且不过长（要进模型的选择上下文，长了是白烧 token）', () => {
    for (const skill of skills) {
      const line = readSkillText(skill.slug)
        .split('\n')
        .find((l) => l.startsWith('description:'));
      expect(line, `${skill.slug} 的 description 必须是单行`).toBeTruthy();
      expect(skill.description!.length, `${skill.slug} 的 description 太长`).toBeLessThanOrEqual(200);
    }
  });

  it('⭐ 单文件不能超运行时的 256KiB 上限（超了整个技能被丢）', () => {
    for (const skill of skills) {
      const size = fs.statSync(path.join(OUR_SKILLS_DIR, skill.slug, 'SKILL.md')).size;
      expect(size, `${skill.slug} 的 SKILL.md 是 ${size}B`).toBeLessThan(MAX_SKILL_FILE_BYTES);
    }
  });
});
