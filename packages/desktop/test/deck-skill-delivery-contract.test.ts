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

it('requires the installed generation command after source preflight in the current turn', () => {
  expect(skill).toContain('node "{baseDir}/scripts/generate.cjs" "九月经营简报.slidegen"');
  expect(skill).toContain('不要在 `source-valid` 后结束回复');
  expect(skill).not.toContain('文件是**客户端在这一轮结束后**生成的');
  expect(skill).not.toContain('源检查成功后回复仅说明源文件已提交');
});

it('separates file, indexing and visual evidence and binds diagnostics to the returned version', () => {
  for (const field of [
    'file-generated',
    'fileCreated:true',
    'artifactIndexed:false',
    'receiptStatus:ready',
    'outputSha256',
    'layoutReview',
    'visualReview:not-performed',
  ]) {
    expect(skill).toContain(field);
  }
  expect(skill).toContain('不能据此说已进入产物');
  expect(skill).toContain('不能把零告警说成视觉验收通过');
  expect(skill).toContain('具体页码');
  expect(skill).toContain('最多两轮');
});

it('continues the actual process session and holds uncertain generation instead of resubmitting', () => {
  expect(skill).toContain('sessionId');
  expect(skill).toContain('output-unconfirmed');
  expect(skill).toContain('fileCreated:null');
  expect(skill).toContain('receiptStatus:unavailable');
  expect(skill).toContain('不得再次执行生成命令');
  expect(skill).toContain('不要让用户安装插件');
});

it('preserves referenced image versions along with source, output and receipts during correction', () => {
  expect(skill).toContain('引用图片也属于已生成版本');
  expect(skill).toContain('chart-v2.png');
  expect(skill).toContain('不得覆盖或删除旧图片');
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
