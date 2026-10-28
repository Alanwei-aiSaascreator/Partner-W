import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installBundledSkill, readBundledSkills } from '../src/main/skills/bundled.js';

/**
 * 两条"真机实证补丁"的**回归门**（2026-10-08 pre19 收口 · Lead 裁令 R4）。
 *
 * ## 为什么需要这个文件
 *
 * 这两条修复原先**只被数据面验证过、没有任何自动化门拦得住"整块被删"**：
 *   · `our-skills-packaging-gate.test.ts` 只校 frontmatter 的 `name` / `description` 与 SKILL.md 体积；
 *   · `our-skills-bundled.test.ts` 的受控 overlay 断言只查"旧口径没了"，不查"新口径还在"。
 * ⇒ 谁把这两块文本删掉，**全量套件照样全绿**，而真机上退回
 *   「模型调用不存在的工具 / 只写文件不交付 / 宣告成功但用户什么都拿不到」。
 *
 * ⚠️ 本文件刻意**不重复** `our-skills-bundled.test.ts` 里 `P0-A 两层契约` 那组已有的断言
 *    （SLOTS.json ↔ layouts/*.md 逐槽一致性、每个 layout 文件 < 2000 字符、正文 < 8000 等）。
 *    这里补的是它**没覆盖**的三类：
 *      ① **产品可见文本**：FIX-1 的交付纪律块（那边一个字都没查）；
 *      ② **版式索引的数字**：模型靠这一行知道"版式 4 是 12 个槽位"，数字漂了没人拦；
 *      ③ **安装落点**：装进 `managedDir` 的那一份（模型真正看见的载体）是否连 `layouts/` 一起落地。
 *
 * ## 两条修复分别是什么（截至 2026-10-08 09:1x 的真源版本）
 *
 * 1. **FIX-1 交付纪律**（BUG-045，真机复验 PASS）
 *    `document-deck` / `html-deliverable` 各带一个「## ⚠️ 交付纪律」小节：
 *    模型必须把 `docgen` / `htmlgen` 围栏块写进**回复正文**，写文件不算交付。
 *
 * 2. **FIX-2 受控 PPT 两层契约**（BUG-046；2026-10-08 09:07 由 Agent A 由"内联槽位速查"
 *    改版为 P0-A 两层设计——机器契约 `TEMPLATE-DECK-SLOTS.json`(84KB) 归渲染器，
 *    模型只拿正文里的**版式索引** + 按需读 `layouts/layout-NN.md`(每个 <2000 字符)）。
 *    本文件的断言按**改版后**的真实契约写；改版前那版的断言（`Slot quick reference`）
 *    已随实现一并作废。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUR_SKILLS_DIR = path.join(path.resolve(HERE, '..'), 'our-skills');
const NATIVE_SWITCH = 'ROYIN_NATIVE_PPT_VALIDATION';

/** 模型单次 read 的窗口（速查/索引存在的全部理由就是绕开它去读 84KB 的机器契约）。 */
const MODEL_READ_WINDOW_BYTES = 8 * 1024;

const readSkill = (slug: string): string =>
  fs.readFileSync(path.join(OUR_SKILLS_DIR, slug, 'SKILL.md'), 'utf-8').replace(/\r\n/g, '\n');

/** 抠出标题匹配 `heading` 的那一节（含标题行，到下一个 `## ` 之前）。 */
function sectionAt(text: string, heading: RegExp): string | null {
  const m = heading.exec(text);
  if (!m || m.index === undefined) return null;
  const from = m.index;
  const rest = text.slice(from + m[0].length);
  const next = rest.search(/\n## /);
  return next === -1 ? text.slice(from) : text.slice(from, from + m[0].length + next);
}

/** 走真导出路径产出受控正文（不读死文件，而是问代码要 —— 代码不返出去就该红）。 */
function controlledContent(slug: string): string {
  const previous = process.env[NATIVE_SWITCH];
  process.env[NATIVE_SWITCH] = '1';
  try {
    const skill = readBundledSkills(OUR_SKILLS_DIR).find((s) => s.slug === slug);
    expect(skill, `${slug} 没被 readBundledSkills 读出来`).toBeTruthy();
    expect(typeof skill!.content, `${slug} 的 content 不是字符串`).toBe('string');
    return skill!.content!;
  } finally {
    if (previous === undefined) delete process.env[NATIVE_SWITCH];
    else process.env[NATIVE_SWITCH] = previous;
  }
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env[NATIVE_SWITCH];
});

describe('FIX-1 · 随包技能的「⚠️ 交付纪律」块（BUG-045）', () => {
  const CASES = [
    { slug: 'document-deck', tool: 'docgen' },
    { slug: 'html-deliverable', tool: 'htmlgen' },
  ] as const;

  for (const { slug, tool } of CASES) {
    it(`⭐ ${slug}：必须带「## ⚠️ 交付纪律」，且点名 \`${tool}\` 不是工具 / 围栏块才是交付`, () => {
      const block = sectionAt(readSkill(slug), /^##\s*⚠️\s*交付纪律.*$/m);
      expect(block, `${slug} 的 SKILL.md 里找不到「## ⚠️ 交付纪律」小节`).not.toBeNull();
      expect(block!.length, `${slug} 的交付纪律块太短，像是被截断`).toBeGreaterThan(150);

      // ① 不存在名为 `<tool>` 的工具（否则模型会去调一个不存在的工具 —— 真机事故原形）
      expect(block, `${slug} 没有再否认 \`${tool}\` 这个工具`).toMatch(/不存在名为/);
      expect(block, `${slug} 没有再点名 \`${tool}\``).toContain(`\`${tool}\``);

      // ② 唯一交付方式 = 回复正文里的栅栏块
      expect(block, `${slug} 没有再说明"围栏代码块"是唯一交付方式`).toMatch(/围栏代码块|栅栏代码块/);
      expect(block, `${slug} 没有再强调要放在"正文"里`).toContain('正文');

      // ③ 用宣告代替围栏块 = 假成功，会被系统拦下（fail-closed 的用户侧解释）
      expect(block, `${slug} 没有再警告"交付失败/拿不到文件"`).toMatch(/交付失败|拿不到文件/);
      expect(block, `${slug} 没有再点出"假成功"`).toMatch(/假成功/);
    });

    it(`${slug}：纪律块必须排在输出契约之前（模型先读到纪律，再读格式）`, () => {
      const text = readSkill(slug);
      const discipline = text.search(/^##\s*⚠️\s*交付纪律.*$/m);
      const contract = text.search(/^##\s*(输出契约|⚠️\s*先记住这一条)/m);
      expect(discipline).toBeGreaterThan(-1);
      expect(contract).toBeGreaterThan(-1);
      expect(discipline).toBeLessThan(contract);
    });
  }
});

describe('FIX-2 · 受控 PPT 两层契约（BUG-046 / P0-A）', () => {
  it('⭐ 受控正文必须把模型导向 layouts/layout-NN.md，并明令不许读 84KB 机器契约', () => {
    const content = controlledContent('presentation-deck-v2');
    expect(content, '正文没有把模型导向按需读 layout 文件').toContain('layouts/layout-');
    expect(content, '正文没有点名禁止读 TEMPLATE-DECK-SLOTS.json（84KB 超 read 窗口）').toContain(
      'Do not read TEMPLATE-DECK-SLOTS.json',
    );
    expect(content, '正文没有点出机器契约的体积理由').toMatch(/84KB/);
  });

  it('⭐ 版式索引必须是完整 16 项（少一项 = 该版式又变回盲区）', () => {
    const content = controlledContent('presentation-deck-v2');
    const indexLine = content.split('\n').find((line) => line.includes('｜') && /^\s*1\s+\S+\(\d+\)/.test(line));
    expect(indexLine, '受控正文里找不到"版式索引"那一行').toBeTruthy();
    const entries = indexLine!.split('｜').map((e) => e.trim());
    expect(entries.length, `版式索引列了 ${entries.length} 项，应为 16`).toBe(16);
    entries.forEach((entry, i) => {
      expect(entry.startsWith(String(i + 1)), `版式索引第 ${i + 1} 项不是"${i + 1} …"：${entry}`).toBe(true);
    });
  });

  it('⭐ 版式索引里的槽位计数必须精确（4/5/6 号 = 12/14/21 —— 模型靠它决定数组长度）', () => {
    const content = controlledContent('presentation-deck-v2');
    expect(content, '4 三段并列 的槽位数不对').toMatch(/4\s*三段并列[（(]12[）)]/);
    expect(content, '5 四段并列 的槽位数不对').toMatch(/5\s*四段并列[（(]14[）)]/);
    expect(content, '6 两列对比 的槽位数不对').toMatch(/6\s*两列对比[（(]21[）)]/);
    expect(content, '2 目录 的槽位数不对（恒 17 项是硬规则②）').toMatch(/2\s*目录[（(]17[）)]/);
    expect(content, '16 结尾页 的槽位数不对').toMatch(/16\s*结尾页[（(]4[）)]/);
  });

  it('⭐ 硬规则必须在场（全槽非空 / 目录恒 17 / 写完必须真渲染）', () => {
    const content = controlledContent('presentation-deck-v2');
    expect(content).toMatch(/Hard rules/);
    expect(content, '硬规则①「全部槽位非空」丢了').toMatch(/①[^\n]*全部槽位非空/);
    expect(content, '硬规则②「目录恒为 17 项」丢了').toMatch(/②[^\n]*目录恒为 17 项/);
    expect(content, '硬规则③「必须运行 helper 且渲染成功」丢了').toMatch(/③[^\n]*渲染成功/);
  });

  it('⭐ 受控正文必须单窗可读（超了它自己就变成读不到的东西）', () => {
    const content = controlledContent('presentation-deck-v2');
    const bytes = Buffer.byteLength(content, 'utf-8');
    expect(
      bytes,
      `受控正文 ${bytes}B 已超模型 read 窗口 ${MODEL_READ_WINDOW_BYTES}B —— 索引本身就变成读不到的东西了`,
    ).toBeLessThan(MODEL_READ_WINDOW_BYTES);
  });

  it('⭐ 装进 managedDir 的那一份必须连 layouts/ 一起落地（模型真正看见的载体）', () => {
    const managed = fs.mkdtempSync(path.join(os.tmpdir(), 'royin-fix2-gate-'));
    tempDirs.push(managed);
    const expected = controlledContent('presentation-deck-v2');
    const previous = process.env[NATIVE_SWITCH];
    process.env[NATIVE_SWITCH] = '1';
    try {
      expect(installBundledSkill({ root: OUR_SKILLS_DIR, managedDir: managed, slug: 'presentation-deck-v2' }).ok).toBe(
        true,
      );
    } finally {
      if (previous === undefined) delete process.env[NATIVE_SWITCH];
      else process.env[NATIVE_SWITCH] = previous;
    }
    const installedDir = path.join(managed, 'presentation-deck-v2');
    const installed = fs.readFileSync(path.join(installedDir, 'SKILL.md'), 'utf-8');
    expect(installed, '装到盘上的那份没有版式索引 —— 模型还是不知道每个版式多少槽位').toContain('layouts/layout-');
    expect(installed.replace(/\r\n/g, '\n')).toBe(expected);

    // ⚠️ 只装 SKILL.md、不装 layouts/ 是"开发态好好的、装出来模型瞎猜"的经典形状。
    const layouts = fs.readdirSync(path.join(installedDir, 'layouts')).filter((f) => f.endsWith('.md'));
    expect(layouts.length, `装到盘上的 layouts/ 只有 ${layouts.length} 个文件，应为 16`).toBe(16);
    for (let n = 1; n <= 16; n += 1) {
      const file = path.join(installedDir, 'layouts', `layout-${String(n).padStart(2, '0')}.md`);
      expect(fs.existsSync(file), `装到盘上缺 layouts/layout-${String(n).padStart(2, '0')}.md`).toBe(true);
      const bytes = fs.statSync(file).size;
      expect(bytes, `${path.basename(file)} 有 ${bytes}B，超出模型单次 read 窗口`).toBeLessThan(
        MODEL_READ_WINDOW_BYTES,
      );
    }
  });

  it('索引/速查是"注入"不是"写死"：生产（非受控）正文里不许出现它', () => {
    const previous = process.env[NATIVE_SWITCH];
    delete process.env[NATIVE_SWITCH];
    try {
      const production = readBundledSkills(OUR_SKILLS_DIR).find((s) => s.slug === 'presentation-deck-v2')!.content!;
      expect(production, '生产路线也出现了受控版式索引 —— 受控/生产两套口径被混在一起了（R3 边界）').not.toContain(
        'layouts/layout-',
      );
      expect(readSkill('presentation-deck-v2')).not.toContain('layouts/layout-');
    } finally {
      if (previous !== undefined) process.env[NATIVE_SWITCH] = previous;
    }
  });
});
