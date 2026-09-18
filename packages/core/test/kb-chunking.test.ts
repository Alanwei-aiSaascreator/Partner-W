import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  estimateTokens,
  headingPrefix,
  splitText,
} from '../src/services/kb/chunking.js';

/**
 * 切片器的行为断言。
 *
 * 重点不是"函数被调过"，而是三条硬性质：
 * ① 切点落在标题/段落/句子边界上；② 正文**不丢字、不重复**（重叠部分要如实标注）；
 * ③ 标题路径进正文前缀（T6c 的引用角标靠它说清"这段属于哪一章"）。
 */

/** 把"去掉重叠头部"的正文按顺序拼回来 —— 用来验不丢字/不重复。 */
function reconstructBodies(chunks: Array<{ body: string; overlapChars: number }>): string {
  return chunks.map((chunk) => chunk.body.slice(chunk.overlapChars)).join('\n');
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('splitText：标题层级', () => {
  it('按标题切小节，并把标题路径写成前缀', () => {
    const text = ['# 第三章 预算', '', '第一段内容。', '', '## 收入', '', '第二段内容。'].join('\n');

    const chunks = splitText(text);

    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([['第三章 预算'], ['第三章 预算', '收入']]);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1]);
    expect(chunks[0].text).toBe('【所属：第三章 预算】\n第一段内容。');
    expect(chunks[1].text).toBe('【所属：第三章 预算 › 收入】\n第二段内容。');
    expect(chunks[0].overlapChars).toBe(0);
  });

  it('没有标题的纯文本不加前缀（txt 场景）', () => {
    const chunks = splitText('就是一段没有任何标题的话。');

    expect(chunks).toHaveLength(1);
    expect(chunks[0].headingPath).toEqual([]);
    expect(chunks[0].text).toBe('就是一段没有任何标题的话。');
    expect(headingPrefix([])).toBe('');
  });

  it('代码围栏里的 # 注释不是标题', () => {
    const text = ['# 真标题', '', '```bash', '# 这是注释，不是标题', 'echo hi', '```', '', '结尾段落。'].join('\n');

    const chunks = splitText(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].headingPath).toEqual(['真标题']);
    expect(chunks[0].body).toContain('# 这是注释，不是标题');
    expect(chunks[0].body).toContain('结尾段落。');
  });

  it('标题级别回退时路径跟着回退（# → ## → #）', () => {
    const text = ['# 一', '', 'A', '', '## 一之下', '', 'B', '', '# 二', '', 'C'].join('\n');

    expect(splitText(text).map((chunk) => chunk.headingPath)).toEqual([['一'], ['一', '一之下'], ['二']]);
  });
});

describe('splitText：块大小与重叠', () => {
  it('长段落按句子边界切，块大小不超上限（含重叠在内）', () => {
    const sentence = '这是一句用来测试切片边界的完整句子，长度大约三十来个字。';
    const text = sentence.repeat(20); // 约 560 字，无空行 ⇒ 只能按句子切

    const chunks = splitText(text, { chunkSize: 200, chunkOverlap: 30 });

    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.body.length).toBeLessThanOrEqual(200 + 30);
      expect(chunk.body.length).toBeGreaterThan(100); // 不是碎块
    }
    // 切点只落在句号之后：去掉重叠的正文，每段都仍以句号收尾
    for (const chunk of chunks) {
      expect(chunk.body.slice(chunk.overlapChars).trimEnd().endsWith('。')).toBe(true);
    }
  });

  it('相邻块带重叠：下一块开头就是上一块结尾', () => {
    const text = Array.from({ length: 12 }, (_, index) => `第${index}段：${'内容'.repeat(40)}`).join('\n\n');

    const chunks = splitText(text, { chunkSize: 300, chunkOverlap: 60 });

    expect(chunks.length).toBeGreaterThan(1);
    for (let index = 1; index < chunks.length; index += 1) {
      const previous = chunks[index - 1];
      const current = chunks[index];
      expect(current.overlapChars).toBe(60);
      expect(current.body.slice(0, 60)).toBe(previous.body.slice(-60));
    }
  });

  it('重叠默认值就是设计口径（500 字 / 15%）', () => {
    expect(DEFAULT_CHUNK_SIZE).toBe(500);
    expect(DEFAULT_CHUNK_OVERLAP).toBe(Math.round(DEFAULT_CHUNK_SIZE * 0.15));
  });

  it('不丢字也不重复：去掉重叠后每段正文恰好出现一次', () => {
    const paragraphs = Array.from({ length: 9 }, (_, index) => `第${index}段落。${'填充文字'.repeat(index + 6)}`);
    const text = ['# 报告', '', paragraphs.join('\n\n')].join('\n');

    const chunks = splitText(text, { chunkSize: 220, chunkOverlap: 40 });
    const reconstructed = reconstructBodies(chunks);

    expect(chunks.length).toBeGreaterThan(1);
    for (const paragraph of paragraphs) {
      expect(occurrences(reconstructed, paragraph)).toBe(1);
    }
    // 重叠确实发生了（否则上面那条"恰好一次"是自动成立的）
    expect(chunks.some((chunk) => chunk.overlapChars > 0)).toBe(true);
  });

  it('收尾碎块并回上一块，不产生几字宽的切片', () => {
    const text = ['# 标题', '', '正文'.repeat(200), '', '尾巴。'].join('\n');

    const chunks = splitText(text, { chunkSize: 200, chunkOverlap: 30 });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[chunks.length - 1].body.slice(chunks[chunks.length - 1].overlapChars).trim()).not.toBe('尾巴。');
    // 尾巴还是没丢
    expect(chunks[chunks.length - 1].body).toContain('尾巴。');
  });

  it('空文本 / 纯空白 / 只有标题 ⇒ 一个块都不产出', () => {
    expect(splitText('')).toEqual([]);
    expect(splitText('   \n\n \t ')).toEqual([]);
    expect(splitText('# 只有个标题\n\n## 再来一个')).toEqual([]);
  });
});

describe('estimateTokens：粗略估算', () => {
  it('中文按字、拉丁按 4 字符 1 token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('你好 world')).toBe(4); // 2 个汉字 + ceil(5/4)
  });

  it('随内容单调不减（花费预览只会越估越多，不会漏）', () => {
    const short = estimateTokens('这是一段话。');
    const long = estimateTokens('这是一段话。'.repeat(5));

    expect(long).toBeGreaterThan(short);
  });
});
