/**
 * `htmlgen` 这条链的**接线层**：消息 → 真 .html → 产物 → 富预览（2026-09-27）。
 *
 * ## 为什么这一层必须单独测
 *
 * 契约层（`htmlgen-request.test.ts`）与渲染层（`htmlgen-render.test.ts`）各自再绿，
 * 也证明不了"用户能在产物面板里看到并打开它" —— 那取决于**接线**：
 * 围栏认不认、文件名对不对、有没有交给 `saveArtifactFromBuffer`、
 * 产出的字节能不能过 `buildArtifactPreview` 拿到 `kind: 'html'`。
 * 焊点松了的表现是"助手说做好了，右边什么都没有"，两个单测都不会红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceDatabaseOwner } from '../src/main/workspace/scope.js';

const mocks = vi.hoisted(() => ({
  saveArtifactFromBuffer: vi.fn(),
  debugWarn: vi.fn(),
  debugInfo: vi.fn(),
}));

// 这一层只验"内容 → 文件 → 交没交给产物通道"。DB 与界面各自有自己的测试。
vi.mock('../src/main/artifact/save.js', () => ({
  saveArtifactFromBuffer: mocks.saveArtifactFromBuffer,
  saveArtifact: vi.fn(),
}));
vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({ debug: vi.fn(), info: mocks.debugInfo, warn: mocks.debugWarn, error: vi.fn() }),
}));

const { extractHtmlgenBlocks } = await import('../src/main/htmlgen/blocks.js');
const { generateHtmlPagesFromMessage, htmlFileNameFor } = await import('../src/main/htmlgen/generate.js');
const { extractCodeBlocksFromMarkdown } = await import('../src/main/artifact/extract.js');
const { buildArtifactPreview, previewKindFor, MAX_HTML_PREVIEW_BYTES } =
  await import('../src/main/preview/build-preview.js');

function htmlgenBlock(body: unknown | string): string {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  return ['好的，我来做。', '', '```htmlgen', json, '```', '', '已经放到你的产物里了。'].join('\n');
}

const PAGE = {
  kind: 'html',
  title: '九月经营简报',
  lang: 'zh-CN',
  template: 'brief',
  summary: '本月最重要的结论。',
  sections: [
    { kind: 'narrative', heading: '核心判断', paragraphs: ['增长来自复购。'], bullets: ['老客贡献七成'] },
    { kind: 'metrics', items: [{ label: '转化率', value: '12.4%' }] },
  ],
  sources: [{ label: '内部经营数据' }],
};

beforeEach(() => {
  setWorkspaceDatabaseOwner({});
  vi.clearAllMocks();
  mocks.saveArtifactFromBuffer.mockImplementation(async (params: { fileName: string }) => ({
    id: 'a1',
    name: params.fileName,
  }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('htmlgen 围栏：只认 `htmlgen`', () => {
  it('取出合法的块并解析成请求', () => {
    const { requests, failures } = extractHtmlgenBlocks(htmlgenBlock(PAGE));

    expect(failures).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].template).toBe('brief');
  });

  it('⭐ **不认** `html` / `json` / `docgen` 围栏（用户贴网页源码时不该被当成请求）', () => {
    const source = ['```html', '<p>这是用户贴的网页源码</p>', '```'].join('\n');
    const asJson = ['```json', JSON.stringify(PAGE), '```'].join('\n');
    const asDocgen = ['```docgen', JSON.stringify({ kind: 'pdf', title: 'x', sections: [] }), '```'].join('\n');

    for (const content of [source, asJson, asDocgen]) {
      expect(extractHtmlgenBlocks(content).requests).toHaveLength(0);
      expect(extractHtmlgenBlocks(content).failures).toHaveLength(0);
    }
  });

  it('围栏大小写不敏感，但 `htmlgen.json` 之类不算', () => {
    expect(extractHtmlgenBlocks(htmlgenBlock(PAGE).replace('```htmlgen', '```HTMLGEN')).requests).toHaveLength(1);
    expect(extractHtmlgenBlocks(htmlgenBlock(PAGE).replace('```htmlgen', '```htmlgen.json')).requests).toHaveLength(0);
  });

  it('一份坏块不影响好块（各报各的）', () => {
    const content = [htmlgenBlock('{ 这不是 JSON'), '', htmlgenBlock(PAGE)].join('\n');
    const { requests, failures } = extractHtmlgenBlocks(content);

    expect(requests).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].failure.code).toBe('htmlgen-block-invalid');
  });

  it('⭐ 回复打开了 htmlgen 围栏却没有闭合 ⇒ 明确报 htmlgen-block-invalid', () => {
    const content = ['```HTMLGEN', JSON.stringify(PAGE)].join('\n');

    const { requests, failures } = extractHtmlgenBlocks(content);

    expect(requests).toEqual([]);
    expect(failures.map((entry) => entry.failure)).toEqual([{ code: 'htmlgen-block-invalid' }]);
  });

  it('⭐ 未知版式 / 未知字段的原因**逐级冒上来**（不是一律"格式不对"）', () => {
    const unknownTemplate = extractHtmlgenBlocks(htmlgenBlock({ ...PAGE, template: 'dashboard' }));
    expect(unknownTemplate.failures[0].failure).toEqual({ code: 'htmlgen-unknown-template', template: 'dashboard' });

    const badField = extractHtmlgenBlocks(htmlgenBlock({ ...PAGE, style: 'color:red' }));
    expect(badField.failures[0].failure).toEqual({ code: 'htmlgen-unsupported-field', field: 'style' });
  });
});

describe('htmlgen 生成：落进现成的产物通道', () => {
  it('⭐ 一份合法内容 ⇒ 交给 `saveArtifactFromBuffer`，文件名是 .html', async () => {
    const result = await generateHtmlPagesFromMessage({
      workspacePath: '/ws',
      taskId: 't1',
      messageId: 'm1',
      content: htmlgenBlock(PAGE),
    });

    expect(result.failed).toHaveLength(0);
    expect(mocks.saveArtifactFromBuffer).toHaveBeenCalledTimes(1);
    const params = mocks.saveArtifactFromBuffer.mock.calls[0][0] as {
      fileName: string;
      buffer: Buffer;
      artifactType: string;
      sourceKey: string;
    };
    expect(params.fileName).toBe('九月经营简报.html');
    expect(params.artifactType).toBe('file');
    expect(params.sourceKey).toMatch(/^htmlgen:brief:[0-9a-f]{16}$/);
    // 交出去的是**真网页**（不是一段 JSON）
    expect(params.buffer.toString('utf8')).toContain('<!doctype html>');
    expect(params.buffer.toString('utf8')).toContain('核心判断');
    expect(result.saved).toHaveLength(1);
  });

  it('⭐ 文件名走与 docgen **同一份**清洗规则（非法字符与控制字符都被换掉）', () => {
    expect(htmlFileNameFor('A/B: C*D?')).toBe('A B C D.html');
    expect(htmlFileNameFor('   ')).toBe('网页.html');
    expect(htmlFileNameFor('标'.repeat(80)).length).toBe('标'.repeat(60).length + '.html'.length);
    // ⚠️ 控制字符用**转义**写，不要把真字节放进源文件：真 NUL 会让 git 把整个文件当**二进制**
    //    （`git diff` 只显示 "Bin"、grep 也搜不到）—— 正是 `docgen/generate.ts` 里记的那个坑。
    const withControl = `带${String.fromCharCode(1)}控制字符`;
    expect(htmlFileNameFor(withControl)).toBe('带 控制字符.html');
  });

  it('⭐ 同一段内容重放两次 ⇒ 同一个 `sourceKey`（去重靠它，不能带随机量）', async () => {
    await generateHtmlPagesFromMessage({
      workspacePath: '/ws',
      taskId: 't1',
      messageId: 'm1',
      content: htmlgenBlock(PAGE),
    });
    await generateHtmlPagesFromMessage({
      workspacePath: '/ws',
      taskId: 't1',
      messageId: 'm2',
      content: htmlgenBlock(PAGE),
    });

    const first = (mocks.saveArtifactFromBuffer.mock.calls[0][0] as { sourceKey: string }).sourceKey;
    const second = (mocks.saveArtifactFromBuffer.mock.calls[1][0] as { sourceKey: string }).sourceKey;
    expect(second).toBe(first);
  });

  it('内容不同 ⇒ `sourceKey` 不同（同名不同内容不会被静默丢掉）', async () => {
    await generateHtmlPagesFromMessage({
      workspacePath: '/ws',
      taskId: 't1',
      messageId: 'm1',
      content: htmlgenBlock(PAGE),
    });
    await generateHtmlPagesFromMessage({
      workspacePath: '/ws',
      taskId: 't1',
      messageId: 'm2',
      content: htmlgenBlock({ ...PAGE, summary: '换了一句结论。' }),
    });

    const first = (mocks.saveArtifactFromBuffer.mock.calls[0][0] as { sourceKey: string }).sourceKey;
    const second = (mocks.saveArtifactFromBuffer.mock.calls[1][0] as { sourceKey: string }).sourceKey;
    expect(second).not.toBe(first);
  });

  it('坏块 ⇒ 报出来、**不落盘**；好块照落（一份坏了不影响另一份）', async () => {
    const result = await generateHtmlPagesFromMessage({
      workspacePath: '/ws',
      taskId: 't1',
      messageId: 'm1',
      content: [htmlgenBlock({ ...PAGE, template: '不存在' }), htmlgenBlock(PAGE)].join('\n'),
    });

    expect(mocks.saveArtifactFromBuffer).toHaveBeenCalledTimes(1);
    expect(result.saved).toHaveLength(1);
    expect(result.failed).toEqual([{ code: 'htmlgen-unknown-template', template: '不存在' }]);
  });

  it('落盘失败 ⇒ 收成 `render-failed` 而不是抛出去（调用方在消息收尾路径上）', async () => {
    mocks.saveArtifactFromBuffer.mockRejectedValue(new Error('disk full'));

    const result = await generateHtmlPagesFromMessage({
      workspacePath: '/ws',
      taskId: 't1',
      messageId: 'm1',
      content: htmlgenBlock(PAGE),
    });

    expect(result.saved).toHaveLength(0);
    expect(result.failed).toEqual([{ code: 'htmlgen-render-failed', template: 'brief' }]);
  });

  it('一段消息里多个 `htmlgen` 块 ⇒ 各生成一份', async () => {
    const second = {
      ...PAGE,
      template: 'plan',
      title: '四季度计划',
      sections: [{ kind: 'actions', items: [{ title: '发版' }] }],
    };
    await generateHtmlPagesFromMessage({
      workspacePath: '/ws',
      taskId: 't1',
      messageId: 'm1',
      content: [htmlgenBlock(PAGE), htmlgenBlock(second)].join('\n'),
    });

    const names = mocks.saveArtifactFromBuffer.mock.calls.map((call) => (call[0] as { fileName: string }).fileName);
    expect(names).toEqual(['九月经营简报.html', '四季度计划.html']);
  });
});

/**
 * ⭐⭐ **端到端那一寸**：这条链的出口必须是"用户点开就能看"。
 *
 * 判据不是"文件里有 HTML"，而是**主进程的富预览认得它**并把它读成 `kind: 'html'`
 * （那一步才会注入 CSP、渲染层才会用 `sandbox=""` 的 iframe 画它）。
 * 少了这一寸，"生成成功"与"用户看得见"之间就是空的。
 */
describe('htmlgen 端到端：产出能被富预览认下', () => {
  it('⭐ 生成的 .html ⇒ `previewKindFor` 认得出、`buildArtifactPreview` 读成 html 且带 CSP', async () => {
    await generateHtmlPagesFromMessage({
      workspacePath: '/ws',
      taskId: 't1',
      messageId: 'm1',
      content: htmlgenBlock(PAGE),
    });
    const { buffer, fileName } = mocks.saveArtifactFromBuffer.mock.calls[0][0] as { buffer: Buffer; fileName: string };

    expect(previewKindFor(fileName)).toBe('html');

    const preview = await buildArtifactPreview(fileName, buffer);
    expect(preview.kind).toBe('html');
    if (preview.kind !== 'html') return;
    // 内容真在里面（用户点开看得见）
    expect(preview.html).toContain('九月经营简报');
    expect(preview.html).toContain('12.4%');
    // 且那道锁在位（`build-preview` 注入的，与我们自带的是同一条）
    expect(preview.html).toContain('Content-Security-Policy');
    expect(preview.html).toContain("default-src 'none'");
  });

  it('⭐ 一份内容**顶格**的页面也仍在富预览上限内（`MAX_HTMLGEN_OUTPUT_BYTES` 是为它定的）', async () => {
    const big = {
      ...PAGE,
      sections: Array.from({ length: 20 }, () => ({
        kind: 'table',
        columns: Array.from({ length: 10 }, (_, i) => `列${i}`),
        rows: Array.from({ length: 40 }, () => Array.from({ length: 10 }, () => '值'.repeat(60))),
      })),
    };
    await generateHtmlPagesFromMessage({
      workspacePath: '/ws',
      taskId: 't1',
      messageId: 'm1',
      content: htmlgenBlock(big),
    });
    const { buffer } = mocks.saveArtifactFromBuffer.mock.calls[0][0] as { buffer: Buffer };

    expect(buffer.byteLength).toBeLessThan(MAX_HTML_PREVIEW_BYTES);
  });
});

/**
 * ⚠️ `htmlgen` 块**不是**代码产物：它是"请生成一个网页"的请求。
 * 不排除的话，用户在产物面板里会同时看到那个网页**和**它的 JSON 源码。
 */
describe('htmlgen 块不进代码产物', () => {
  it('`htmlgen` / `docgen` / `slidegen` 三种生成围栏都被排除', () => {
    const content = [
      '```htmlgen',
      JSON.stringify(PAGE),
      '```',
      '```docgen',
      JSON.stringify({ kind: 'pdf', title: 'x', sections: [] }),
      '```',
      '```slidegen',
      '// title: 演示文稿',
      ...Array.from({ length: 12 }, (_, i) => `<Slide><Text>第 ${i} 行</Text></Slide>`),
      '```',
      '```html',
      // ⚠️ 要**多于 10 行**：短于 10 行且语言标记里没有点的块本来就会被丢掉
      //    （`artifact/extract.ts` 那条规则），那样这条测试就分不清
      //    "被生成器围栏排除了"和"被短块规则丢了"。
      ...Array.from({ length: 12 }, (_, i) => `<p>第 ${i} 行</p>`),
      '```',
    ].join('\n');

    const blocks = extractCodeBlocksFromMarkdown(content);

    expect(blocks.map((block) => block.language)).toEqual(['html']);
  });
});
