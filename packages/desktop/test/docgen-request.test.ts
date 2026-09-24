import { describe, expect, it } from 'vitest';
import { DOCGEN_LIMITS, parseDocgenRequest, presentationPathFor } from '../src/main/docgen/request';

/**
 * 文档生成请求的**校验**。
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

describe('parseDocgenRequest', () => {
  it('正常请求 ⇒ 逐字保留', () => {
    const result = parseDocgenRequest(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.title).toBe('内测汇报');
    expect(result.request.subtitle).toBe('2026-09-24');
    expect(result.request.slides).toHaveLength(2);
    expect(result.request.slides[0]?.bullets).toEqual(['文档生成能力：方案已出', '文件导入提示：已修']);
  });

  it('不是对象 / 是数组 ⇒ 拒（别拿数组当对象用）', () => {
    for (const bad of [null, undefined, 42, 'x', [valid], true]) {
      expect(parseDocgenRequest(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('kind 缺失或不是 pptx ⇒ 拒，且错误里说清只支持什么', () => {
    const missing = parseDocgenRequest({ ...valid, kind: undefined });
    expect(missing.ok).toBe(false);
    const wrong = parseDocgenRequest({ ...valid, kind: 'docx' });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toContain('pptx');
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
    const result = parseDocgenRequest({ ...valid, slides: [{ title: 't', bullets: ['a', '', '   ', 'b'] }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.slides[0]?.bullets).toEqual(['a', 'b']);
  });

  it('bullets 缺省 = 空数组（纯标题页合法）', () => {
    const result = parseDocgenRequest({ ...valid, slides: [{ title: '分隔页' }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.slides[0]?.bullets).toEqual([]);
  });

  it('notes 可选；给了就带出来，空白当没给', () => {
    const withNotes = parseDocgenRequest({ ...valid, slides: [{ title: 't', bullets: [], notes: '讲者备注' }] });
    expect(withNotes.ok).toBe(true);
    if (withNotes.ok) expect(withNotes.request.slides[0]?.notes).toBe('讲者备注');

    const blank = parseDocgenRequest({ ...valid, slides: [{ title: 't', bullets: [], notes: '  ' }] });
    expect(blank.ok).toBe(true);
    if (blank.ok) expect(blank.request.slides[0]?.notes).toBeUndefined();
  });

  it('notes 过长 ⇒ 拒', () => {
    const long = 'x'.repeat(DOCGEN_LIMITS.maxNotesChars + 1);
    const result = parseDocgenRequest({ ...valid, slides: [{ title: 't', bullets: [], notes: long }] });
    expect(result.ok).toBe(false);
  });

  it('subtitle 缺省 ⇒ 返回体里就没有这个键（不是空串）', () => {
    const result = parseDocgenRequest({ ...valid, subtitle: undefined });
    expect(result.ok).toBe(true);
    if (result.ok) expect('subtitle' in result.request).toBe(false);
  });
});

describe('presentationPathFor —— 请求名 ⇒ 产物名', () => {
  it('点前缀的请求 ⇒ 干净的名字（前导点不进产物名）', () => {
    expect(presentationPathFor('.汇报.docgen.json')).toBe('汇报.pptx');
    expect(presentationPathFor('..汇报.docgen.json')).toBe('汇报.pptx');
  });

  it('大小写不敏感（Windows 上助手可能写成大写）', () => {
    expect(presentationPathFor('.deck.DOCGEN.JSON')).toBe('deck.pptx');
  });

  it('后缀不对 / 只有点 / 带路径分隔符 ⇒ null（不生成）', () => {
    for (const name of ['汇报.pptx', '.docgen.json', '   .docgen.json', '.a/b.docgen.json', '.a\\b.docgen.json']) {
      expect(presentationPathFor(name), name).toBeNull();
    }
  });
});
