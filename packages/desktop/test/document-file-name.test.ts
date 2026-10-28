import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { documentFileStem } from '../src/main/util/document-file-name.js';
import { uniqueFileNameIn } from '../src/main/workspace/safe-name.js';
import { documentFileNameFor } from '../src/main/docgen/generate.js';
import { slideFileNameFor } from '../src/main/slidegen/generate.js';
import { htmlFileNameFor } from '../src/main/htmlgen/generate.js';

/**
 * BUG-042-a（亲验必炸）：标题里带**连续点**（`关于...的说明` / `第1..3章`）时，
 * `documentFileStem` 原样把 `..` 带进文件名，而落盘层的 `uniqueFileNameIn` 把
 * 「名字里含 `..`」当路径逃逸**无条件 throw** ⇒ docgen 整份报 `render-failed`。
 *
 * 修在**源头**（这里的主名规则）：连续点序列替换成一个安全字符；单个点照旧保留
 * （`v1.2 报告` 是正常文件名）。`workspace/safe-name.ts` 的严格守卫**不动** ——
 * 它守的是任意来源的名字，收紧它是另一件事。
 */
describe('documentFileStem · 连续点序列不再产出"必炸文件名"', () => {
  it('⭐ 带连续点的标题 ⇒ 结果里没有 `..`，落盘层的严格守卫不再 throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-stem-'));
    try {
      for (const title of ['关于...的说明', '第1..3章', '....', 'v1..2 报告', 'a....b', '报告...']) {
        const stem = documentFileStem(title, '文档');
        expect(stem, `标题 ${title} 的主名里不该再有连续点`).not.toContain('..');
        expect(() => uniqueFileNameIn(dir, `${stem}.docx`), `标题 ${title} 的文件名必须能落盘`).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('连续点 → 单个安全字符', () => {
    expect(documentFileStem('关于...的说明', '文档')).toBe('关于·的说明');
    expect(documentFileStem('第1..3章', '文档')).toBe('第1·3章');
  });

  it('⭐ 单个点保留（`v1.2 报告` 是正常名字，不许被改）', () => {
    expect(documentFileStem('v1.2 报告', '文档')).toBe('v1.2 报告');
    expect(documentFileStem('v1.2.3 版', '文档')).toBe('v1.2.3 版');
  });

  it('全是点 ⇒ 仍然是一个可用、可落盘的名字（不空、不以点开头/结尾）', () => {
    const stem = documentFileStem('....', '文档');
    expect(stem.length).toBeGreaterThan(0);
    expect(stem.startsWith('.')).toBe(false);
    expect(stem.endsWith('.')).toBe(false);
  });

  it('负对照：正常标题一字不改，空标题照旧退回稳定名', () => {
    expect(documentFileStem('内测汇报 - 第一期', '文档')).toBe('内测汇报 - 第一期');
    expect(documentFileStem('   ', '文档')).toBe('文档');
  });
});

/**
 * BUG-058①（联审 P3 残余）：**主名以单个点/空白收尾**时，出片路拼 `${stem}${ext}` 会得到
 * `方案..docx` —— `workspace/safe-name.ts:8` 的 `includes('..')` 守卫无条件 throw ⇒ 整份
 * render-failed。BUG-042-a 只洗了**连续点**（`..` → `·`），单个尾点没治。
 *
 * 修法（只动源头，不放松落盘守卫）：收尾的「点 + 空白」在**长度截断之后**再去一遍，
 * 去空了退回稳定名。中间的点（`v1.2`）照旧保留。
 */
describe('BUG-058① · 主名收尾不许是点/空白（截断之后再过同一道）', () => {
  it('⭐ 标题以单个点结尾 ⇒ 尾点去掉（不再拼出 `方案..docx`）', () => {
    expect(documentFileStem('方案.', '文档')).toBe('方案');
  });

  it('⭐ 尾点是"点 + 空白"的组合 ⇒ 一并去掉', () => {
    expect(documentFileStem('方案. ', '文档')).toBe('方案');
    expect(documentFileStem('方案 .', '文档')).toBe('方案');
  });

  it('⭐ 截断恰好落在第 60 个字符、那是个点 ⇒ 截断之后再去尾点', () => {
    const stem = documentFileStem(`${'a'.repeat(59)}.b`, '文档');
    expect(stem).toBe('a'.repeat(59));
    expect(stem.endsWith('.')).toBe(false);
  });

  it('⭐ 全点 / 点点空白混合 ⇒ 退回稳定名（不产生不可用主名）', () => {
    expect(documentFileStem('.', '文档')).toBe('文档');
    expect(documentFileStem('. . .', '文档')).toBe('文档');
  });

  it('⭐ 三条真实出片路拼名后都能落盘，且名字里没有双点', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-stem-tail-'));
    try {
      const cases: Array<[string, string]> = [
        ['方案.', documentFileNameFor('方案.', 'docx')],
        ['方案. ', slideFileNameFor('方案. ')],
        ['.', htmlFileNameFor('.')],
        [`${'a'.repeat(59)}.b`, documentFileNameFor(`${'a'.repeat(59)}.b`, 'docx')],
      ];
      for (const [title, name] of cases) {
        expect(name, `标题 ${title} 拼出的名字不该有双点`).not.toContain('..');
        const target = uniqueFileNameIn(dir, name); // 落盘层的严格守卫（未放松）必须放行
        writeFileSync(join(dir, target), 'x'); // 真实临时目录保存
        expect(existsSync(join(dir, target)), `标题 ${title} 的名字必须真的能写盘`).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('负对照：中间的点照旧保留（v1.2 / v1.2.3 不许被改）', () => {
    expect(documentFileStem('v1.2.', '文档')).toBe('v1.2');
    expect(documentFileStem('v1.2.3 版', '文档')).toBe('v1.2.3 版');
  });
});
