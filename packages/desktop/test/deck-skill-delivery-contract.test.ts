import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const skill = readFileSync(join(import.meta.dirname, '../our-skills/deck-layout/SKILL.md'), 'utf8');

it('distinguishes submitted source from verified PPTX delivery', () => {
  expect(skill).toContain('版面源文件已提交生成');
  expect(skill).toContain('确认实际 `.pptx` 文件存在');
  expect(skill).not.toContain('✅ 可以说：「版面我排好了，稍后出现在');
  expect(skill).not.toContain('回复正文里**只留一句短说明**：版面已排好');
});

it('documents the editable PPTX conversion boundary instead of promising all CSS', () => {
  expect(skill).not.toContain('能在 CSS 里表达的，基本都支持');
  expect(skill).toContain('不支持完整 CSS');
  expect(skill).toContain('fontFamily');
  expect(skill).toContain('boxShadow');
  expect(skill).toContain('backdropFilter');
  expect(skill).toContain('不能保证按浏览器外观导出');
});

it('documents full program declarations and declared components separately from built-in tags', () => {
  expect(skill).toContain('四个内置标签');
  expect(skill).toContain('顶层 `const` / `let` / `function`');
  expect(skill).toContain('已声明的大写函数组件');
  expect(skill).toContain('顶层表达式');
  expect(skill).not.toContain('别的标签（含 `div`、`span`、`h1`）**一律被拒**');
});
