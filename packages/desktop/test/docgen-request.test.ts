import { describe, expect, it } from 'vitest';
import { DOCGEN_KINDS, DOCGEN_LIMITS, parseDocgenRequest } from '../src/main/docgen/request';

/**
 * 文档生成请求的**校验**（P1 的 pptx 那一支；docx / xlsx 各有自己的文件）。
 *
 * 为什么这一层要单独钉：它下游是"往用户工作区里写文件"。**猜一个能跑的形状**
 * 会让用户拿到一份内容不对的 PPT —— 比直接失败更糟。所以认不出来一律返回错误。
 */

const valid = {
  kind: 'pptx',
  title: '内测汇报',
  subtitle: '2026-09-24',
  slides: [
    { title: '本周进展', bullets: ['文档生成能力：方案已出', '文件导入提示：已修'] },
    { title: '下周计划', bullets: ['P1 落地'] },
  ],
};

/** 夹具走"合法"路径 —— 不合法时直接抛，避免测试自己悄悄走岔。 */
function deckOf(raw: unknown) {
  const result = parseDocgenRequest(raw);
  if (!result.ok) throw new Error(`夹具本该合法：${result.error}`);
  if (result.request.kind !== 'pptx') throw new Error(`kind 应当是 pptx，实际是 ${result.request.kind}`);
  return result.request;
}

describe('parseDocgenRequest', () => {
  it('正常请求 ⇒ 逐字保留', () => {
    const request = deckOf(valid);
    expect(request.title).toBe('内测汇报');
    expect(request.subtitle).toBe('2026-09-24');
    expect(request.slides).toHaveLength(2);
    expect(request.slides[0]?.bullets).toEqual(['文档生成能力：方案已出', '文件导入提示：已修']);
  });

  it('不是对象 / 是数组 ⇒ 拒（别拿数组当对象用）', () => {
    for (const bad of [null, undefined, 42, 'x', [valid], true]) {
      expect(parseDocgenRequest(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  // ⚠️ 2026-09-26：这条原来拿 `pdf` 当"不认识的 kind"，而 pdf 从这一版起**认得**了
  //    ⇒ 它不再走这条路。换成一个真的不存在的 kind，并保留"错误里要列全支持的格式"
  //    这条判据（它按 `DOCGEN_KINDS` 逐个数，以后再加第五种也自动跟上）。
  it('kind 缺失 / 不认识 ⇒ 拒，且错误里说清支持哪几种（P2 起 docx、xlsx，本版起 pdf 也是合法的）', () => {
    const missing = parseDocgenRequest({ ...valid, kind: undefined });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('kind is required');

    const wrong = parseDocgenRequest({ ...valid, kind: 'csv' });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      for (const kind of DOCGEN_KINDS) expect(wrong.error, `错误里应当列出 ${kind}`).toContain(kind);
    }
  });

  it('docx / xlsx 不再是"不认识的 kind"（但拿 pptx 的形状写它们会被各自的 schema 拒）', () => {
    for (const kind of ['docx', 'xlsx'] as const) {
      const result = parseDocgenRequest({ ...valid, kind });
      expect(result.ok, kind).toBe(false);
      if (!result.ok) expect(result.error, kind).not.toContain('unsupported kind');
    }
  });

  it('title 缺失/空白 ⇒ 拒', () => {
    for (const title of [undefined, '', '   ', 123]) {
      expect(parseDocgenRequest({ ...valid, title }).ok).toBe(false);
    }
  });

  it('slides 为空或不是数组 ⇒ 拒（一份没有内容的 PPT 没有意义）', () => {
    expect(parseDocgenRequest({ ...valid, slides: [] }).ok).toBe(false);
    expect(parseDocgenRequest({ ...valid, slides: 'x' }).ok).toBe(false);
    expect(parseDocgenRequest({ ...valid, slides: undefined }).ok).toBe(false);
  });

  it('页数超上限 ⇒ 拒（并说明上限）', () => {
    const slides = Array.from({ length: DOCGEN_LIMITS.maxSlides + 1 }, (_, i) => ({
      title: `第 ${i} 页`,
      bullets: [],
    }));
    const result = parseDocgenRequest({ ...valid, slides });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(String(DOCGEN_LIMITS.maxSlides));
  });

  it('页标题缺失 ⇒ 拒，且指认是第几页（不然助手不知道改哪）', () => {
    const result = parseDocgenRequest({ ...valid, slides: [{ title: 'ok', bullets: [] }, { bullets: [] }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('slides[1]');
  });

  it('单条要点过长 ⇒ 拒（不要截断：截断是静默改内容）', () => {
    const long = 'x'.repeat(DOCGEN_LIMITS.maxBulletChars + 1);
    const result = parseDocgenRequest({ ...valid, slides: [{ title: 't', bullets: [long] }] });
    expect(result.ok).toBe(false);
  });

  it('要点里的空串/纯空白被丢掉（不是报错）—— 模型偶尔会补空行，为此整份失败不值得', () => {
    const request = deckOf({ ...valid, slides: [{ title: 't', bullets: ['a', '', '   ', 'b'] }] });
    expect(request.slides[0]?.bullets).toEqual(['a', 'b']);
  });

  it('bullets 缺省 = 空数组（纯标题页合法）', () => {
    const request = deckOf({ ...valid, slides: [{ title: '分隔页' }] });
    expect(request.slides[0]?.bullets).toEqual([]);
  });

  it('notes 可选；给了就带出来，空白当没给', () => {
    const withNotes = deckOf({ ...valid, slides: [{ title: 't', bullets: [], notes: '讲者备注' }] });
    expect(withNotes.slides[0]?.notes).toBe('讲者备注');

    const blank = deckOf({ ...valid, slides: [{ title: 't', bullets: [], notes: '  ' }] });
    expect(blank.slides[0]?.notes).toBeUndefined();
  });

  it('notes 过长 ⇒ 拒', () => {
    const long = 'x'.repeat(DOCGEN_LIMITS.maxNotesChars + 1);
    const result = parseDocgenRequest({ ...valid, slides: [{ title: 't', bullets: [], notes: long }] });
    expect(result.ok).toBe(false);
  });

  it('subtitle 缺省 ⇒ 返回体里就没有这个键（不是空串）', () => {
    const request = deckOf({ ...valid, subtitle: undefined });
    expect('subtitle' in request).toBe(false);
  });
});
