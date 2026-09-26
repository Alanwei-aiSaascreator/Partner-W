import { describe, expect, it, vi } from 'vitest';

/**
 * 「拒了就**一点都不碰渲染器**」—— 这条只有数构造次数才证得了。
 *
 * 别的断言（"抛了异常"、"没落文件"）都**允许**一种坏实现：先把 pptxgenjs 起来、
 * 画到一半再抛。那种实现今天看结果一样，但哪天有人把 `write()` 挪到判定之前，
 * 就会产出半成品 —— 而半成品在用户那里长得和"生成失败"完全不同。
 *
 * ⚠️ 所以这条测试**必须带反向对照**（合法输入下构造次数要为 1）：
 * 只断言"构造 0 次"的话，把整个渲染层删掉也能绿。
 */

const spans = vi.hoisted(() => ({ constructed: 0, writes: 0 }));

vi.mock('pptxgenjs', () => {
  class FakeSlide {
    addText(): void {}
    addShape(): void {}
    addNotes(): void {}
  }
  class FakePptx {
    layout = '';
    title = '';
    subject = '';
    addSlide(): FakeSlide {
      return new FakeSlide();
    }
    async write(): Promise<Buffer> {
      spans.writes += 1;
      return Buffer.from('fake-pptx');
    }
    constructor() {
      spans.constructed += 1;
    }
  }
  return { default: FakePptx };
});

const { parseDocgenRequest } = await import('../src/main/docgen/request.js');
const { renderPptx } = await import('../src/main/docgen/render-pptx.js');

function requestOf(raw: unknown) {
  const parsed = parseDocgenRequest(raw);
  if (!parsed.ok) throw new Error(`夹具不合法：${parsed.error}`);
  if (parsed.request.kind !== 'pptx') throw new Error('夹具 kind 不对');
  return parsed.request;
}

const VALID = {
  kind: 'pptx',
  title: '九月经营简报',
  subtitle: '2026-09-26 · 产品组',
  slides: [
    { title: '本月完成情况', bullets: ['文档生成能力已落地'] },
    { title: '下一步计划', bullets: ['真盘验收'] },
  ],
};

const MULTILINE = {
  ...VALID,
  slides: [{ title: '本月完成情况', bullets: ['第一句', '前半\n后半'] }],
};

describe('排不下 / 有换行 ⇒ 一个渲染器对象都不许建', () => {
  it('⭐ 要点里有换行：抛，且 **pptxgenjs 一次都没被构造**', async () => {
    spans.constructed = 0;
    spans.writes = 0;

    await expect(renderPptx(requestOf(MULTILINE))).rejects.toMatchObject({
      problem: { code: 'slide-bullet-multiline', page: 1, bullet: 2 },
    });

    expect(spans.constructed, '判定必须排在 new PptxGenJS() 之前').toBe(0);
    expect(spans.writes, '更不该写出去').toBe(0);
  });

  it('⭐ 内容超量：同样一个对象都不建', async () => {
    spans.constructed = 0;
    await expect(
      renderPptx(
        requestOf({
          ...VALID,
          slides: [{ title: '爆页', bullets: Array.from({ length: 12 }, () => '内'.repeat(300)) }],
        }),
      ),
    ).rejects.toMatchObject({ problem: { code: 'slide-body-overflow', page: 1 } });
    expect(spans.constructed).toBe(0);
  });

  it('⭐ 反向对照：合法输入下**确实**构造并写出了（否则上面两条是空转）', async () => {
    spans.constructed = 0;
    spans.writes = 0;

    const buffer = await renderPptx(requestOf(VALID));

    expect(buffer.length).toBeGreaterThan(0);
    expect(spans.constructed, '合法输入必须真的走渲染').toBe(1);
    expect(spans.writes).toBe(1);
  });
});
