import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyOwnedSkillUpdate,
  decodeSkillRecord,
  encodeSkillRecord,
  installBundledSkill,
  isBundledSkillInstalled,
  planOwnedUpdate,
  planSkillSync,
  readBundledSkills,
  readSkillFileSha,
  readSkillRecordBaseline,
  removeBundledSkill,
  skillContentSha,
  skillDirManifestSha,
  stageBundledSkillPackage,
  isContainedPath,
  isSafeSlug,
  parseOurSkillFrontmatter,
  resolveInstallDir,
  type ManagedSkillRecordV2,
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

  it('⭐ 只写不删：目标里用户自己放的文件不被清掉（H1 起不再整目录 rmSync）', () => {
    const root = tmpDir();
    const managed = tmpDir();
    writeSkill(root, 'meeting-minutes', { name: '甲', description: '一' });
    const target = path.join(managed, 'meeting-minutes');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '我的笔记.md'), '用户自己放的东西');

    expect(installBundledSkill({ root, managedDir: managed, slug: 'meeting-minutes' })).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(target, '我的笔记.md'), 'utf-8')).toBe('用户自己放的东西');
    expect(isBundledSkillInstalled(managed, 'meeting-minutes')).toBe(true);
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

describe('skillContentSha —— 行尾归一（本仓库 Windows 上真的会不一样）', () => {
  it('CRLF 与 LF 是同一份内容', () => {
    const lf = '第一行' + LF_CHAR + '第二行';
    const crlf = '第一行' + CR_CHAR + LF_CHAR + '第二行';
    expect(skillContentSha(crlf)).toBe(skillContentSha(lf));
  });
});

describe('H1：pkg2 记账编解码（配置是盘上文件 ⇒ 一律按不可信输入校验）', () => {
  const hex = (n: string) => n.repeat(64).slice(0, 64);
  const record: ManagedSkillRecordV2 = {
    version: 2,
    packageSha: hex('a'),
    files: { 'SKILL.md': hex('b'), 'layouts/01.md': hex('c') },
  };
  const raw = (patch: Record<string, unknown>) => 'pkg2:' + JSON.stringify({ ...record, ...patch });

  it('encode ⇒ decode 往返不丢信息', () => {
    expect(encodeSkillRecord(record).startsWith('pkg2:')).toBe(true);
    expect(decodeSkillRecord(encodeSkillRecord(record))).toEqual(record);
  });

  it.each([
    ['不是字符串', 42],
    ['旧裸 sha', hex('b')],
    ['旧 pkg1 口径', `pkg1:${hex('a')}.${hex('b')}`],
    ['不是 JSON', 'pkg2:{不是 json'],
    ['version 不对', raw({ version: 1 })],
    ['packageSha 不是 64 位', raw({ packageSha: 'abc' })],
    ['files 是数组', 'pkg2:' + JSON.stringify({ version: 2, packageSha: hex('a'), files: [] })],
    ['path 是绝对路径', raw({ files: { '/etc/passwd': hex('b') } })],
    ['path 带 ..', raw({ files: { 'layouts/../SKILL.md': hex('b') } })],
    ['Windows 反斜杠', raw({ files: { 'layouts\\01.md': hex('b') } })],
    ['盘符前缀', raw({ files: { 'C:/x.md': hex('b') } })],
    ['段尾点（NTFS 会把它吃掉）', raw({ files: { 'layouts/01.md.': hex('b') } })],
    // ⚠️ 手写 JSON 文本：对象字面量里的 `__proto__:` 不建属性，只会被忽略（测不到那条判据）。
    ['__proto__ 段', `pkg2:{"version":2,"packageSha":"${hex('a')}","files":{"__proto__":"${hex('b')}"}}`],
    ['文件 sha 不是 64 位', raw({ files: { 'SKILL.md': 'nope' } })],
  ])('拒绝 %s', (_name, value) => {
    expect(decodeSkillRecord(value)).toBeNull();
  });

  it('readSkillRecordBaseline：v2 / 旧裸 sha / 旧 pkg1 都读得出，垃圾归 none', () => {
    expect(readSkillRecordBaseline(encodeSkillRecord(record))).toEqual({ kind: 'v2', record });
    expect(readSkillRecordBaseline(hex('b'))).toEqual({ kind: 'legacy', skillSha: hex('b') });
    expect(readSkillRecordBaseline(`pkg1:${hex('a')}.${hex('b')}`)).toEqual({ kind: 'legacy', skillSha: hex('b') });
    expect(readSkillRecordBaseline('pkg1:坏')).toEqual({ kind: 'none' });
    expect(readSkillRecordBaseline(undefined)).toEqual({ kind: 'none' });
  });
});

/**
 * ⭐ H1 的差分计划：**只在已证明来源的基线上动文件**。
 *
 * 旧口径（`staleBundledSkills`）的形状是"盘上 SKILL.md 一致 + 随包变了 ⇒ 整目录覆盖"，
 * 两个真机后果都是事故：用户改过的 layouts/scripts 被冲掉；"认领"把旧辅助文件
 * 记成最新包之后，随包更新永远不再触发。这里逐条把这些性质钉死。
 */
describe('H1：planOwnedUpdate —— 差分而不是整目录覆盖', () => {
  const hex = (n: string) => n.repeat(64).slice(0, 64);
  const A = hex('a'),
    B = hex('b'),
    C = hex('c'),
    D = hex('d');
  const previous: ManagedSkillRecordV2 = {
    version: 2,
    packageSha: hex('e'),
    files: { 'SKILL.md': A, 'scripts/generate.cjs': B },
  };
  const read = (state: Record<string, string | null>) => (relativePath: string) => state[relativePath] ?? null;

  it('盘上与基线逐字一致、随包也没变 ⇒ 空差分（只刷新记录）', () => {
    expect(
      planOwnedUpdate(
        previous,
        { 'SKILL.md': A, 'scripts/generate.cjs': B },
        read({ 'SKILL.md': A, 'scripts/generate.cjs': B }),
      ),
    ).toEqual({ kind: 'update', write: [], remove: [] });
  });

  it('⭐ 随包只改了辅助文件（BUG-052 的传播缺口）⇒ 写那一个，别的都不碰', () => {
    expect(
      planOwnedUpdate(
        previous,
        { 'SKILL.md': A, 'scripts/generate.cjs': C },
        read({ 'SKILL.md': A, 'scripts/generate.cjs': B }),
      ),
    ).toEqual({ kind: 'update', write: ['scripts/generate.cjs'], remove: [] });
  });

  it('⭐ 用户改过辅助文件 ⇒ 冲突，整个计划作废（不覆盖、也不部分应用）', () => {
    expect(
      planOwnedUpdate(
        previous,
        { 'SKILL.md': A, 'scripts/generate.cjs': C },
        read({ 'SKILL.md': A, 'scripts/generate.cjs': D }),
      ),
    ).toEqual({ kind: 'conflict', paths: ['scripts/generate.cjs'], reason: 'user-modified' });
  });

  it('⭐⭐ 用户改过 SKILL.md ⇒ 冲突（本机制存在的理由：一个字节都不碰）', () => {
    expect(
      planOwnedUpdate(
        previous,
        { 'SKILL.md': C, 'scripts/generate.cjs': B },
        read({ 'SKILL.md': D, 'scripts/generate.cjs': B }),
      ),
    ).toEqual({ kind: 'conflict', paths: ['SKILL.md'], reason: 'user-modified' });
  });

  it('基线文件被删掉 ⇒ 同样按"被动过"处理（自动流程不替用户补回来）', () => {
    expect(planOwnedUpdate(previous, { 'SKILL.md': A, 'scripts/generate.cjs': B }, read({ 'SKILL.md': A }))).toEqual({
      kind: 'conflict',
      paths: ['scripts/generate.cjs'],
      reason: 'user-modified',
    });
  });

  it('厂商新增的文件撞上用户文件 ⇒ 冲突（不许覆盖用户放的东西）', () => {
    expect(
      planOwnedUpdate(
        previous,
        { 'SKILL.md': A, 'scripts/generate.cjs': B, 'layouts/01.md': C },
        read({ 'SKILL.md': A, 'scripts/generate.cjs': B, 'layouts/01.md': D }),
      ),
    ).toEqual({ kind: 'conflict', paths: ['layouts/01.md'], reason: 'user-modified' });
  });

  it('厂商已删且没被动过 ⇒ 进删除清单；用户自己的额外文件永远不会进', () => {
    expect(
      planOwnedUpdate(
        previous,
        { 'SKILL.md': A },
        read({ 'SKILL.md': A, 'scripts/generate.cjs': B, '我的笔记.md': D }),
      ),
    ).toEqual({ kind: 'update', write: [], remove: ['scripts/generate.cjs'] });
  });

  it('⚠️ 读不动（fileSha 抛）⇒ 计划整体失败，绝不把"读不了"当成"没有"', () => {
    expect(() =>
      planOwnedUpdate(previous, { 'SKILL.md': A }, () => {
        throw new Error('EACCES');
      }),
    ).toThrow('EACCES');
  });
});

/**
 * ⭐ H1 的迁移四态：无账/旧账的盘怎么走。
 *
 * 旧口径只有一条 SKILL.md 指纹：它能证明 SKILL.md，**证明不了辅助文件**
 * （layouts/scripts 的来路）。所以"凭什么认领""凭什么升级"必须分开：
 *  · 全包与当前包逐字一致 ⇒ 认领（记真实基线，不写盘）；
 *  · 旧账且 SKILL.md 仍是我们的（辅助文件盘上不存在）⇒ 差分升级（把新增文件补进来）；
 *  · 旧账但盘上留着辅助文件 / 无账且不一致 ⇒ **具名冲突**，保留现场。
 */
describe('H1：planSkillSync —— 无账 / 旧账的迁移四态', () => {
  const hex = (n: string) => n.repeat(64).slice(0, 64);
  const A = hex('a'),
    B = hex('b'),
    C = hex('c');
  const nextFiles = { 'SKILL.md': A, 'layouts/01.md': B };
  const installed = (state: Record<string, string | null>, skillSha: string | null) => ({
    skillSha,
    fileSha: (relativePath: string) => state[relativePath] ?? null,
  });

  it('v2 记录 + 随包版本一致 ⇒ unchanged（不重装、不白覆盖）', () => {
    expect(
      planSkillSync({
        packageSha: hex('e'),
        nextFiles,
        recorded: encodeSkillRecord({ version: 2, packageSha: hex('e'), files: nextFiles }),
        installed: installed({ ...nextFiles }, null),
      }),
    ).toEqual({ kind: 'unchanged' });
  });

  it('① 无账、但盘上每个受管理文件都与当前包逐字一致 ⇒ adopt（只认领真实装后基线，不写盘）', () => {
    expect(
      planSkillSync({
        packageSha: hex('e'),
        nextFiles,
        recorded: undefined,
        installed: installed({ ...nextFiles }, null),
      }),
    ).toEqual({ kind: 'adopt', record: { version: 2, packageSha: hex('e'), files: nextFiles } });
  });

  it('① 认领允许用户额外文件存在，但不把它们认领成厂商文件', () => {
    const plan = planSkillSync({
      packageSha: hex('e'),
      nextFiles,
      recorded: undefined,
      installed: installed({ ...nextFiles, '我的笔记.md': C }, null),
    });
    expect(plan.kind).toBe('adopt');
    expect(Object.keys((plan as { record: ManagedSkillRecordV2 }).record.files)).toEqual(['SKILL.md', 'layouts/01.md']);
  });

  it('⭐⭐ REVIEW 反例：无账 + SKILL.md 一致但辅助文件不同 ⇒ 不许认领（认领=把旧辅助文件记成最新包）', () => {
    expect(
      planSkillSync({
        packageSha: hex('e'),
        nextFiles,
        recorded: undefined,
        installed: installed({ 'SKILL.md': A, 'layouts/01.md': C }, null),
      }),
    ).toEqual({ kind: 'conflict', paths: ['layouts/01.md'], reason: 'unverified-origin' });
  });

  it('旧账（裸 sha）+ SKILL.md 一致 + 盘上没有辅助文件 ⇒ 差分升级（新增文件补进来，顺势迁到 v2）', () => {
    expect(
      planSkillSync({
        packageSha: hex('e'),
        nextFiles,
        recorded: A,
        installed: installed({ 'SKILL.md': A }, A),
      }),
    ).toEqual({ kind: 'update', write: ['layouts/01.md'], remove: [] });
  });

  it('旧账 + SKILL.md 一致 + 盘上留着辅助文件 ⇒ 具名冲突（不能凭 SKILL 一致认证辅助文件）', () => {
    expect(
      planSkillSync({
        packageSha: hex('e'),
        nextFiles,
        recorded: A,
        installed: installed({ 'SKILL.md': A, 'layouts/01.md': C }, A),
      }),
    ).toEqual({ kind: 'conflict', paths: ['layouts/01.md'], reason: 'unverified-origin' });
  });

  it('旧账 + SKILL.md 被改过 ⇒ user-modified（用户修改保护原样保留）', () => {
    expect(
      planSkillSync({
        packageSha: hex('e'),
        nextFiles,
        recorded: A,
        installed: installed({ 'SKILL.md': C }, C),
      }),
    ).toEqual({ kind: 'conflict', paths: ['SKILL.md'], reason: 'user-modified' });
  });

  it('pkg1 旧账同样只认证 SKILL.md（取第二个部件）', () => {
    expect(
      planSkillSync({
        packageSha: hex('e'),
        nextFiles,
        recorded: `pkg1:${hex('d')}.${A}`,
        installed: installed({ 'SKILL.md': A }, A),
      }),
    ).toEqual({ kind: 'update', write: ['layouts/01.md'], remove: [] });
  });

  it('无账且与当前包不一致 ⇒ unverified-origin 冲突（保留现场，留给用户的修复出口）', () => {
    expect(
      planSkillSync({
        packageSha: hex('e'),
        nextFiles,
        recorded: '坏配置',
        installed: installed({ 'SKILL.md': C }, C),
      }),
    ).toEqual({ kind: 'conflict', paths: ['SKILL.md', 'layouts/01.md'], reason: 'unverified-origin' });
  });
});

/**
 * ⭐ H1 的写路径（真实目录真跑）：备份核验 → 差分应用 → 全清单核验 → 失败回滚。
 */
describe('H1：applyOwnedSkillUpdate —— 备份、差分、回滚、链接守卫', () => {
  const hex = (n: string) => n.repeat(64).slice(0, 64);
  const writePackage = (root: string, slug: string, files: Record<string, string>): void => {
    for (const [rel, body] of Object.entries(files)) {
      const target = path.join(root, slug, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
    }
  };
  const stage = (bundleRoot: string, slug: string) => {
    const staged = stageBundledSkillPackage({ root: bundleRoot, slug });
    if (!staged.ok) throw new Error(staged.error);
    return staged.staged;
  };
  const PACKAGE: Record<string, string> = {
    'SKILL.md': '---\nname: deck\ndescription: x\n---\n\n正文。\n',
    'scripts/generate.cjs': 'v1\n',
    'layouts/01.md': '版式一\n',
  };
  /** 一对"随包根 + 已装目录"（已装 = 旧版内容的整目录拷贝）。 */
  const pair = () => {
    const bundledRoot = tmpDir();
    const managedDir = tmpDir();
    writePackage(bundledRoot, 'deck', PACKAGE);
    writePackage(managedDir, 'deck', PACKAGE);
    return { bundledRoot, managedDir };
  };
  const baselineOf = (target: string, relativePaths: readonly string[]) =>
    Object.fromEntries(relativePaths.map((relativePath) => [relativePath, readSkillFileSha(target, relativePath)]));

  it('⭐ 随包只改了脚本 ⇒ 只写那一个；用户额外文件与运行时附加文件原样保留', () => {
    const { bundledRoot, managedDir } = pair();
    fs.writeFileSync(path.join(bundledRoot, 'deck', 'scripts', 'generate.cjs'), 'v2\n');
    const target = path.join(managedDir, 'deck');
    fs.writeFileSync(path.join(target, '我的笔记.md'), '用户自己放的');
    fs.writeFileSync(path.join(target, 'scripts', 'generate-runtime.json'), '{"schemaVersion":1}');
    const staged = stage(bundledRoot, 'deck');
    // 记账 = 装下去那一刻的整份受管理清单（三条都要在，少一条就会被当成"用户新增的文件"）。
    const previous: ManagedSkillRecordV2 = {
      version: 2,
      packageSha: hex('e'),
      files: Object.fromEntries(
        ['SKILL.md', 'scripts/generate.cjs', 'layouts/01.md'].map((rel) => [rel, readSkillFileSha(target, rel)!]),
      ),
    };
    const plan = planOwnedUpdate(previous, staged.files, (relativePath) => readSkillFileSha(target, relativePath));
    expect(plan).toEqual({ kind: 'update', write: ['scripts/generate.cjs'], remove: [] });

    const write = (plan as { write: string[] }).write;
    expect(
      applyOwnedSkillUpdate({
        stagedDir: staged.dir,
        managedDir,
        slug: 'deck',
        files: staged.files,
        write,
        remove: [],
        baseline: baselineOf(target, write),
      }),
    ).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(target, 'scripts', 'generate.cjs'), 'utf8')).toBe('v2\n');
    expect(fs.readFileSync(path.join(target, '我的笔记.md'), 'utf8')).toBe('用户自己放的');
    expect(fs.readFileSync(path.join(target, 'scripts', 'generate-runtime.json'), 'utf8')).toBe('{"schemaVersion":1}');
    staged.cleanup();
  });

  it('⭐ 厂商删掉的文件进删除清单并被清理（空目录一并收掉）', () => {
    const { bundledRoot, managedDir } = pair();
    fs.rmSync(path.join(bundledRoot, 'deck', 'layouts'), { recursive: true });
    const target = path.join(managedDir, 'deck');
    const staged = stage(bundledRoot, 'deck');
    const applied = applyOwnedSkillUpdate({
      stagedDir: staged.dir,
      managedDir,
      slug: 'deck',
      files: staged.files,
      write: [],
      remove: ['layouts/01.md'],
      baseline: { 'layouts/01.md': readSkillFileSha(target, 'layouts/01.md') },
    });
    expect(applied).toEqual({ ok: true });
    expect(fs.existsSync(path.join(target, 'layouts'))).toBe(false);
    staged.cleanup();
  });

  it('⚠️ 应用前基线对不上（计划之后盘上又变了）⇒ 停手，一个字节都不写', () => {
    const { bundledRoot, managedDir } = pair();
    fs.writeFileSync(path.join(bundledRoot, 'deck', 'SKILL.md'), '新版 SKILL\n');
    const target = path.join(managedDir, 'deck');
    const staged = stage(bundledRoot, 'deck');
    const applied = applyOwnedSkillUpdate({
      stagedDir: staged.dir,
      managedDir,
      slug: 'deck',
      files: staged.files,
      write: ['SKILL.md'],
      remove: [],
      baseline: { 'SKILL.md': hex('f') }, // 与盘上不符
    });
    expect(applied).toEqual({ ok: false, error: 'skill-baseline-changed' });
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe(PACKAGE['SKILL.md']);
    staged.cleanup();
  });

  it('⚠️ 装后核验不过 ⇒ 全量回滚：覆盖的拷回、新写的删掉', () => {
    const { bundledRoot, managedDir } = pair();
    fs.writeFileSync(path.join(bundledRoot, 'deck', 'SKILL.md'), '新版 SKILL\n');
    fs.writeFileSync(path.join(bundledRoot, 'deck', 'layouts', '02.md'), '新增版式\n');
    const target = path.join(managedDir, 'deck');
    const staged = stage(bundledRoot, 'deck');
    const applied = applyOwnedSkillUpdate({
      stagedDir: staged.dir,
      managedDir,
      slug: 'deck',
      files: { ...staged.files, 'SKILL.md': hex('f') }, // 期望值被写坏 ⇒ 核验必红
      write: ['SKILL.md', 'layouts/02.md'],
      remove: [],
      baseline: { 'SKILL.md': readSkillFileSha(target, 'SKILL.md'), 'layouts/02.md': null },
    });
    expect(applied.ok).toBe(false);
    expect(applied.error).toContain('skill-install-verify-failed');
    // 覆盖过的拷回旧内容，新写出来的删掉 —— 盘上必须回到应用之前。
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toBe(PACKAGE['SKILL.md']);
    expect(fs.existsSync(path.join(target, 'layouts', '02.md'))).toBe(false);
    staged.cleanup();
  });

  it('⭐ 链接守卫：盘上把受管理目录换成了 junction/symlink ⇒ 拒绝写，链接外面一个字节都不动', () => {
    const { bundledRoot, managedDir } = pair();
    const outside = tmpDir();
    fs.writeFileSync(path.join(outside, '重要文件.md'), '别动我');
    fs.rmSync(path.join(managedDir, 'deck', 'layouts'), { recursive: true });
    fs.symlinkSync(
      outside,
      path.join(managedDir, 'deck', 'layouts'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const staged = stage(bundledRoot, 'deck');

    const applied = applyOwnedSkillUpdate({
      stagedDir: staged.dir,
      managedDir,
      slug: 'deck',
      files: staged.files,
      write: Object.keys(staged.files),
      remove: [],
      baseline: null,
    });
    expect(applied.ok).toBe(false);
    expect(applied.error).toContain('skill-path-link-blocked');
    expect(fs.readFileSync(path.join(outside, '重要文件.md'), 'utf8')).toBe('别动我');
    expect(fs.existsSync(path.join(outside, '01.md'))).toBe(false);
    // 守卫在**备份阶段**就拒绝（写之前）：盘上那份 SKILL.md 一个字节都不该被动过。
    expect(fs.readFileSync(path.join(managedDir, 'deck', 'SKILL.md'), 'utf8')).toBe(PACKAGE['SKILL.md']);
    staged.cleanup();
    // 清理前先摘掉 junction，别让递归删除顺着链接走（项目红线同款纪律）。
    fs.rmSync(path.join(managedDir, 'deck', 'layouts'), { recursive: true, force: true });
  });

  it('skillDirManifestSha：文件内容变 / 多一个文件 / 少一个文件都会变（读不动的目录 ⇒ null）', () => {
    const { managedDir } = pair();
    const dir = path.join(managedDir, 'deck');
    const before = skillDirManifestSha(dir);
    expect(before).not.toBeNull();
    fs.writeFileSync(path.join(dir, 'layouts', '01.md'), '改过\n');
    const contentChanged = skillDirManifestSha(dir);
    expect(contentChanged).not.toBe(before);
    fs.writeFileSync(path.join(dir, 'layouts', '02.md'), '新增\n');
    expect(skillDirManifestSha(dir)).not.toBe(contentChanged);
    fs.rmSync(path.join(dir, 'layouts', '02.md'));
    expect(skillDirManifestSha(dir)).toBe(contentChanged);
    expect(skillDirManifestSha(path.join(managedDir, '不存在'))).toBeNull();
  });
});

describe('controlled native PPT skill overlay', () => {
  it('replaces competing PPT guidance while preserving production source and other document formats', () => {
    const root = path.join(import.meta.dirname, '../our-skills');
    const slugs = ['presentation-deck-v2', 'deck-layout', 'document-deck'];
    const original = slugs.map((slug) => fs.readFileSync(path.join(root, slug, 'SKILL.md'), 'utf8'));
    const managed = tmpDir();
    const previous = process.env.ROYIN_NATIVE_PPT_VALIDATION;
    process.env.ROYIN_NATIVE_PPT_VALIDATION = '1';
    try {
      const controlled = readBundledSkills(root);
      const native = controlled.find((skill) => skill.slug === 'presentation-deck-v2')!;
      expect(native.description).toContain('Controlled fixed slot PPT generation');
      expect(native.content).not.toContain('\u4ec5\u7528\u6237\u660e\u786e\u6307\u5b9a');
      expect(native.content).not.toContain('```docgen');
      const helper = controlled.find((skill) => skill.slug === 'deck-layout')!;
      expect(helper.content).toContain('.native-ppt.json');
      expect(helper.content).not.toContain(
        '\u8fd9\u662f**\u62ff\u7ed9\u4eba\u770b\u7684\u6f14\u793a\u7684\u9ed8\u8ba4\u8def\u7ebf**',
      );
      const docs = controlled.find((skill) => skill.slug === 'document-deck')!;
      expect(docs.description).toContain('presentation-deck-v2');
      expect(docs.content).toContain('"kind": "docx"');
      expect(docs.content).toContain('"kind": "xlsx"');
      expect(docs.content).not.toContain('"kind": "pptx"');
      expect(docs.content).not.toMatch(/\u4e00(?:\u4efd|\u9875)\s*PPT.*Word/u);
      // 2026-10-08 \u9a8c\u6536\u5b9e\u6d4b\uff1a\u683c\u5f0f\u5df2\u660e\u786e\u65f6\u6a21\u578b\u4ecd\u53cd\u95ee \u2192 \u8be5\u7eaa\u5f8b\u884c\u987b\u5728\u53d7\u63a7\u66ff\u6362\u540e\u539f\u6837\u4fdd\u7559\u3002
      expect(docs.content).toContain('\u4e0d\u8981\u518d\u7528\u786e\u8ba4\u95ee\u9898\u91cd\u95ee\u683c\u5f0f');
      for (const [index, slug] of slugs.entries()) {
        expect(installBundledSkill({ root, managedDir: managed, slug }).ok).toBe(true);
        const installed = fs.readFileSync(path.join(managed, slug, 'SKILL.md'), 'utf8');
        expect(skillContentSha(installed)).toBe(
          skillContentSha(controlled.find((skill) => skill.slug === slug)!.content!),
        );
        expect(fs.readFileSync(path.join(root, slug, 'SKILL.md'), 'utf8')).toBe(original[index]);
      }
      delete process.env.ROYIN_NATIVE_PPT_VALIDATION;
      for (const [index, slug] of slugs.entries())
        expect(readBundledSkills(root).find((skill) => skill.slug === slug)!.content).toBe(original[index]);
    } finally {
      if (previous === undefined) delete process.env.ROYIN_NATIVE_PPT_VALIDATION;
      else process.env.ROYIN_NATIVE_PPT_VALIDATION = previous;
    }
  });

  it('installs the controlled contract with the same fingerprint only under the test switch', () => {
    const root = tmpDir(),
      managed = tmpDir();
    writeSkill(root, 'presentation-deck-v2', { name: 'Deck', description: 'PPT' });
    const source = fs.readFileSync(path.join(root, 'presentation-deck-v2', 'SKILL.md'), 'utf8');
    delete process.env.ROYIN_NATIVE_PPT_VALIDATION;
    expect(readBundledSkills(root)[0].content).toBe(source);
    process.env.ROYIN_NATIVE_PPT_VALIDATION = '1';
    try {
      expect(installBundledSkill({ root, managedDir: managed, slug: 'presentation-deck-v2' }).ok).toBe(true);
      const installed = fs.readFileSync(path.join(managed, 'presentation-deck-v2', 'SKILL.md'), 'utf8');
      expect(installed).toContain('TEMPLATE-DECK.md');
      expect(installed, '受控口径只有一个契约：不许再把 business-deck-v5 教给模型').not.toContain('business-deck-v5');
      expect(installed).toContain('.native-ppt.json');
      expect(skillContentSha(installed)).toBe(skillContentSha(readBundledSkills(root)[0].content!));
      expect(fs.readFileSync(path.join(root, 'presentation-deck-v2', 'SKILL.md'), 'utf8')).toBe(source);
    } finally {
      delete process.env.ROYIN_NATIVE_PPT_VALIDATION;
    }
  });
});

describe('fixed slot template controlled Skill', () => {
  it('selects the slot contract only when both validation switches are enabled', () => {
    const root = path.join(import.meta.dirname, '../our-skills');
    const oldA = process.env.ROYIN_NATIVE_PPT_VALIDATION,
      oldSlots = process.env.ROYIN_TEMPLATE_DECK_VALIDATION;
    process.env.ROYIN_NATIVE_PPT_VALIDATION = '1';
    process.env.ROYIN_TEMPLATE_DECK_VALIDATION = '1';
    try {
      const skill = readBundledSkills(root).find((s) => s.slug === 'presentation-deck-v2')!;
      expect(skill.content).toContain('TEMPLATE-DECK.md');
      expect(skill.content).not.toContain('CONTROLLED-VALIDATION.md');
      expect(skill.content).not.toContain('business-deck-v5');
      const helper = readBundledSkills(root).find((s) => s.slug === 'deck-layout')!;
      expect(helper.content).toContain('TEMPLATE-DECK.md');
      delete process.env.ROYIN_NATIVE_PPT_VALIDATION;
      expect(readBundledSkills(root).find((s) => s.slug === 'presentation-deck-v2')!.content).toBe(
        fs.readFileSync(path.join(root, 'presentation-deck-v2/SKILL.md'), 'utf8'),
      );
    } finally {
      if (oldA === undefined) delete process.env.ROYIN_NATIVE_PPT_VALIDATION;
      else process.env.ROYIN_NATIVE_PPT_VALIDATION = oldA;
      if (oldSlots === undefined) delete process.env.ROYIN_TEMPLATE_DECK_VALIDATION;
      else process.env.ROYIN_TEMPLATE_DECK_VALIDATION = oldSlots;
    }
  });
});

describe('controlled PPT contract split（P0-A 两层契约：机器契约 + 模型速查）', () => {
  const root = path.join(import.meta.dirname, '../our-skills');
  const slotsPath = path.join(root, 'presentation-deck-v2', 'TEMPLATE-DECK-SLOTS.json');
  type EditableSlot = { role: string; editable: boolean; max_chars: number; font_size_pt: number };
  type SlotPage = { slide_number: number; text_slots: EditableSlot[]; chart?: { kind: string } };

  function withControlled<T>(read: () => T): T {
    const previous = process.env.ROYIN_NATIVE_PPT_VALIDATION;
    process.env.ROYIN_NATIVE_PPT_VALIDATION = '1';
    try {
      return read();
    } finally {
      if (previous === undefined) delete process.env.ROYIN_NATIVE_PPT_VALIDATION;
      else process.env.ROYIN_NATIVE_PPT_VALIDATION = previous;
    }
  }

  it('16 个 layout 速查文件与 SLOTS.json 槽位逐条一致，且每个都在单次 read 窗口内', () => {
    const slots = JSON.parse(fs.readFileSync(slotsPath, 'utf8')) as { pages: SlotPage[] };
    expect(slots.pages).toHaveLength(16);
    for (const page of slots.pages) {
      const n = page.slide_number;
      const file = path.join(root, 'presentation-deck-v2', 'layouts', `layout-${String(n).padStart(2, '0')}.md`);
      expect(fs.existsSync(file), `缺 ${path.basename(file)}`).toBe(true);
      const text = fs.readFileSync(file, 'utf8');
      // read 工具单窗 = 2000 行（内核 DEFAULT_MAX_LINES=2e3，offset 为行偏移）。速查文件
      //   只几十行必在一窗内；这里是防膨胀的**宽松界**（非窗口口径）。
      // 2026-10-08 BUG-053② 重标 2000→2400：示例换成可照抄的合法内容后，layout-13
      //   （26 槽位原生表格，天然最长的一版）约 2130 字符——是合法内容，不该被代理界挡在
      //   门外（该界在原交付快照里已被 layout-13 越过 = 本就是红的）。真实窗口界=每个文件
      //   < 8192B，钉在 our-skills-fix-regression-gate.test.ts；这条只防"翻倍式膨胀"。
      expect(text.length, `layout-${String(n).padStart(2, '0')}.md 超出宽松界`).toBeLessThan(2400);
      const editable = page.text_slots.filter((s) => s.editable);
      expect(text).toContain(`共 ${editable.length} 个槽位`);
      for (const slot of editable) {
        expect(text, `layout-${n} 缺角色 ${slot.role}`).toContain(slot.role);
        expect(text, `layout-${n} 缺 max_chars ${slot.max_chars}`).toContain(String(slot.max_chars));
        expect(text, `layout-${n} 缺 font_size_pt ${slot.font_size_pt}`).toContain(String(slot.font_size_pt));
      }
      if (page.chart) expect(text, `layout-${n} 缺图表要求`).toContain('chart');
      expect(text, '缺禁止项').toContain('禁止');
      expect(text, '缺溢出行为').toContain('不缩字号');
    }
  });

  it('受控正文不再让模型读 84KB 机器契约，只按需读所选 layout 文件', () => {
    withControlled(() => {
      const skill = readBundledSkills(root).find((s) => s.slug === 'presentation-deck-v2')!;
      expect(skill.description).not.toContain('Read TEMPLATE-DECK.md and TEMPLATE-DECK-SLOTS.json');
      const body = skill.content!;
      expect(body, '正文仍含旧指令「先读两个文件」').not.toMatch(
        /Read TEMPLATE-DECK\.md and TEMPLATE-DECK-SLOTS\.json/,
      );
      expect(body, '正文没有把模型导向按需读 layout 文件').toContain('layouts/layout-');
      expect(body, '正文没有点名禁止读 84KB 机器契约').toContain('Do not read TEMPLATE-DECK-SLOTS.json');
      expect(body, '正文必须保留三条硬规则').toContain('全部槽位非空');
      expect(body, '正文必须保留目录 17 项硬规则').toContain('目录恒为 17 项');
      expect(body.length, '受控正文整体必须单窗可读').toBeLessThan(8000);
    });
  });

  it('版式索引计数钉满 16/16（与 SLOTS.json 逐条一致，防速查与机器契约漂移）', () => {
    const slots = JSON.parse(fs.readFileSync(slotsPath, 'utf8')) as { pages: SlotPage[] };
    const names: Record<number, string> = {
      1: '封面',
      2: '目录',
      3: '章节过渡',
      4: '三段并列',
      5: '四段并列',
      6: '两列对比',
      7: '三列对比',
      8: '三步递进',
      9: '时间线',
      10: '柱状数据',
      11: '折线趋势',
      12: 'KPI看板',
      13: '原生表格',
      14: '层级结构',
      15: '编号清单',
      16: '结尾页',
    };
    withControlled(() => {
      const body = readBundledSkills(root).find((s) => s.slug === 'presentation-deck-v2')!.content!;
      for (const page of slots.pages) {
        const n = page.slide_number;
        const count = page.text_slots.filter((s) => s.editable).length;
        const chartTag = page.chart ? '+chart' : '';
        expect(body, `索引缺 layout ${n} 条目`).toContain(`${n} ${names[n]}(${count}${chartTag})`);
      }
    });
  });

  it('deck-layout 受控正文不再含 {baseDir} 占位，改成自定位指引', () => {
    withControlled(() => {
      const helper = readBundledSkills(root).find((s) => s.slug === 'deck-layout')!;
      expect(helper.content, '真机实证：网关不替换 {baseDir}，模型拿着占位符瞎找路径').not.toContain('{baseDir}');
      expect(helper.content).toContain('scripts/generate.cjs');
    });
  });
});
