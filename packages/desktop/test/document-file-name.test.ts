import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { documentFileStem } from '../src/main/util/document-file-name.js';
import { uniqueFileNameIn } from '../src/main/workspace/safe-name.js';

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
