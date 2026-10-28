import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateContent } from '../src/main/docgen/template-deck/input.js';
import type { SlotTable, TemplateDeckContent } from '../src/main/docgen/template-deck/types.js';

/**
 * BUG-053②：16 个 layout 速查文件的 Example 必须**照抄即合法**。
 *
 * 背景（2026-10-08 复核）：示例原先是占位词结构示意（"页面标题 / 卡片标题"等 = 校验器
 * 明文黑名单），模型照抄直接 `placeholder-text` 被拒；另有"半个占位词"（行标签 / 表格内容 /
 * 角标 —— 不在黑名单）照抄能过校验但产出占位文本。本测试把每个示例喂**真校验器**
 * （`validateContent` + 真 `detail.json` 槽表），把"示例可用"变成可执行契约；
 * 修法 = 示例对齐 `content.example.json`（已验证可渲染的行业中立示例）。
 */

const nativeDeckDir = path.resolve('resources/pptx-templates/native-deck');
const table = JSON.parse(fs.readFileSync(path.join(nativeDeckDir, 'detail.json'), 'utf8')) as SlotTable;
const layoutsDir = path.join(import.meta.dirname, '../our-skills/presentation-deck-v2/layouts');
const canonical = JSON.parse(fs.readFileSync(path.join(nativeDeckDir, 'content.example.json'), 'utf8')) as Record<
  string,
  unknown
>;

function exampleOf(layoutNumber: number): unknown {
  const file = path.join(layoutsDir, `layout-${String(layoutNumber).padStart(2, '0')}.md`);
  const text = fs.readFileSync(file, 'utf8');
  const match = /Example（content\["(\d+)"\]）：\s*```json\s*([\s\S]*?)```/.exec(text);
  expect(match, `${path.basename(file)} 缺 Example 代码块`).not.toBeNull();
  const [, key, body] = match!;
  expect(key).toBe(String(layoutNumber));
  return (JSON.parse(`{${body}}`) as Record<string, unknown>)[String(layoutNumber)];
}

describe('layout 速查文件的 Example（BUG-053②）', () => {
  for (let n = 1; n <= 16; n += 1) {
    it(`layout-${String(n).padStart(2, '0')} 照抄即合法：示例过真校验器（占位词 / 溢出一律拒）`, () => {
      const value = exampleOf(n);
      expect(() => validateContent(table, { [String(n)]: value } as TemplateDeckContent)).not.toThrow();
    });
  }

  it('示例与 canonical content.example.json 逐页一致（同一份已验证范本，防漂回占位词）', () => {
    for (let n = 1; n <= 16; n += 1) {
      expect(exampleOf(n), `layout-${n} 与 content.example.json 不一致`).toEqual(canonical[String(n)]);
    }
  });
});
