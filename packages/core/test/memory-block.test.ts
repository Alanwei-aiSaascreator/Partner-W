/**
 * 长时记忆：纯逻辑那一半（条目校验 / 去重键 / 受管区块 / 草案契约与围栏解析）。
 *
 * 每条用例都对应一句**可能被写出来的假话**：
 *   · 区块覆盖掉用户/运行时的内容 ⇒ "你自己写在 MEMORY.md 里的笔记被我们抹了"；
 *   · 草案被当成已保存 ⇒ "用户没点头，助手已经说'我记住了'"；
 *   · 坏 JSON 当正文 ⇒ 用户记忆里出现一段代码；
 *   · 超上限截断着存 ⇒ 用户写的后半段静默消失。
 */
import { describe, expect, it } from 'vitest';
import {
  MEMORY_BLOCK_MARKER_PREFIX,
  MEMORY_CONTRACT_MARKER_PREFIX,
  MEMORY_DRAFT_FENCE,
  MEMORY_ENTRY_MAX_CHARS,
  MEMORY_MAX_CONFIRMED_ENTRIES,
  checkMemoryBudget,
  checkMemoryText,
  memoryBlockEntryLines,
  memoryContractBulletLines,
  memoryDedupeKey,
  mergeMemoryBlock,
  mergeMemoryContractBlock,
  normalizeMemoryText,
  readMemoryBlock,
  renderMemoryContractPrompt,
  renderMemoryBlock,
  scanMemoryDraftFences,
} from '../src/index.js';

describe('记忆条目校验', () => {
  it('规范化：折空白、去首尾，但**不改写**用户的原话', () => {
    expect(normalizeMemoryText('  我习惯\n先看  结论。 ')).toBe('我习惯 先看 结论。');
    expect(normalizeMemoryText(undefined)).toBe('');
    expect(normalizeMemoryText(42)).toBe('');
  });

  it('空正文 / 超长 / 控制字符都被挡下，且**给出理由**（不截断着存）', () => {
    expect(checkMemoryText('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(checkMemoryText(`a\u0000b`)).toEqual({ ok: false, reason: 'control-characters' });
    const tooLong = checkMemoryText('x'.repeat(MEMORY_ENTRY_MAX_CHARS + 1));
    expect(tooLong).toEqual({ ok: false, reason: 'over-limit', limit: MEMORY_ENTRY_MAX_CHARS });
  });

  it('刚好到上限是合法的（边界不许挪）', () => {
    const ok = checkMemoryText('x'.repeat(MEMORY_ENTRY_MAX_CHARS));
    expect(ok.ok).toBe(true);
  });

  it('去重键折叠大小写与空白，但正文保留原样', () => {
    const a = checkMemoryText('Use  PNPM');
    const b = checkMemoryText('use pnpm');
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.dedupeKey).toBe(b.dedupeKey);
      expect(a.text).toBe('Use PNPM');
    }
    expect(memoryDedupeKey('用户  偏好先看结论')).toBe(memoryDedupeKey('用户 偏好先看结论'));
  });

  it('整块预算：到条数上限与字符上限都拒绝（不丢最旧的那条来腾位置）', () => {
    const full = Array.from({ length: MEMORY_MAX_CONFIRMED_ENTRIES }, () => ({ text: 'x' }));
    expect(checkMemoryBudget(full, 'y')).toEqual({ ok: false, reason: 'entry-count-limit' });
    expect(checkMemoryBudget([{ text: 'x'.repeat(3999) }], 'yy')).toEqual({ ok: false, reason: 'block-over-limit' });
    expect(checkMemoryBudget([{ text: 'x' }], 'y')).toEqual({ ok: true });
  });
});

describe('MEMORY.md 受管区块', () => {
  const ENTRIES = [{ text: '用户希望结论先行。' }, { text: '用户所在行业是电商。' }];

  it('渲染成可读的条目行（模型与用户看的是同一份）', () => {
    const block = renderMemoryBlock(ENTRIES);
    expect(block).toContain('用户希望结论先行。');
    expect(block).toContain('- 用户所在行业是电商。');
  });

  it('空集合写的是**如实说明**，不是一个空标题', () => {
    expect(renderMemoryBlock([])).toContain('当前没有已确认的长期记忆');
  });

  it('⭐ 已有我们的区块 ⇒ 只替换区块，**区块外一个字都不动**', () => {
    const existing = `# 我的笔记\n\n用户自己写的一段话。\n\n<!-- ${MEMORY_BLOCK_MARKER_PREFIX}:1:begin -->\n旧内容\n<!-- ${MEMORY_BLOCK_MARKER_PREFIX}:1:end -->\n\n尾部还有一段。\n`;
    const merged = mergeMemoryBlock(existing, renderMemoryBlock(ENTRIES));
    expect(merged.changed).toBe(true);
    expect(merged.content).toContain('# 我的笔记');
    expect(merged.content).toContain('用户自己写的一段话。');
    expect(merged.content).toContain('尾部还有一段。');
    expect(merged.content).not.toContain('旧内容');
    expect(memoryBlockEntryLines(merged.content)).toEqual(['用户希望结论先行。', '用户所在行业是电商。']);
  });

  it('⭐ 没有我们的区块、但有别人的正文 ⇒ 追加在末尾，原文原样保留', () => {
    const merged = mergeMemoryBlock('运行时自己写的记忆。', renderMemoryBlock(ENTRIES));
    expect(merged.changed).toBe(true);
    expect(merged.content.startsWith('运行时自己写的记忆。')).toBe(true);
    expect(readMemoryBlock(merged.content)).not.toBeNull();
  });

  it('幂等：同样内容并两次，第二次 **changed=false**（写端据此不发 RPC）', () => {
    const once = mergeMemoryBlock('', renderMemoryBlock(ENTRIES));
    const twice = mergeMemoryBlock(once.content, renderMemoryBlock(ENTRIES));
    expect(twice.changed).toBe(false);
    expect(twice.content).toBe(once.content);
  });

  it('删除一条后重新并 ⇒ 区块里真的没有它了（"删除后不再召回"的机制侧）', () => {
    const before = mergeMemoryBlock('', renderMemoryBlock(ENTRIES)).content;
    const after = mergeMemoryBlock(before, renderMemoryBlock([ENTRIES[0]])).content;
    expect(memoryBlockEntryLines(after)).toEqual(['用户希望结论先行。']);
    expect(after).not.toContain('用户所在行业是电商。');
  });

  it('旧版本标记的区块也能被换掉（否则永远升级不了）', () => {
    const legacy = `<!-- ${MEMORY_BLOCK_MARKER_PREFIX}:0:begin -->\n很旧的格式\n<!-- ${MEMORY_BLOCK_MARKER_PREFIX}:0:end -->`;
    const merged = mergeMemoryBlock(legacy, renderMemoryBlock(ENTRIES));
    expect(merged.content).not.toContain('很旧的格式');
    expect(merged.content).not.toContain(`${MEMORY_BLOCK_MARKER_PREFIX}:0:begin`);
  });
});

describe('记忆契约（AGENTS.md 那一块）', () => {
  it('契约文本必须写清"只提草案、不许说记住了"', () => {
    const prompt = renderMemoryContractPrompt();
    expect(prompt).toContain('只提草案');
    expect(prompt).toContain('不要对用户说"我记住了"');
    expect(prompt).toContain(MEMORY_DRAFT_FENCE);
  });

  it('契约区块与内容区块的标记**互不匹配**（同住一个文件也不打架）', () => {
    const withContract = mergeMemoryContractBlock('').content;
    expect(withContract).toContain(`${MEMORY_CONTRACT_MARKER_PREFIX}:1:begin`);
    // 用记忆区块的合并器去处理契约区块：它必须当成"没有我们的区块"追加，而不是替换掉契约
    const both = mergeMemoryBlock(withContract, renderMemoryBlock([{ text: '一条记忆' }]));
    expect(both.content).toContain(`${MEMORY_CONTRACT_MARKER_PREFIX}:1:begin`);
    expect(memoryContractBulletLines(both.content).length).toBeGreaterThan(0);
  });

  it('契约区块幂等', () => {
    const once = mergeMemoryContractBlock('用户自己写的 AGENTS.md 正文');
    const twice = mergeMemoryContractBlock(once.content);
    expect(twice.changed).toBe(false);
    expect(once.content).toContain('用户自己写的 AGENTS.md 正文');
  });
});

describe('草案围栏解析', () => {
  const fence = (body: string): string => '```' + MEMORY_DRAFT_FENCE + '\n' + body + '\n```';

  it('认出 JSON 正文（text + reason）', () => {
    const scan = scanMemoryDraftFences(fence('{"text":"用户希望结论先行。","reason":"反复要求"}'));
    expect(scan.proposals).toEqual([{ text: '用户希望结论先行。', reason: '反复要求' }]);
    expect(scan.discarded).toBe(0);
  });

  it('reason 缺失/空 ⇒ null（不许编一个理由出来）', () => {
    expect(scanMemoryDraftFences(fence('{"text":"A"}')).proposals[0].reason).toBeNull();
    expect(scanMemoryDraftFences(fence('{"text":"A","reason":"  "}')).proposals[0].reason).toBeNull();
  });

  it('不写 JSON 时按纯文本认（但照样过长度校验）', () => {
    expect(scanMemoryDraftFences(fence('用户希望结论先行。')).proposals).toEqual([
      { text: '用户希望结论先行。', reason: null },
    ]);
  });

  it('⭐ 以 { 开头却是坏 JSON ⇒ **整块丢掉**，不许把代码当记忆存进去', () => {
    const scan = scanMemoryDraftFences(fence('{"text": "没写完'));
    expect(scan.proposals).toEqual([]);
    expect(scan.discarded).toBe(1);
  });

  it('⭐ 超过每条消息上限的草案被丢掉并**如实计数**（不静默）', () => {
    const four = Array.from({ length: 5 }, (_, i) => fence(`{"text":"第${i}条"}`)).join('\n');
    const scan = scanMemoryDraftFences(four);
    expect(scan.proposals).toHaveLength(3);
    expect(scan.overflow).toBe(2);
  });

  it('别的围栏 / 空正文 / 超长正文都不算草案', () => {
    expect(scanMemoryDraftFences('```ts\nconst a = 1;\n```').proposals).toEqual([]);
    expect(scanMemoryDraftFences(fence('   ')).discarded).toBe(1);
    expect(scanMemoryDraftFences(fence('x'.repeat(MEMORY_ENTRY_MAX_CHARS + 1))).discarded).toBe(1);
  });

  it('普通聊天正文里没有草案 ⇒ 空结果（零副作用）', () => {
    expect(scanMemoryDraftFences('今天天气不错，我们继续做 PPT 吧。').proposals).toEqual([]);
  });
});
