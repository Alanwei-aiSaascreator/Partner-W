import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STATE_LINK_KINDS,
  classifyStateLink,
  isUnderRoot,
  openclawPeerLinkNeeded,
  probeStateLinks,
  rewriteLinkTarget,
  runStateLinksSelfCheck,
  type LinkProbeFacts,
} from '../src/main/runtime/state-links-selfcheck.js';

/**
 * 「启动自检坏链」—— 网关侧**没有** `plugin-skills\*` 的修复路径（第十刀读代码结论：
 * 重建判据是 `fs.readlinkSync(linkPath) === target` 的**字符串比较**，盘符变了之后
 * 两边"恰好还相等" ⇒ 直接 `continue`；唯一例外是解析不出根时把条目删掉）。
 * managed npm 那侧也只在"检查点过期"时才修（第十刀实测）。
 *
 * ⇒ 我们自己探 + 我们自己修，但**修得很窄**：
 *   · 只动"是链接且目标不存在"的条目（悬空）—— 真目录/真文件**绝不碰**；
 *   · 换根后的目标**必须在盘上真的存在**才写（不猜）；
 *   · 修不了要**说出来**（以前只有一句 log.warn）。
 *
 * ⚠️ 本文件里凡是"实测"三个字，都是本机 2026-09-20 在临时目录里量过的（不是读代码推的）：
 *   建 junction 后 `readlink` 拿到绝对目标串；删掉目标后 `lstat.symlink=true` / `readlink`
 *   仍出旧串 / `stat` 抛 ENOENT；**`unlinkSync(链接)` 只掉链接，目标目录与其内容一字不动**；
 *   悬空 junction 的 `unlink` 不报 EPERM；`symlinkSync(target, link, 'junction')` 可重建。
 */

const EXT_SKILL_SUFFIX = join(
  'node_modules',
  'openclaw',
  'dist',
  'extensions',
  'browser',
  'skills',
  'browser-automation',
);

/** 探针事实（与诊断工具 `classifyLink` 的入参同形）。 */
const facts = (o: Partial<LinkProbeFacts> = {}): LinkProbeFacts => ({
  lstat: { exists: false },
  readlink: null,
  stat: { ok: false, code: 'ENOENT' },
  ...o,
});

describe('classifyStateLink —— 判据与诊断工具同一套（漂移由本文件的词表守卫盯着）', () => {
  const expectedRoot = 'C:\\u\\runtime\\deployed\\KEY2';

  it('⭐ 悬空（盘符变了 / 盘上那份没了）：lstat 是链接、readlink 有串、跟随 stat ENOENT', () => {
    const r = classifyStateLink(
      facts({
        lstat: { exists: true, symlink: true, dir: false },
        readlink: 'C:\\u\\runtime\\deployed\\KEY1\\node_modules\\openclaw',
        stat: { ok: false, code: 'ENOENT' },
      }),
      { expectedRoot, needed: true },
    );
    expect(r.kind).toBe('dangling');
    expect(r.target).toContain('KEY1'); // 目标串要留下来 —— 修复全靠它
  });

  it('活的目标 + 在当前运行时下 ⇒ ok', () => {
    const r = classifyStateLink(
      facts({
        lstat: { exists: true, symlink: true, dir: false },
        readlink: join(expectedRoot, 'node_modules', 'openclaw'),
        stat: { ok: true, dir: true },
      }),
      { expectedRoot, needed: true },
    );
    expect(r.kind).toBe('ok');
  });

  it('⭐ 活着但指到别处 ⇒ elsewhere（不修：网关自己会按字符串比较重建这条，见第十刀）', () => {
    const r = classifyStateLink(
      facts({
        lstat: { exists: true, symlink: true, dir: false },
        readlink: 'C:\\u\\runtime\\deployed\\KEY1\\node_modules\\openclaw',
        stat: { ok: true, dir: true },
      }),
      { expectedRoot, needed: true },
    );
    expect(r.kind).toBe('elsewhere');
  });

  it('⭐ 真目录 ⇒ real-dir（"整目录拷过来的盘"常见；**绝不能删**——里面是真技能文件）', () => {
    const r = classifyStateLink(facts({ lstat: { exists: true, symlink: false, dir: true } }), {
      expectedRoot,
      needed: true,
    });
    expect(r.kind).toBe('real-dir');
  });

  it('链接指向的不是目录 ⇒ real-file（照工具那套）', () => {
    const r = classifyStateLink(
      facts({
        lstat: { exists: true, symlink: true, dir: false },
        readlink: 'C:\\u\\some\\file.txt',
        stat: { ok: true, dir: false },
      }),
      { expectedRoot, needed: true },
    );
    expect(r.kind).toBe('real-file');
  });

  it('⭐ "这里什么都没有"分三档，别混成一个（混了会报假警报）：', () => {
    // 技能链是网关自己建的 ⇒ 少了就是"还没建"，**不是故障**
    expect(classifyStateLink(facts(), { expectedRoot, needed: true }).kind).toBe('not-created');
    // 项目没声明 openclaw 依赖 ⇒ 本来就不需要这条链
    expect(classifyStateLink(facts(), { expectedRoot, needed: false }).kind).toBe('not-needed');
    // 读不到项目的 package.json ⇒ 判不了（不许当成 false）
    expect(classifyStateLink(facts(), { expectedRoot, needed: null }).kind).toBe('unknown');
  });

  it('词表本身要被钉住（漂移守卫读的就是它）', () => {
    expect([...STATE_LINK_KINDS].sort()).toEqual(
      ['dangling', 'elsewhere', 'not-created', 'not-needed', 'ok', 'real-dir', 'real-file', 'unknown'].sort(),
    );
  });
});

describe('isUnderRoot —— 盘符大小写不敏感，但不能被"前缀恰好相同"骗', () => {
  it('同盘不同大小写算在里面', () => {
    expect(isUnderRoot('c:\\u\\runtime\\deployed\\KEY2\\node_modules', 'C:\\u\\runtime\\deployed\\KEY2')).toBe(true);
  });
  it('⭐ `…\\KEY2x` 不算在 `…\\KEY2` 里面（前缀陷阱）', () => {
    expect(isUnderRoot('C:\\u\\runtime\\deployed\\KEY2x\\node_modules', 'C:\\u\\runtime\\deployed\\KEY2')).toBe(false);
  });
  it('别处/子串都不算', () => {
    expect(isUnderRoot('D:\\other\\runtime\\deployed\\KEY2\\x', 'C:\\u\\runtime\\deployed\\KEY2')).toBe(false);
  });
});

describe('openclawPeerLinkNeeded —— 判据照抄网关（peerDependencies.openclaw 或 dependencies.openclaw）', () => {
  it('dependencies.openclaw ⇒ 需要', () => {
    expect(openclawPeerLinkNeeded({ dependencies: { openclaw: '^1.0.0' } })).toEqual({
      needed: true,
      declaration: 'dependencies',
    });
  });
  it('peerDependencies.openclaw ⇒ 需要（优先报 peer）', () => {
    expect(openclawPeerLinkNeeded({ peerDependencies: { openclaw: '1.2.3' } })).toEqual({
      needed: true,
      declaration: 'peerDependencies',
    });
  });
  it('没有声明 ⇒ 不需要（这条不判，没声明依赖的项目会被报成坏链 —— 工具那边实测报过 2 条假警报）', () => {
    expect(openclawPeerLinkNeeded({ dependencies: { lodash: '^4' } })).toEqual({ needed: false, declaration: null });
  });
  it('空串不算声明；读不出来 ⇒ null（判不了，不许当 false）', () => {
    expect(openclawPeerLinkNeeded({ dependencies: { openclaw: '' } })).toEqual({ needed: false, declaration: null });
    expect(openclawPeerLinkNeeded(null)).toEqual({ needed: null, declaration: null });
  });
});

describe('rewriteLinkTarget —— 只换根前缀，后缀逐字不动（不猜路径）', () => {
  const newRoot = 'E:\\mofang\\data\\runtime\\deployed\\KEY2';

  it('⭐ 技能链：后缀从 `node_modules\\openclaw\\…` 起原样保留', () => {
    const old = `C:\\Users\\x\\AppData\\Roaming\\@clawwork\\desktop\\runtime\\deployed\\KEY1\\${EXT_SKILL_SUFFIX}`;
    const r = rewriteLinkTarget(old, newRoot);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toBe(join(newRoot, EXT_SKILL_SUFFIX));
  });

  it('⭐ managed npm 那条链（目标就是 …\\node_modules\\openclaw）也能换', () => {
    const r = rewriteLinkTarget('C:\\u\\runtime\\deployed\\KEY1\\node_modules\\openclaw', newRoot);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toBe(join(newRoot, 'node_modules', 'openclaw'));
  });

  it('⭐ 目标里出现两次锚点时取**第一次**（留更长后缀 ⇒ "换过去存不存在"这道校验才更严）', () => {
    const old = 'C:\\old\\deployed\\KEY1\\node_modules\\openclaw\\dist\\x\\node_modules\\openclaw';
    const r = rewriteLinkTarget(old, newRoot);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.target).toBe(join(newRoot, 'node_modules', 'openclaw', 'dist', 'x', 'node_modules', 'openclaw'));
    }
  });

  it('锚点**大小写不敏感**，但后缀逐字保留原样（Windows 上 NODE_MODULES 也是同一段）', () => {
    const r = rewriteLinkTarget('C:\\old\\deployed\\KEY1\\NODE_MODULES\\OpenClaw\\dist', newRoot);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.target).toBe(join(newRoot, 'NODE_MODULES', 'OpenClaw', 'dist'));
  });

  it('⭐ 找不到锚点 ⇒ **拒绝**（宁可报"修不了"，也不猜一个路径出来）', () => {
    const r = rewriteLinkTarget('C:\\temp\\random\\thing', newRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain('锚点');
  });

  it('本来就在当前运行时下 ⇒ 不用改（幂等：第二次跑不许再动它）', () => {
    const r = rewriteLinkTarget(join(newRoot, 'node_modules', 'openclaw'), newRoot);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain('已经');
  });
});

describe('probeStateLinks + runStateLinksSelfCheck —— 真文件系统（临时目录，仓库外）', () => {
  let root: string;
  let stateDir: string;
  let curRoot: string; // 正在用的那份运行时
  let oldRoot: string; // 盘符变过 / 上一份（**不存在**：悬空就是这么来的）
  let skillsLink: string;

  /** 在 `<runtimeRoot>` 下造出网关会建的那种目标（后缀 + 目录）。 */
  const makeRuntime = (runtimeRoot: string) => {
    fs.mkdirSync(join(runtimeRoot, 'node_modules', 'openclaw'), { recursive: true });
    fs.mkdirSync(join(runtimeRoot, EXT_SKILL_SUFFIX), { recursive: true });
  };

  /**
   * ⚠️ 清树**先摘链接再删目录**（本机实测：`unlinkSync(链接)` 只掉链接、目标一字不动；
   * 而对"含 junction 的树"直接 `rmSync(recursive)` 是我不肯做的那件事）。
   */
  const cleanupTree = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        fs.unlinkSync(p);
      } else if (e.isDirectory()) {
        cleanupTree(p);
      } else {
        fs.unlinkSync(p);
      }
    }
    fs.rmdirSync(dir);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'clawwork-links-'));
    stateDir = join(root, 'openclaw-state');
    curRoot = join(root, 'runtime', 'deployed', 'KEY2');
    oldRoot = join(root, 'runtime', 'deployed', 'KEY1');
    skillsLink = join(stateDir, 'plugin-skills', 'browser-automation');

    makeRuntime(curRoot);
    fs.mkdirSync(join(stateDir, 'plugin-skills'), { recursive: true });
    // 悬空链接：指向一份**不存在**的运行时（= 盘符变过/盘上那份没了）
    fs.symlinkSync(join(oldRoot, EXT_SKILL_SUFFIX), skillsLink, 'junction');
  });

  afterEach(() => {
    cleanupTree(root);
  });

  it('探：一条悬空 + 一条活的 + 一条真目录，各自分对桶', () => {
    const okLink = join(stateDir, 'plugin-skills', 'canvas');
    fs.symlinkSync(join(curRoot, 'node_modules', 'openclaw'), okLink, 'junction');
    const realDir = join(stateDir, 'plugin-skills', 'handmade');
    fs.mkdirSync(realDir);

    const found = probeStateLinks({ stateDir, deployedRoot: curRoot });
    const byName = new Map(found.map((f) => [f.path, f.kind]));

    expect(found).toHaveLength(3);
    expect(byName.get(skillsLink)).toBe('dangling');
    expect(byName.get(okLink)).toBe('ok');
    expect(byName.get(realDir)).toBe('real-dir');
  });

  it('探：managed npm 那侧按**项目自己的 package.json** 判"该不该有"', () => {
    const projects = join(stateDir, 'npm', 'projects');
    const need = join(projects, 'p-need');
    const ignore = join(projects, 'p-ignore');
    fs.mkdirSync(need, { recursive: true });
    fs.mkdirSync(ignore, { recursive: true });
    fs.writeFileSync(join(need, 'package.json'), JSON.stringify({ dependencies: { openclaw: '^1' } }));
    fs.writeFileSync(join(ignore, 'package.json'), JSON.stringify({ dependencies: { lodash: '^4' } }));

    const found = probeStateLinks({ stateDir, deployedRoot: curRoot });
    const byPath = new Map(found.map((f) => [f.path, f.kind]));

    expect(byPath.get(join(need, 'node_modules', 'openclaw'))).toBe('not-created');
    // ⭐ 这条是防假警报的：没声明 openclaw 依赖的项目，本来就不该有这条链
    expect(byPath.get(join(ignore, 'node_modules', 'openclaw'))).toBe('not-needed');
  });

  it('⭐ 修：悬空 + 换根后目标存在 ⇒ 链接指回当前运行时，且**能跟随**了', () => {
    const res = runStateLinksSelfCheck({ stateDir, deployedRoot: curRoot });

    expect(res.repaired).toBe(1);
    expect(res.failures).toEqual([]);
    expect(res.broken).toBe(1);
    const now = fs.readlinkSync(skillsLink);
    expect(isUnderRoot(now, curRoot)).toBe(true);
    expect(fs.statSync(skillsLink).isDirectory()).toBe(true); // 真的活了（不是只把串改了）
  });

  it('⭐ 修不了就不动它 + **说出来**：换根后的目标也不存在 ⇒ 一个字节都不改', () => {
    // 把当前运行时里那个目标删掉 ⇒ "换过去"也是空的
    fs.rmSync(join(curRoot, EXT_SKILL_SUFFIX), { recursive: true, force: true });
    const before = fs.readlinkSync(skillsLink);

    const res = runStateLinksSelfCheck({ stateDir, deployedRoot: curRoot });

    expect(res.repaired).toBe(0);
    expect(res.failures).toHaveLength(1);
    expect(res.failures[0].path).toBe(skillsLink);
    expect(res.failures[0].reason).toContain('不存在'); // 人话：为什么没修
    expect(res.summary).toContain('修不了 1 条'); // 摘要里也要能看出来
    expect(fs.readlinkSync(skillsLink)).toBe(before); // 没被动过
  });

  it('⭐ 真目录**绝不碰**（里面是真文件；"删了重建"是能丢数据的动作）', () => {
    const realDir = join(stateDir, 'plugin-skills', 'handmade');
    fs.mkdirSync(realDir);
    fs.writeFileSync(join(realDir, 'SKILL.md'), 'payload');

    const res = runStateLinksSelfCheck({ stateDir, deployedRoot: curRoot });

    expect(fs.existsSync(join(realDir, 'SKILL.md'))).toBe(true);
    expect(fs.lstatSync(realDir).isSymbolicLink()).toBe(false);
    expect(res.repaired).toBe(1); // 只修了那条悬空的
    expect(res.failures).toEqual([]); // ⭐ 真目录**连"试着修"都不该进**（进了就会报"修不了"，误导）
    expect(res.stillBroken.map((f) => f.path)).toContain(realDir); // 但要说出来
    expect(res.summary).toContain('不归我们动的'); // 摘要里也要能看出来
  });

  it('⭐ **指到别处的活链**也不动（网关自己会按字符串比较重建这条 —— 第十刀；动了反而是抢它的活）', () => {
    // 造一份"上一版运行时还在盘上"的形态：目标是活的，但不是当前这份
    // ⚠️ 用 KEY0（不是 KEY1）：KEY1 正是上面那条悬空链接指向的目录，重建它会把悬空变活
    const stale = join(root, 'runtime', 'deployed', 'KEY0');
    makeRuntime(stale);
    const elsewhereLink = join(stateDir, 'plugin-skills', 'canvas');
    fs.symlinkSync(join(stale, 'node_modules', 'openclaw'), elsewhereLink, 'junction');
    const before = fs.readlinkSync(elsewhereLink);

    const res = runStateLinksSelfCheck({ stateDir, deployedRoot: curRoot });

    expect(fs.readlinkSync(elsewhereLink)).toBe(before); // 一个字节没改
    expect(res.repaired).toBe(1); // 只修了那条悬空的
    expect(res.failures).toEqual([]); // 也没把它算成"修不了"
    expect(res.stillBroken.map((f) => f.kind)).toContain('elsewhere'); // 但要报出来
  });

  it('幂等：修好之后第二次跑，repaired=0、failures=0', () => {
    runStateLinksSelfCheck({ stateDir, deployedRoot: curRoot });
    const again = runStateLinksSelfCheck({ stateDir, deployedRoot: curRoot });
    expect(again.repaired).toBe(0);
    expect(again.failures).toEqual([]);
    expect(again.broken).toBe(0);
  });

  it('⭐ 软失败：state 目录根本不存在也不抛（启动路径上抛 = 白屏）', () => {
    const res = runStateLinksSelfCheck({ stateDir: join(root, 'nope'), deployedRoot: curRoot });
    expect(res.checked).toBe(0);
    expect(res.repaired).toBe(0);
    expect(res.notes.join('\n')).toContain('plugin-skills'); // 说清"这里没有"
  });

  it('自检结果自带一句能写进日志/界面的人话', () => {
    const res = runStateLinksSelfCheck({ stateDir, deployedRoot: curRoot });
    expect(res.summary).toContain('1');
    expect(typeof res.summary).toBe('string');
  });
});
