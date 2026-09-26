import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installBundledSkill,
  isBundledSkillInstalled,
  skillContentSha,
  staleBundledSkills,
  isContainedPath,
  isSafeSlug,
  parseOurSkillFrontmatter,
  readBundledSkills,
  removeBundledSkill,
  resolveInstallDir,
} from '../src/main/skills/bundled.js';

/**
 * 随包技能的**读写逻辑**（T-a2 A2-2）。
 *
 * 这一层不碰 electron、不碰网关 —— 根目录由调用方给，所以能用临时目录真跑
 * 「装一次、再装一次、卸掉」这些路径，包括**路径逃逸**那条。
 */

/** ⚠️ BOM 用 `String.fromCharCode` 造：字面量的 U+FEFF 会被 eslint 的
 *  `no-irregular-whitespace` 判红，而且在编辑器里**看不见**。 */
const BOM = String.fromCharCode(0xfeff);

const temps: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'our-skills-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

function writeSkill(root: string, slug: string, body: { name: string; description: string; emoji?: string }): void {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir, { recursive: true });
  const meta = body.emoji ? `\nmetadata: { 'openclaw': { 'emoji': '${body.emoji}' } }` : '';
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${body.name}\ndescription: '${body.description}'${meta}\n---\n\n正文。\n`,
  );
}

describe('parseOurSkillFrontmatter', () => {
  it('正常形状：name / description / emoji / skillKey 都取得到', () => {
    const parsed = parseOurSkillFrontmatter(
      `---\nname: 会议纪要整理\ndescription: '把会议记录整理成结构化纪要'\nmetadata: { 'openclaw': { 'emoji': '📝', 'skillKey': 'meeting-minutes' } }\n---\n\n正文\n`,
    );
    expect(parsed).toEqual({
      name: '会议纪要整理',
      description: '把会议记录整理成结构化纪要',
      emoji: '📝',
      skillKey: 'meeting-minutes',
    });
  });

  it('metadata 写成多行嵌套也认（人写的时候常是那样）', () => {
    const parsed = parseOurSkillFrontmatter(
      `---\nname: 甲\ndescription: 乙\nmetadata:\n  {\n    "openclaw":\n      { "emoji": "🧪", "skillKey": "jia" },\n  }\n---\n正文\n`,
    );
    expect(parsed?.emoji).toBe('🧪');
    expect(parsed?.skillKey).toBe('jia');
  });

  it('双引号也一样；BOM 与 CRLF 都容忍（运行时那边也会先规范化）', () => {
    const text = `${BOM}---\r\nname: 甲\r\ndescription: "乙"\r\n---\r\n\r\n正文\r\n`;
    const parsed = parseOurSkillFrontmatter(text);
    expect(parsed?.name).toBe('甲');
    expect(parsed?.description).toBe('乙');
  });

  it('⭐ 块标量（description: |）判为无效 —— 本模块刻意只认单行形状', () => {
    expect(parseOurSkillFrontmatter(`---\nname: 甲\ndescription: |\n  多行\n---\n正文\n`)).toBeNull();
    expect(parseOurSkillFrontmatter(`---\nname: 甲\ndescription: >\n  折叠\n---\n正文\n`)).toBeNull();
  });

  it('没起手 `---` 或没闭合 ⇒ null（运行时对这两种都是丢掉）', () => {
    expect(parseOurSkillFrontmatter(`name: 甲\ndescription: 乙\n`)).toBeNull();
    expect(parseOurSkillFrontmatter(`---\nname: 甲\ndescription: 乙\n`)).toBeNull();
  });

  it('name/description 缺一 ⇒ 各自 undefined（由调用方决定算不算错）', () => {
    expect(parseOurSkillFrontmatter(`---\ndescription: 乙\n---\n正文\n`)).toEqual({
      name: undefined,
      description: '乙',
      emoji: undefined,
    });
  });
});

describe('readBundledSkills', () => {
  it('读目录并把 frontmatter 里的字段提出来，按 slug 排序（顺序稳定才好测/好显示）', () => {
    const root = tmpDir();
    writeSkill(root, 'zzz', { name: '乙', description: '后一个' });
    writeSkill(root, 'aaa', { name: '甲', description: '前一个', emoji: '🅰️' });

    const skills = readBundledSkills(root);
    expect(skills.map((s) => s.slug)).toEqual(['aaa', 'zzz']);
    expect(skills[0]).toMatchObject({ name: '甲', description: '前一个', emoji: '🅰️' });
  });

  it('根目录不存在 / 是 undefined ⇒ 空数组，不抛（打包漏了不该让界面崩）', () => {
    expect(readBundledSkills(undefined)).toEqual([]);
    expect(readBundledSkills(path.join(tmpDir(), 'nope'))).toEqual([]);
  });

  it('⭐ 缺 name 或 description 的技能**照读出来**（由内容闸判红，而不是悄悄过滤掉）', () => {
    // 悄悄过滤会让"格式写错了"表现成"这个技能我没写" —— 作者永远发现不了。
    const root = tmpDir();
    writeSkill(root, 'good', { name: '甲', description: '好的' });
    fs.mkdirSync(path.join(root, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(root, 'broken', 'SKILL.md'), `---\nname: 乙\n---\n正文\n`);

    const skills = readBundledSkills(root);
    expect(skills.map((s) => s.slug)).toEqual(['broken', 'good']);
    expect(skills[0].description).toBeUndefined();
  });

  it('目录里混着非技能文件/目录也不炸', () => {
    const root = tmpDir();
    writeSkill(root, 'good', { name: '甲', description: '好的' });
    fs.writeFileSync(path.join(root, 'README.md'), '不是技能');

    expect(readBundledSkills(root).map((s) => s.slug)).toEqual(['good']);
  });
});

describe('isSafeSlug —— 白名单式校验（这是防路径逃逸的唯一一道）', () => {
  it.each(['meeting-minutes', 'a', 'a1', 'a-b-c'])('接受 %s', (slug) => {
    expect(isSafeSlug(slug)).toBe(true);
  });

  it.each(['', '..', '.', 'a/b', 'a\\b', '../evil', 'A', 'a b', '-a', 'a-', 'a--b', '甲'])('拒绝 %s', (slug) => {
    expect(isSafeSlug(slug)).toBe(false);
  });

  it('拒绝非字符串', () => {
    expect(isSafeSlug(undefined)).toBe(false);
    expect(isSafeSlug(42)).toBe(false);
    expect(isSafeSlug({ toString: () => 'evil' })).toBe(false);
  });
});

describe('resolveInstallDir —— 逃逸必须在这里就被挡住', () => {
  // ⚠️ 必须是**绝对**路径：`resolveInstallDir` 内部会 `path.resolve`，
  //    拿 `\state\skills` 这种盘符相对的路径当夹具，期望值会和实际值差一个盘符
  //    （这条一开始就是被这个夹具坑红的 —— 错的是夹具，不是实现）。
  const MANAGED = path.join(os.tmpdir(), 'our-skills-fixture', 'state', 'skills');

  it('正常 slug 拼在 managedDir 下', () => {
    expect(resolveInstallDir(MANAGED, 'meeting-minutes')).toBe(path.join(MANAGED, 'meeting-minutes'));
  });

  it('⭐ `..` 拼出来的路径必须**解析后仍然在 managedDir 里**，否则拒绝', () => {
    for (const evil of ['..', '../evil', '..\\evil', '../../Windows']) {
      expect(resolveInstallDir(MANAGED, evil)).toBeNull();
    }
  });

  it('正常 slug 解析出的是**绝对路径**（供调用方直接喂给 fs）', () => {
    const outside = resolveInstallDir(MANAGED, 'ok');
    expect(outside).not.toBeNull();
    expect(path.isAbsolute(outside!)).toBe(true);
    expect(path.relative(MANAGED, outside!)).toBe('ok');
  });
});

describe('isContainedPath —— 第二道防线（够不着，但必须单独钉住）', () => {
  // ⚠️ 为什么要单独测：能走到 `resolveInstallDir` 第二道的 slug 都先过了 `isSafeSlug`，
  //    而 `isSafeSlug` 已经不允许 `..`/分隔符 ⇒ **通过公开入口喂不进对抗性输入**。
  //    所以它被单独导出，直接喂。第一版这里写了个"够不着"的兜底断言
  //    （拿安全 slug 去断言结果正常）—— 那条**删掉第二道也照样绿**，是假绿。
  const BASE = path.join(os.tmpdir(), 'our-skills-fixture', 'skills');

  it.each([
    path.join('..', 'evil'),
    path.join('..', '..', 'evil'),
    path.join('..', '..', '..', 'Windows'),
    `${'..'}${path.sep}evil${path.sep}deep`,
    path.resolve(BASE),
  ])('拒绝 %s', (target) => {
    expect(isContainedPath(BASE, path.join(BASE, target))).toBe(false);
  });

  it('拒绝绝对路径（换个盘符也不行）', () => {
    expect(isContainedPath(BASE, path.resolve(os.tmpdir(), 'elsewhere', 'evil'))).toBe(false);
  });

  it('拒绝"多下一层"（只允许恰好一个目录名）', () => {
    expect(isContainedPath(BASE, path.join(BASE, 'a', 'b'))).toBe(false);
  });

  it('接受恰好下一层', () => {
    expect(isContainedPath(BASE, path.join(BASE, 'meeting-minutes'))).toBe(true);
  });

  it('拒绝 base 自己（"装到目录本身"没有意义，删掉就是删整个技能库）', () => {
    expect(isContainedPath(BASE, BASE)).toBe(false);
  });
});

describe('装 / 卸', () => {
  it('装一次：文件到位；再装一次不报错（幂等，覆盖旧的）', () => {
    const root = tmpDir();
    const managed = tmpDir();
    writeSkill(root, 'meeting-minutes', { name: '甲', description: '一' });

    expect(installBundledSkill({ root, managedDir: managed, slug: 'meeting-minutes' })).toEqual({ ok: true });
    expect(fs.existsSync(path.join(managed, 'meeting-minutes', 'SKILL.md'))).toBe(true);
    expect(isBundledSkillInstalled(managed, 'meeting-minutes')).toBe(true);

    // 改一下源再装一次 ⇒ 装的是新的那一份
    writeSkill(root, 'meeting-minutes', { name: '甲', description: '改过' });
    expect(installBundledSkill({ root, managedDir: managed, slug: 'meeting-minutes' })).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(managed, 'meeting-minutes', 'SKILL.md'), 'utf-8')).toContain('改过');
  });

  it('⭐ 装不存在于随包目录的 slug ⇒ 失败（不允许拿界面传来的名字去读任意路径）', () => {
    const root = tmpDir();
    const managed = tmpDir();
    writeSkill(root, 'meeting-minutes', { name: '甲', description: '一' });

    const res = installBundledSkill({ root, managedDir: managed, slug: '../evil' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('非法');

    // ⚠️ 必须断言**报的是哪一句**，不能只断言 `ok === false` ——
    //    第一版就是这么写的，于是"不查源存不存在"这个变异**存活**了：
    //    少了那道检查，`cpSync` 自己会抛，`ok` 照样是 false，测试照样绿。
    //    那是"因为别的原因恰好失败"，与被测的行为无关。
    const notShipped = installBundledSkill({ root, managedDir: managed, slug: 'not-shipped' });
    expect(notShipped.ok).toBe(false);
    expect(notShipped.error).toContain('随包目录里没有这个技能');
  });

  it('卸一个：目录消失；卸不存在的 slug 不报错（幂等）', () => {
    const managed = tmpDir();
    writeSkill(managed, 'meeting-minutes', { name: '甲', description: '一' });

    expect(removeBundledSkill({ managedDir: managed, slug: 'meeting-minutes' })).toEqual({ ok: true });
    expect(isBundledSkillInstalled(managed, 'meeting-minutes')).toBe(false);
    expect(removeBundledSkill({ managedDir: managed, slug: 'meeting-minutes' })).toEqual({ ok: true });
  });

  it('⭐ 卸载也只删 managedDir 下的那个目录 —— 路径逃逸一律拒绝', () => {
    const managed = tmpDir();
    const outsider = tmpDir();
    writeSkill(outsider, 'victim', { name: '甲', description: '一' });

    const res = removeBundledSkill({ managedDir: managed, slug: `../${path.basename(outsider)}/victim` });
    expect(res.ok).toBe(false);
    expect(fs.existsSync(path.join(outsider, 'victim', 'SKILL.md'))).toBe(true);
  });

  it('managedDir 拿不到 ⇒ 明确失败，不是静默成功', () => {
    const root = tmpDir();
    writeSkill(root, 'meeting-minutes', { name: '甲', description: '一' });
    const res = installBundledSkill({ root, managedDir: undefined, slug: 'meeting-minutes' });
    expect(res.ok).toBe(false);
  });
});

/**
 * ⭐ 「老盘拿不到新技能」的第二层：**磁盘上的内容旧了**。
 *
 * `missingBundledSkills` 只管"**缺了才补**"，它自己那段注释也写明了
 * "我们的 SKILL.md 更新了怎么办，是**另一个决定**"。这里补的就是那个决定 ——
 * 判据只有一条：**随包内容与已装内容不一致**。
 *
 * 真机形状（2026-09-26，盘 E: 0.0.35）：技能文件手工换成了新版（含 PDF 段），
 * 而助手照旧「环境限制…没法直接生成 PDF」——因为磁盘这一层根本没被升级过。
 */
/**
 * ⚠️ 行尾用**字符码**拼，不写转义序列 —— 往这个文件里写 `\r\n` 这类东西已经栽过三次
 *    （`\` 穿过多层工具后变成真实控制字符，文件当场编不过）。
 */
const LF_CHAR = String.fromCharCode(10);
const CR_CHAR = String.fromCharCode(13);

describe('staleBundledSkills —— 该升级的那些（判据三条全中）', () => {
  const bundled = (slug: string, content: string) => ({ slug, name: slug, description: '', content }) as never;
  const sha = (c: string) => skillContentSha(c);

  it('① 已装 ② 盘上那份正是我们装的 ③ 随包更新了 ⇒ 升级', () => {
    const skills = [bundled('a', '新版正文')];
    expect(
      staleBundledSkills(
        skills,
        () => '旧版正文',
        () => sha('旧版正文'),
      ).map((s) => s.slug),
    ).toEqual(['a']);
  });

  /**
   * ⭐⭐ **这条是整件事存在的理由。**
   *
   * 只比内容的话，"用户/运行时改过"会被当成"我们放旧了"，于是**每次开机都把他的修改冲掉**
   * —— 正是 `missingBundledSkills` 的注释里点名警告过的那个后果。
   * 所以判据里必须有"盘上那份**还是我们装下去的那份**"这一条（指纹对得上）。
   */
  it('⭐⭐ 别人改过（盘上那份不是我们装的）⇒ 一个字节都不碰', () => {
    const skills = [bundled('a', '新版正文')];
    expect(
      staleBundledSkills(
        skills,
        () => '用户或运行时改过的内容',
        () => sha('旧版正文'),
      ),
    ).toEqual([]);
  });

  it('随包那份与装下去那份一样 ⇒ 没什么可升的', () => {
    const skills = [bundled('a', '同一份')];
    expect(
      staleBundledSkills(
        skills,
        () => '同一份',
        () => sha('同一份'),
      ),
    ).toEqual([]);
  });

  it('⚠️ 没有记账（老盘第一次跑这一版）⇒ 不动（保守方向）', () => {
    const skills = [bundled('a', '新版正文')];
    expect(
      staleBundledSkills(
        skills,
        () => '旧版正文',
        () => null,
      ),
    ).toEqual([]);
  });

  it('**没装**的不算旧（那是 missingBundledSkills 的事，两条路各管各的）', () => {
    const skills = [bundled('a', '新正文')];
    expect(
      staleBundledSkills(
        skills,
        () => null,
        () => sha('旧版正文'),
      ),
    ).toEqual([]);
  });

  it('⚠️ 行尾差异不算内容不同：CRLF 与 LF 是同一份（本仓库 Windows 上真的会不一样）', () => {
    const lf = '第一行' + LF_CHAR + '第二行';
    const crlf = '第一行' + CR_CHAR + LF_CHAR + '第二行';
    expect(skillContentSha(crlf)).toBe(skillContentSha(lf));
    expect(
      staleBundledSkills(
        [bundled('a', lf)],
        () => crlf,
        () => skillContentSha(lf),
      ),
    ).toEqual([]);
  });

  it('随包 content 缺失（SKILL.md 读不出来）⇒ **不算旧**，绝不用坏源覆盖好盘', () => {
    const skills = [{ slug: 'a', name: 'a', description: '' } as never];
    expect(
      staleBundledSkills(
        skills,
        () => '盘上是好的',
        () => sha('盘上是好的'),
      ),
    ).toEqual([]);
  });

  it('只挑该升的那些，别的两样都不动（半装状态也各归各的）', () => {
    const skills = [bundled('a', '同'), bundled('b', '新'), bundled('c', '同'), bundled('d', '新')];
    const onDisk: Record<string, string | null> = { a: '同', b: '旧', c: '改过', d: null };
    const recorded: Record<string, string | null> = {
      a: sha('同'),
      b: sha('旧'),
      c: sha('原来那份'),
      d: sha('旧'),
    };
    expect(
      staleBundledSkills(
        skills,
        (slug) => onDisk[slug] ?? null,
        (slug) => recorded[slug] ?? null,
      ).map((s) => s.slug),
    ).toEqual(['b']);
  });
});
