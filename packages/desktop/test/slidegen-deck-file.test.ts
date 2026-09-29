import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { extractSlidegenBlocks } from '../src/main/slidegen/blocks';
import {
  captureDeckFileBaseline,
  changedDeckFiles,
  decksFromFiles,
  deckFileNoFenceFailure,
  isDeckFileName,
  readDeckSources,
  DECK_FILE_MAX_BYTES,
} from '../src/main/slidegen/deck-file';

/**
 * **把整份版面写成工作区里的一个文件** —— 这条路是 2026-09-28 定的。
 *
 * ## 为什么不再走聊天正文
 *
 * 随包网关把**单条消息**截在 8,000 字符（`truncateChatHistoryText`），于是"整份写进回复里"
 * 在真机上**四次都死在 8,000**：围栏没有结尾 ⇒ 客户端整份丢掉。
 *
 * 而**写文件拿得到全文** —— 这不是推断：真机那份 `sept_briefing.slidegen.jsx`
 * 在盘上是 **13,052 字节、结尾完整**，同一条回复的正文却被切在 8,000。
 *
 * ## 这份测试钉的是什么
 *
 * 三条边界，都是**会静默**的那几条：
 *  1. 文件名认 `.slidegen` 的**各种写法** —— 真机那份叫 `x.slidegen.jsx`，
 *     只认精确扩展名会**恰好漏掉我们手上唯一一份成功样本**。
 *  2. "新的"按 **size 或 mtime** 判 —— 同名覆盖也必须算新的，否则重写一遍不生效。
 *  3. ⭐ **文件读了却一份 deck 都没解析出来、失败列表也是空 ⇒ 必须报错。**
 *     这条正对着我们刚修完的那类静默：`extractSlidegenBlocks` 只认闭合围栏，
 *     文件里没围栏时它既不进 `decks` 也不进 `failures`，上层两个分支都不进 ⇒
 *     产物空、日志空、界面说"已完成"。
 */

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mofang-deck-file-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** 一份最小的、**带闭合围栏**的 deck（文件里照旧带围栏，这与真机模型的行为一致）。 */
const DECK = ['```slidegen', '// title: 九月简报', '<Slide>', '  <Text>你好</Text>', '</Slide>', '```', ''].join('\n');

describe('isDeckFileName —— 认「文件名里含 .slidegen」的每一种写法', () => {
  it('⭐ 真机那份叫 x.slidegen.jsx —— 只认精确扩展名就会漏掉它', () => {
    expect(isDeckFileName('sept_briefing.slidegen.jsx')).toBe(true);
  });

  it('x.slidegen / x.slidegen.txt 也收', () => {
    expect(isDeckFileName('课件.slidegen')).toBe(true);
    expect(isDeckFileName('x.slidegen.txt')).toBe(true);
  });

  it('大小写不敏感（Windows 上模型会写出 .SLIDEGEN）', () => {
    expect(isDeckFileName('A.SLIDEGEN.JSX')).toBe(true);
  });

  it('负对照：不含 `.slidegen` 的名字一律不认（别把整个工作区当 deck）', () => {
    for (const name of ['notes.md', 'slidegen.md', 'slidegen', 'a.jsx', 'slides.json', '']) {
      expect(isDeckFileName(name), `${name} 不该被认成 deck 文件`).toBe(false);
    }
  });
});

describe('新文件怎么判 —— 按 size / mtime，同名覆盖也算', () => {
  it('新增一个 .slidegen 文件 ⇒ 算新的', () => {
    const root = makeRoot();
    const before = captureDeckFileBaseline(root);
    writeFileSync(join(root, 'a.slidegen'), DECK);
    expect(changedDeckFiles(before ?? {}, root)).toEqual(['a.slidegen']);
  });

  it('⭐ 同名覆盖、内容变了 ⇒ 也必须算新的（否则重写一遍不生效）', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.slidegen'), DECK);
    const before = captureDeckFileBaseline(root);
    writeFileSync(join(root, 'a.slidegen'), `${DECK}\n<!-- 又加了一页 -->\n`);
    expect(changedDeckFiles(before ?? {}, root)).toEqual(['a.slidegen']);
  });

  it('size 一样、mtime 变了 ⇒ 也算新的（内容改了但正好同样长）', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.slidegen'), 'AAAA');
    const before = captureDeckFileBaseline(root);
    writeFileSync(join(root, 'a.slidegen'), 'BBBB');
    // 同一毫秒内可能 mtime 不变 —— 显式把基线里的 mtime 改旧，模拟"上一轮写的"
    const baseline = { ...(before ?? {}) };
    if (baseline['a.slidegen']) baseline['a.slidegen'] = { ...baseline['a.slidegen'], mtimeMs: 0 };
    expect(changedDeckFiles(baseline, root)).toEqual(['a.slidegen']);
  });

  it('没动过 ⇒ 不是新的（别每一轮都把旧 deck 重排一遍）', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.slidegen'), DECK);
    const before = captureDeckFileBaseline(root);
    expect(changedDeckFiles(before ?? {}, root)).toEqual([]);
  });

  it('负对照：新增的是普通文件 ⇒ 不算（`.md` 不该触发排 PPT）', () => {
    const root = makeRoot();
    const before = captureDeckFileBaseline(root);
    writeFileSync(join(root, 'notes.md'), '随手记');
    expect(changedDeckFiles(before ?? {}, root)).toEqual([]);
  });

  it('扫得到子目录里的（真机那份就在 rongying-agents/<agent>/ 下面）', () => {
    const root = makeRoot();
    const before = captureDeckFileBaseline(root);
    mkdirSync(join(root, 'rongying-agents', 'rongying-ecommerce'), { recursive: true });
    writeFileSync(join(root, 'rongying-agents', 'rongying-ecommerce', 'sept.slidegen.jsx'), DECK);
    expect(changedDeckFiles(before ?? {}, root)).toEqual(['rongying-agents/rongying-ecommerce/sept.slidegen.jsx']);
  });

  it('根不存在 ⇒ 回 null（不抛）—— 拿不到基线时调用方必须能分辨"读不到"和"没有文件"', () => {
    expect(captureDeckFileBaseline(join(tmpdir(), 'mofang-不存在-这个目录'))).toBeNull();
  });

  it('顺序是确定的（同样输入两次跑出同样顺序）', () => {
    const root = makeRoot();
    for (const name of ['c.slidegen', 'a.slidegen', 'b.slidegen']) writeFileSync(join(root, name), DECK);
    const first = changedDeckFiles({}, root);
    const second = changedDeckFiles({}, root);
    expect(first).toEqual(second);
    expect(first.slice().sort()).toEqual(['a.slidegen', 'b.slidegen', 'c.slidegen']);
  });
});

describe('readDeckSources —— 读正文，读不到的不许无声跳过', () => {
  it('多份文件拼起来仍解析得出多份 deck', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.slidegen'), DECK);
    writeFileSync(join(root, 'b.slidegen'), DECK.replace('九月简报', '十月简报'));
    const { text, unreadable } = readDeckSources(root, ['a.slidegen', 'b.slidegen']);
    expect(unreadable).toEqual([]);
    expect(extractSlidegenBlocks(text).decks).toHaveLength(2);
  });

  it('文件没了 / 读不动 ⇒ 报在 unreadable 里，绝不静默丢', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.slidegen'), DECK);
    const { text, unreadable } = readDeckSources(root, ['a.slidegen', '没了.slidegen']);
    expect(unreadable).toEqual(['没了.slidegen']);
    expect(extractSlidegenBlocks(text).decks).toHaveLength(1);
  });
});

describe('decksFromFiles —— 生产入口：读文件 → 拼文本 → 该报的失败一个不落', () => {
  it('正常的带围栏文件 ⇒ 出文本、零失败', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.slidegen'), DECK);
    const { text, failures } = decksFromFiles({ root, relatives: ['a.slidegen'] });
    expect(failures).toEqual([]);
    expect(extractSlidegenBlocks(text).decks).toHaveLength(1);
  });

  it('⭐ 文件在、但没有围栏 ⇒ 报上 `slidegen-file-no-fence`（不许静默）', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'a.slidegen'), '这不是版面，是随手写的笔记');
    const { failures } = decksFromFiles({ root, relatives: ['a.slidegen'] });
    expect(failures).toEqual([{ code: 'slidegen-file-no-fence' }]);
  });

  it('读不动 ⇒ 报上 `slidegen-file-unreadable`（不许静默丢）', () => {
    const root = makeRoot();
    const { failures } = decksFromFiles({ root, relatives: ['没了.slidegen'] });
    expect(failures).toEqual([{ code: 'slidegen-file-unreadable' }]);
  });

  it('两类同时出 ⇒ 两条都报，不互相盖掉', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'ok.slidegen'), '没有围栏');
    const { failures } = decksFromFiles({ root, relatives: ['ok.slidegen', '没了.slidegen'] });
    expect(failures.map((entry) => entry.code).sort()).toEqual(['slidegen-file-no-fence', 'slidegen-file-unreadable']);
  });

  it('没有文件 ⇒ 零失败（这条是常规回落，不能报）', () => {
    const root = makeRoot();
    expect(decksFromFiles({ root, relatives: [] }).failures).toEqual([]);
  });
});

/**
 * 🔴 2026-09-28 紧急修复的边界那一组。
 *
 * 正式包 1.0.2 的症状：**slidegen 在约 8,000 字符被截断** ⇒ 围栏没闭合 ⇒ PPT 出不来。
 * 那 8,000 是**随包运行时**的聊天投影上限（`truncateChatHistoryText`），
 * 不是模型上下文、也不是我们的解析器。本模块这条路把源码挪到**文件**里，
 * 于是**根本不经过那道投影**。
 *
 * 这一组钉的就是"**与 8,000 无关**"：7999 / 8000 / 8001 三个点行为必须完全一致。
 * 若哪天有人再把 8,000 这类常数引进来，这里会红。
 */
describe('⭐ 8,000 边界：文件这条路对它必须**完全不敏感**', () => {
  /** 造一份**恰好** `size` 个字符的闭合 deck。 */
  const deckOfSize = (size: number): string => {
    const head = '```slidegen\n// title: 边界\n<Slide>\n  <Text>';
    const tail = '</Text>\n</Slide>\n```\n';
    const filler = Math.max(0, size - head.length - tail.length);
    return `${head}${'甲'.repeat(filler)}${tail}`;
  };

  for (const size of [7999, 8000, 8001]) {
    it(`${size} 字符的闭合 deck ⇒ 完整收到、正常解析出 1 份`, () => {
      const root = makeRoot();
      const source = deckOfSize(size);
      expect(source.length).toBe(size);
      writeFileSync(join(root, 'b.slidegen'), source);

      const { text, failures } = decksFromFiles({ root, relatives: ['b.slidegen'] });
      expect(failures, '文件这条路不该有任何失败').toEqual([]);
      expect(text.length, '文本必须**完整**收到，一个字都不许少').toBe(size);
      expect(extractSlidegenBlocks(text).decks, '7999/8000/8001 都必须解析出 1 份').toHaveLength(1);
    });
  }

  it('⭐ 20,000 字符的多页闭合 deck ⇒ 完整收到、解析出**一份** deck（不是零份）', () => {
    const root = makeRoot();
    const head = '```slidegen\n// title: 二十页\n';
    const page = (i: number): string =>
      `<Slide>\n  <Text style={{ fontSize: 40 }}>第 ${i} 页 · ${'内'.repeat(60)}</Text>\n</Slide>\n`;
    const pages = Array.from({ length: 12 }, (_, i) => page(i + 1)).join('');
    const source = `${head}${pages}\`\`\`\n`;
    const padding = Math.max(0, 20_000 - source.length);
    const padded = source.replace('</Text>', `${'\u7532'.repeat(padding)}</Text>`);
    writeFileSync(join(root, 'big.slidegen'), padded);

    const { text, failures } = decksFromFiles({ root, relatives: ['big.slidegen'] });
    expect(failures).toEqual([]);
    expect(text.length).toBe(padded.length);
    const extracted = extractSlidegenBlocks(text);
    expect(extracted.decks, '整个文件是**一个**围栏块 ⇒ 只该出一份 deck').toHaveLength(1);
    // 12 页都在（多页不会被截掉）
    expect(extracted.decks[0]!.source.match(/<Slide>/g) ?? []).toHaveLength(12);
  });

  it('50,000 字符也被完整收到（远超 8,000 与旧技能里那个 6,000）', () => {
    const root = makeRoot();
    const head = '```slidegen\n// title: 五万\n<Slide>\n  <Text>';
    const tail = '</Text>\n</Slide>\n```\n';
    const source = `${head}${'乙'.repeat(50_000 - head.length - tail.length)}${tail}`;
    expect(source.length).toBe(50_000);
    writeFileSync(join(root, 'huge.slidegen'), source);
    const { text, failures } = decksFromFiles({ root, relatives: ['huge.slidegen'] });
    expect(failures).toEqual([]);
    expect(text.length).toBe(50_000);
    expect(extractSlidegenBlocks(text).decks).toHaveLength(1);
  });
});

/**
 * 二.5「结构化产物的安全上限必须是**明确、可测、有限**的值」。
 *
 * 文件这条路绕开了运行时的两层顶（聊天投影 8,000 / 单条消息 131,072 **字节**），
 * 但**不能因此没有上限** —— 否则一份畸形的大文件会把收尾路径拖住。
 * 上限要能被测出来（有常量、有 got/max 可断言），超了要**明确报错**，不能静默。
 */
describe('文件大小上限：明确、可测、有限', () => {
  it('上限本身是个有限的正整数，且比真机那份 13 KB 宽裕得多', () => {
    expect(Number.isFinite(DECK_FILE_MAX_BYTES)).toBe(true);
    expect(DECK_FILE_MAX_BYTES).toBeGreaterThan(13_052 * 10);
  });

  it('⭐ 超限 ⇒ 报 `slidegen-file-too-large`，带 max 与 got，不静默', () => {
    const root = makeRoot();
    const head = '```slidegen\n// title: 超限\n<Slide>\n  <Text>';
    const tail = '</Text>\n</Slide>\n```\n';
    const over = DECK_FILE_MAX_BYTES + 1000;
    const source = `${head}${'丙'.repeat(over - head.length - tail.length)}${tail}`;
    writeFileSync(join(root, 'over.slidegen'), source);

    const { failures } = decksFromFiles({ root, relatives: ['over.slidegen'] });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: 'slidegen-file-too-large', max: DECK_FILE_MAX_BYTES });
    expect((failures[0] as { got: number }).got).toBeGreaterThan(DECK_FILE_MAX_BYTES);
  });

  it('恰好等于上限 ⇒ **不报**（边界是"超过"，不是"达到"）', () => {
    const root = makeRoot();
    const head = '```slidegen\n// title: 恰好\n<Slide>\n  <Text>';
    const tail = '</Text>\n</Slide>\n```\n';
    // 用 ASCII 精确控制**字节数**。
    // ⚠️ 必须按**字节**减，不能按 `.length` 减 —— head/tail 里有中文（一个字 1 个 length
    //    但 3 个字节），按 length 减会超出 4 字节。（这条是断言当场逮出来的。）
    const filler = DECK_FILE_MAX_BYTES - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8');
    const source = `${head}${'a'.repeat(filler)}${tail}`;
    expect(Buffer.byteLength(source, 'utf8')).toBe(DECK_FILE_MAX_BYTES);
    writeFileSync(join(root, 'exact.slidegen'), source);
    expect(decksFromFiles({ root, relatives: ['exact.slidegen'] }).failures).toEqual([]);
  });
});

describe('⭐ 读了文件却什么都没解析出来 ⇒ 必须报错，不能当成功', () => {
  it('文件里没有围栏（0 deck、0 失败）⇒ 报 `slidegen-file-no-fence`', () => {
    expect(deckFileNoFenceFailure({ fileCount: 1, deckCount: 0, failureCount: 0 })).toEqual({
      code: 'slidegen-file-no-fence',
    });
  });

  it('⭐ 没有文件时**不报** —— 那是常规回落（该去看聊天围栏），不是失败', () => {
    expect(deckFileNoFenceFailure({ fileCount: 0, deckCount: 0, failureCount: 0 })).toBeNull();
  });

  it('解析出 deck ⇒ 不报', () => {
    expect(deckFileNoFenceFailure({ fileCount: 1, deckCount: 1, failureCount: 0 })).toBeNull();
  });

  it('已经有失败（围栏开了没闭合）⇒ 不抢着再报一条，现有的那条更准', () => {
    expect(deckFileNoFenceFailure({ fileCount: 1, deckCount: 0, failureCount: 1 })).toBeNull();
  });

  it('多个文件都没围栏 ⇒ 也只报一条（一次让用户改一件事）', () => {
    expect(deckFileNoFenceFailure({ fileCount: 3, deckCount: 0, failureCount: 0 })).toEqual({
      code: 'slidegen-file-no-fence',
    });
  });

  /**
   * 边界：文件**有**围栏但被截断 ⇒ 走既有的 `slidegen-block-unclosed`，
   * 不能因为"有文件"就一律报成"没有围栏"。这条钉住两条失败码的分工。
   */
  it('文件里围栏开了没闭合 ⇒ 是 `slidegen-block-unclosed`，不是 `slidegen-file-no-fence`', () => {
    const cut = ['```slidegen', '// title: 半截', '<Slide>', '  <Text>没写完'].join('\n');
    const extracted = extractSlidegenBlocks(cut);
    expect(extracted.decks).toHaveLength(0);
    expect(extracted.failures.map((entry) => entry.failure.code)).toEqual(['slidegen-block-unclosed']);
    // 有失败 ⇒ 这条新判据不接管
    expect(
      deckFileNoFenceFailure({
        fileCount: 1,
        deckCount: extracted.decks.length,
        failureCount: extracted.failures.length,
      }),
    ).toBeNull();
  });
});
