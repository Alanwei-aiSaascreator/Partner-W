import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OUR_SKILLS_DIR_NAME } from '../src/main/skills/locate.js';

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
 * ## 为什么不用 YAML 库
 *
 * 本仓库没有 YAML 依赖，而"夹具的解析器比运行时宽松 ⇒ 假绿"是踩过的形状。
 * 所以这里**刻意只认我们自己写的那一种形状**（单行 `key: value`），
 * 比运行时**更严**：多行/块标量一律判红，逼着作者回来改成简单形状。
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

/** 剥 UTF-8 BOM —— 运行时的 frontmatter 解析器会剥，这里跟着剥。
 *  ⚠️ 用 `charCodeAt` 比较而不是正则字面量：字面量的 U+FEFF 会被 eslint 的
 *  `no-irregular-whitespace` 判红，而且它在编辑器里**看不见**（改坏了都不知道）。 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

interface ParsedSkill {
  slug: string;
  dir: string;
  body: string;
  frontmatter: string;
  name: string | undefined;
  description: string | undefined;
}

/** 只认"我们自己写的形状"：`---` 起手、单行 `key: value`、`---` 收尾。 */
function parseFrontmatter(text: string): { frontmatter: string; body: string } | null {
  const normalized = stripBom(text).replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const close = normalized.indexOf('\n---', 3);
  if (close === -1) return null;
  return { frontmatter: normalized.slice(4, close + 1), body: normalized.slice(close + 4) };
}

function readSimpleKey(frontmatter: string, key: string): string | undefined {
  const line = frontmatter.split('\n').find((l) => l.startsWith(`${key}:`));
  if (!line) return undefined;
  const value = line.slice(key.length + 1).trim();
  const unquoted = value.replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1');
  return unquoted.trim() || undefined;
}

function loadSkills(): ParsedSkill[] {
  if (!fs.existsSync(OUR_SKILLS_DIR)) return [];
  return fs
    .readdirSync(OUR_SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(OUR_SKILLS_DIR, e.name);
      const file = path.join(dir, 'SKILL.md');
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
      const parsed = parseFrontmatter(text);
      return {
        slug: e.name,
        dir,
        body: parsed?.body ?? '',
        frontmatter: parsed?.frontmatter ?? '',
        name: parsed ? readSimpleKey(parsed.frontmatter, 'name') : undefined,
        description: parsed ? readSimpleKey(parsed.frontmatter, 'description') : undefined,
      };
    });
}

const skills = loadSkills();

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
});

describe('随包技能：内容格式（格式不对 = 运行时静默丢弃）', () => {
  it('技能目录存在且至少带一个技能（空目录会让"技能市场"页面空着）', () => {
    expect(fs.existsSync(OUR_SKILLS_DIR), `缺目录 ${OUR_SKILLS_DIR}`).toBe(true);
    expect(skills.length).toBeGreaterThan(0);
  });

  it('⭐ 每个技能都是 `<slug>/SKILL.md`（少一层、多一层运行时都扫不到）', () => {
    for (const skill of skills) {
      expect(fs.existsSync(path.join(skill.dir, 'SKILL.md')), `${skill.slug} 缺 SKILL.md`).toBe(true);
    }
  });

  it('⭐ 每个技能都有非空的 name 与 description（任一为空 ⇒ 运行时直接丢掉，不报错）', () => {
    for (const skill of skills) {
      expect(skill.frontmatter, `${skill.slug} 的 frontmatter 没解析出来`).not.toBe('');
      expect(skill.name, `${skill.slug} 缺 name`).toBeTruthy();
      expect(skill.description, `${skill.slug} 缺 description`).toBeTruthy();
      expect(skill.body.trim().length, `${skill.slug} 正文是空的（技能没内容）`).toBeGreaterThan(0);
    }
  });

  it('⭐ slug 必须是纯 ascii 小写连字符（要当稳定 skillKey、也要拼进路径）', () => {
    for (const skill of skills) {
      expect(skill.slug, `slug 不合法：${skill.slug}`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('⭐ name 与 description 必须是中文（用户要的汉化；英文残留会露在界面上）', () => {
    const CJK = /[一-鿿]/;
    for (const skill of skills) {
      expect(CJK.test(skill.name ?? ''), `name 不是中文：${skill.name}`).toBe(true);
      expect(CJK.test(skill.description ?? ''), `description 不是中文：${skill.description}`).toBe(true);
    }
  });

  it('⭐ name 两两不重复（重名会在索引里互相覆盖）', () => {
    const names = skills.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('⭐ description 是单行且不过长（要进模型的选择上下文，长了是白烧 token）', () => {
    for (const skill of skills) {
      const line = skill.frontmatter.split('\n').find((l) => l.startsWith('description:'));
      expect(line, `${skill.slug} 的 description 必须是单行`).toBeTruthy();
      expect(skill.description!.length, `${skill.slug} 的 description 太长`).toBeLessThanOrEqual(200);
    }
  });

  it('⭐ 单文件不能超运行时的 256KiB 上限（超了整个技能被丢）', () => {
    for (const skill of skills) {
      const size = fs.statSync(path.join(skill.dir, 'SKILL.md')).size;
      expect(size, `${skill.slug} 的 SKILL.md 是 ${size}B`).toBeLessThan(MAX_SKILL_FILE_BYTES);
    }
  });
});
