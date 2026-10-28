import { describe, expect, it } from 'vitest';
import { DOCGEN_LIMITS, parseDocgenRequest } from '../src/main/docgen/request';

/**
 * Word（docx）请求的**校验**（P2）。
 *
 * 和 pptx 那一份同样的道理：这一层的下游是"往用户工作区里写文件"，
 * **猜一个能跑的形状**会让用户拿到一份内容不对的文档 —— 比直接失败更糟。
 *
 * 但有一条与 pptx 不同的取舍：**空小节不算错**（正文里夹一个小标题是正常的排版），
 * 只有当**整篇一个字都没有**时才拒 —— 那是"助手写了块但没写内容"，
 * 生成出来是一份空白 Word，用户只会以为我们坏了。
 */

const valid = {
  kind: 'docx',
  title: '内测报告',
  sections: [
    { heading: '一、背景', paragraphs: ['第一段', '第二段'], bullets: ['要点一'] },
    { paragraphs: ['没有小标题的一段'] },
  ],
};

/** 夹具断言用的是"合法"路径 —— 不合法时直接抛，避免测试自己悄悄走岔。 */
function parse(raw: unknown) {
  const result = parseDocgenRequest(raw);
  if (!result.ok) throw new Error(`夹具本该合法：${result.error}`);
  if (result.request.kind !== 'docx') throw new Error(`kind 应当是 docx，实际是 ${result.request.kind}`);
  return result.request;
}

function errorOf(raw: unknown): string {
  const result = parseDocgenRequest(raw);
  if (result.ok) throw new Error('本该被拒，却通过了');
  return result.error;
}

describe('parseDocgenRequest —— docx', () => {
  it('正常请求 ⇒ 逐字保留', () => {
    const request = parse(valid);
    expect(request.title).toBe('内测报告');
    expect(request.sections).toHaveLength(2);
    expect(request.sections[0]).toEqual({
      heading: '一、背景',
      paragraphs: ['第一段', '第二段'],
      bullets: ['要点一'],
    });
  });

  it('没有 heading 的小节合法，且**不带** heading 键（不是空串）', () => {
    const request = parse(valid);
    // 整对象比对：既证明正文在，也证明 heading 这个键**不存在**（不是空串）
    expect(request.sections[1]).toEqual({ paragraphs: ['没有小标题的一段'], bullets: [] });
  });

  it('paragraphs / bullets 缺省 = 空数组（只有小标题的分隔节合法）', () => {
    const request = parse({ ...valid, sections: [{ heading: '二、附注' }] });
    expect(request.sections[0]).toEqual({ heading: '二、附注', paragraphs: [], bullets: [] });
  });

  it('空串与纯空白被丢掉（不是报错）—— 模型偶尔会补空行，为此整篇失败不值得', () => {
    const request = parse({
      ...valid,
      sections: [{ heading: '  ', paragraphs: ['a', '', '   ', 'b'], bullets: ['', '要点'] }],
    });
    expect(request.sections[0]?.heading).toBeUndefined();
    expect('heading' in (request.sections[0] ?? {})).toBe(false);
    expect(request.sections[0]?.paragraphs).toEqual(['a', 'b']);
    expect(request.sections[0]?.bullets).toEqual(['要点']);
  });

  it('title 缺失/空白 ⇒ 拒（它同时是文件名）', () => {
    for (const title of [undefined, '', '   ', 123]) {
      expect(parseDocgenRequest({ ...valid, title }).ok, String(title)).toBe(false);
    }
  });

  it('sections 为空 / 不是数组 / 缺失 ⇒ 拒', () => {
    expect(errorOf({ ...valid, sections: [] })).toContain('sections');
    expect(parseDocgenRequest({ ...valid, sections: 'x' }).ok).toBe(false);
    expect(parseDocgenRequest({ ...valid, sections: undefined }).ok).toBe(false);
  });

  it('小节不是对象 ⇒ 拒，且指认是第几个（不然助手不知道改哪）', () => {
    expect(errorOf({ ...valid, sections: [{ heading: 'ok' }, 'x'] })).toContain('sections[1]');
  });

  it('⭐ 整篇一个字都没有 ⇒ 拒（别产出一份空白 Word）', () => {
    const error = errorOf({ ...valid, sections: [{ heading: '', paragraphs: ['', '  '], bullets: [] }] });
    expect(error).toContain('sections');
  });

  it('段落条数 / 小节数超上限 ⇒ 拒（并说明上限）', () => {
    const many = Array.from({ length: DOCGEN_LIMITS.maxParagraphsPerSection + 1 }, (_, i) => `第 ${i} 段`);
    expect(errorOf({ ...valid, sections: [{ paragraphs: many }] })).toContain(
      String(DOCGEN_LIMITS.maxParagraphsPerSection),
    );

    const sections = Array.from({ length: DOCGEN_LIMITS.maxSections + 1 }, () => ({ paragraphs: ['x'] }));
    expect(errorOf({ ...valid, sections })).toContain(String(DOCGEN_LIMITS.maxSections));
  });

  it('单段 / 小标题过长 ⇒ 拒（不截断：截断是静默改内容）', () => {
    const long = 'x'.repeat(DOCGEN_LIMITS.maxParagraphChars + 1);
    const error = errorOf({ ...valid, sections: [{ heading: 'ok', paragraphs: [long] }] });
    expect(error).toContain('sections[0]');

    const longHeading = 'x'.repeat(DOCGEN_LIMITS.maxHeadingChars + 1);
    expect(parseDocgenRequest({ ...valid, sections: [{ heading: longHeading }] }).ok).toBe(false);
  });

  it('⭐ 拿 docx 的形状冒充 pptx ⇒ 拒（缺 slides，而不是静默当成空演示）', () => {
    const error = errorOf({ ...valid, kind: 'pptx' });
    expect(error).toContain('slides');
  });
});
