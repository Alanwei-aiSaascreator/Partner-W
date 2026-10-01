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
  expect(skill).toContain('node "{baseDir}/scripts/generate.cjs" "\u4e5d\u6708\u7ecf\u8425\u7b80\u62a5.slidegen"');
  expect(skill).toContain('\u4e0d\u8981\u5728 `source-valid` \u540e\u7ed3\u675f\u56de\u590d');
  expect(skill).not.toContain(
    '\u6587\u4ef6\u662f**\u5ba2\u6237\u7aef\u5728\u8fd9\u4e00\u8f6e\u7ed3\u675f\u540e**\u751f\u6210\u7684',
  );
  expect(skill).not.toContain(
    '\u6e90\u68c0\u67e5\u6210\u529f\u540e\u56de\u590d\u4ec5\u8bf4\u660e\u6e90\u6587\u4ef6\u5df2\u63d0\u4ea4',
  );
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
  expect(skill).toContain('\u4e0d\u80fd\u636e\u6b64\u8bf4\u5df2\u8fdb\u5165\u4ea7\u7269');
  expect(skill).toContain('\u4e0d\u80fd\u628a\u96f6\u544a\u8b66\u8bf4\u6210\u89c6\u89c9\u9a8c\u6536\u901a\u8fc7');
  expect(skill).toContain('\u5177\u4f53\u9875\u7801');
  expect(skill).toContain('\u6700\u591a\u4e24\u8f6e');
});

it('continues the actual process session and holds uncertain generation instead of resubmitting', () => {
  expect(skill).toContain('sessionId');
  expect(skill).toContain('output-unconfirmed');
  expect(skill).toContain('fileCreated:null');
  expect(skill).toContain('receiptStatus:unavailable');
  expect(skill).toContain('\u4e0d\u5f97\u518d\u6b21\u6267\u884c\u751f\u6210\u547d\u4ee4');
  expect(skill).toContain('\u4e0d\u8981\u8ba9\u7528\u6237\u5b89\u88c5\u63d2\u4ef6');
});

it('preserves referenced image versions along with source, output and receipts during correction', () => {
  expect(skill).toContain('\u5f15\u7528\u56fe\u7247\u4e5f\u5c5e\u4e8e\u5df2\u751f\u6210\u7248\u672c');
  expect(skill).toContain('chart-v2.png');
  expect(skill).toContain('\u4e0d\u5f97\u8986\u76d6\u6216\u5220\u9664\u65e7\u56fe\u7247');
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
