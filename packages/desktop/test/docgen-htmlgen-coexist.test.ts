import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * **两条交付线在同一条消息里并存** —— 这是把 PPTX 模板引擎与 htmlgen 合进候选之后
 * 才可能出现、也才必须钉住的一种情形。
 *
 * 为什么这条不能靠两边的单测代替：
 *  两条线各自绿，证明的是"我的那条路自己能跑"。而用户随手就可能在一句话里要
 *  **一份模板 PPT + 一个网页 + 一段代码**。合起来之后真正会出问题的是**焊点**：
 *  围栏正则互相吃掉、两份产物落到不同任务、某个块坏掉把另一个也带走、
 *  或者普通代码块的抽取被新通道挤没了。这些在两边的单测里**结构上看不见**。
 *
 * ⚠️ 这一层只验"内容 → 文件 → 交没交给**同一条**产物通道"。
 *    DB 与界面各自有自己的测试；这里把 `saveArtifactFromBuffer` 打桩，
 *    看的就是"两份都交上去了、且用的是同一个 taskId/messageId"。
 */

const mocks = vi.hoisted(() => ({
  saveArtifactFromBuffer: vi.fn(async (params: Record<string, unknown>) => ({
    id: `artifact-${String(params.fileName)}`,
    localPath: `${String(params.taskId)}/${String(params.fileName)}`,
    ...params,
  })),
}));

vi.mock('../src/main/artifact/save.js', () => ({
  saveArtifactFromBuffer: mocks.saveArtifactFromBuffer,
  saveArtifact: vi.fn(),
  detectMimeType: () => 'application/octet-stream',
}));
vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { generateDocumentsFromMessage } = await import('../src/main/docgen/generate.js');
const { generateHtmlPagesFromMessage } = await import('../src/main/htmlgen/generate.js');
const { extractCodeBlocksFromMarkdown } = await import('../src/main/artifact/extract.js');
const { resolvePptxTemplatesRoot } = await import('../src/main/docgen/pptx-template/locate.js');
const { listZipEntries, readZipEntry } = await import('../src/main/preview/zip-entry.js');

const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATES_ROOT = resolvePptxTemplatesRoot({ isPackaged: false, appPath: PROJECT_DIR })!;

const TASK_ID = 'task-coexist';
const MESSAGE_ID = 'msg-coexist';

/** 模板 PPT 块 —— 走「填设计师的模板」那条路。 */
const PPT_BLOCK = [
  '```docgen',
  JSON.stringify({
    kind: 'pptx',
    title: '两条线并存',
    template: 'business-deck-v4',
    slides: [
      { templateId: 'cover', data: { cover_title: '两条线合起来的样子', cover_subtitle: '一次说清' } },
      { templateId: 'metrics', data: { slide_title: '关键指标', value_1: '12.4%', label_1: '转化率' } },
    ],
  }),
  '```',
].join('\n');

/** 网页块 —— 走 htmlgen。 */
const HTML_BLOCK = [
  '```htmlgen',
  JSON.stringify({
    kind: 'html',
    title: '同一条消息里的网页',
    template: 'brief',
    summary: '这段网页和上面的 PPT 来自同一条消息。',
    sections: [{ kind: 'narrative', heading: '结论', paragraphs: ['两条线互不干扰。'] }],
  }),
  '```',
].join('\n');

/**
 * 普通代码块 —— 历史行为，**必须不回归**。
 *
 * ⚠️ 语言标记必须带扩展名（`app.js` 而不是 `js`）。既有的抽取规则是
 *    "**短（≤10 行）且标记里没有点** ⇒ 跳过"，那是给"顺手贴一行命令"用的，
 *    不是缺陷。第一版夹具写的 ` ```js ` + 5 行，于是这条块被正常滤掉，
 *    测试却以为它该被抽出来 —— 红的是夹具，不是产品。
 */
const CODE_BLOCK = [
  '```app.js',
  'const a = 1;',
  'const b = 2;',
  'console.log(a + b);',
  'export default a;',
  '```',
].join('\n');

function mixedMessage(): string {
  return ['我来一次做三样。', '', PPT_BLOCK, '', HTML_BLOCK, '', CODE_BLOCK, '', '都在右边产物里。'].join('\n');
}

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'coexist-'));
  mocks.saveArtifactFromBuffer.mockClear();
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('一条消息里三样并存', () => {
  it('⭐ 模板 PPT + 网页 + 普通代码块：三样都被认出来，互不吃掉', async () => {
    const content = mixedMessage();

    // ① 模板 PPT
    const docs = await generateDocumentsFromMessage({
      workspacePath: workspace,
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content,
      templatesRoot: TEMPLATES_ROOT,
    });
    // ② 网页
    const pages = await generateHtmlPagesFromMessage({
      workspacePath: workspace,
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content,
    });
    // ③ 普通代码块（历史行为）
    const codes = extractCodeBlocksFromMarkdown(content);

    expect(docs.failed, JSON.stringify(docs.failed)).toEqual([]);
    expect(docs.saved).toHaveLength(1);
    expect(pages.failed, JSON.stringify(pages.failed)).toEqual([]);
    expect(pages.saved).toHaveLength(1);
    expect(codes).toHaveLength(1);
    expect(codes[0].content).toContain('console.log(a + b)');
  });

  it('⭐ 两份产物落在**同一个任务 / 同一条消息**上（否则用户会在两个地方找）', async () => {
    const content = mixedMessage();
    await generateDocumentsFromMessage({
      workspacePath: workspace,
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content,
      templatesRoot: TEMPLATES_ROOT,
    });
    await generateHtmlPagesFromMessage({
      workspacePath: workspace,
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content,
    });

    // 打桩收到的每一笔都应当是同一组 taskId/messageId
    const handoffs = mocks.saveArtifactFromBuffer.mock.calls.map(([p]) => ({
      taskId: (p as Record<string, unknown>).taskId,
      messageId: (p as Record<string, unknown>).messageId,
      fileName: (p as Record<string, unknown>).fileName,
    }));
    expect(handoffs).toHaveLength(2);
    for (const h of handoffs) {
      expect(h.taskId).toBe(TASK_ID);
      expect(h.messageId).toBe(MESSAGE_ID);
    }
    // 一份 .pptx、一份 .html
    const names = handoffs.map((h) => String(h.fileName));
    expect(names.some((n) => n.endsWith('.pptx'))).toBe(true);
    expect(names.some((n) => n.endsWith('.html'))).toBe(true);
  });

  it('⭐ 生成出来的 PPTX 是真模板产物：无残留占位符，且不是空壳', async () => {
    await generateDocumentsFromMessage({
      workspacePath: workspace,
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content: mixedMessage(),
      templatesRoot: TEMPLATES_ROOT,
    });
    const pptx = mocks.saveArtifactFromBuffer.mock.calls
      .map(([p]) => p as Record<string, unknown>)
      .find((p) => String(p.fileName).endsWith('.pptx'));
    expect(pptx).toBeDefined();
    const buffer = pptx!.buffer as Buffer;
    expect(buffer.byteLength).toBeGreaterThan(1000);

    const slides = listZipEntries(buffer).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    expect(slides).toHaveLength(2); // 请求了两页
    const allXml = slides.map((n) => readZipEntry(buffer, n)!.toString('utf8')).join('\n');
    expect(allXml.match(/\{\{[^}]+\}\}/g), '成品里有残留占位符').toBeNull();
    expect(allXml).toContain('两条线合起来的样子');
  });

  it('⭐ 网页产物自带安全锁：无脚本、无外链', async () => {
    await generateHtmlPagesFromMessage({
      workspacePath: workspace,
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content: mixedMessage(),
    });
    const html = mocks.saveArtifactFromBuffer.mock.calls
      .map(([p]) => p as Record<string, unknown>)
      .find((p) => String(p.fileName).endsWith('.html'));
    const text = String(html!.contentText ?? (html!.buffer as Buffer).toString('utf8'));
    expect(text).not.toMatch(/<script\b/i);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).toContain('<!doctype html>');
  });
});

describe('一条坏掉不带走另一条', () => {
  it('⭐ 模板块用了不认识的 templateId ⇒ 只有 PPT 失败，网页照出', async () => {
    const badPpt = [
      '```docgen',
      JSON.stringify({
        kind: 'pptx',
        title: '坏的',
        template: 'business-deck-v4',
        slides: [{ templateId: 'tmeline', data: {} }],
      }),
      '```',
    ].join('\n');
    const content = ['坏的 PPT + 好的网页。', '', badPpt, '', HTML_BLOCK].join('\n');

    const docs = await generateDocumentsFromMessage({
      workspacePath: workspace,
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content,
      templatesRoot: TEMPLATES_ROOT,
    });
    const pages = await generateHtmlPagesFromMessage({
      workspacePath: workspace,
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content,
    });

    expect(docs.saved).toHaveLength(0);
    expect(docs.failed).toHaveLength(1);
    // 失败带的是**结构化原因**，而且把模型写错的那个名字带回来了
    expect(docs.failed[0]).toMatchObject({ code: 'template-page-unknown', templateId: 'tmeline' });
    // ★ 网页不受影响
    expect(pages.failed).toEqual([]);
    expect(pages.saved).toHaveLength(1);
  });

  it('⭐ 网页块坏了 ⇒ PPT 照出（反方向也要成立）', async () => {
    const badHtml = [
      '```htmlgen',
      '{"kind":"html","title":"坏的","template":"no-such-template","sections":[]}',
      '```',
    ].join('\n');
    const content = ['好的 PPT + 坏的网页。', '', PPT_BLOCK, '', badHtml].join('\n');

    const docs = await generateDocumentsFromMessage({
      workspacePath: workspace,
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content,
      templatesRoot: TEMPLATES_ROOT,
    });
    const pages = await generateHtmlPagesFromMessage({
      workspacePath: workspace,
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content,
    });

    expect(docs.failed).toEqual([]);
    expect(docs.saved).toHaveLength(1);
    expect(pages.saved).toHaveLength(0);
    expect(pages.failed.length).toBeGreaterThan(0);
  });

  it('模板目录定位不到时（打包漏了资源）⇒ 报失败，但**不抛**、不带走别的东西', async () => {
    const docs = await generateDocumentsFromMessage({
      workspacePath: workspace,
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content: mixedMessage(),
      templatesRoot: undefined,
    });
    expect(docs.saved).toHaveLength(0);
    expect(docs.failed).toHaveLength(1);
    // 定位不到是我们这边的问题 ⇒ render-failed，而不是把锅甩给模型的内容
    expect(docs.failed[0]).toMatchObject({ code: 'render-failed', format: 'pptx' });
    // 代码块的抽取与它无关，照旧
    expect(extractCodeBlocksFromMarkdown(mixedMessage())).toHaveLength(1);
  });
});

describe('不重复提取', () => {
  it('同一条消息跑两遍，两边都只各交一次（不会因为两条通道并存而各记两笔）', async () => {
    const content = mixedMessage();
    const run = async () => {
      await generateDocumentsFromMessage({
        workspacePath: workspace,
        taskId: TASK_ID,
        messageId: MESSAGE_ID,
        content,
        templatesRoot: TEMPLATES_ROOT,
      });
      await generateHtmlPagesFromMessage({ workspacePath: workspace, taskId: TASK_ID, messageId: MESSAGE_ID, content });
    };
    await run();
    const first = mocks.saveArtifactFromBuffer.mock.calls.length;
    expect(first).toBe(2);
    await run();
    // 第二遍仍然各交一次 —— 真正的去重键在通道内部（sourceKey），这里只钉"一条通道不会被另一条带着多跑"
    expect(mocks.saveArtifactFromBuffer.mock.calls.length).toBe(4);
  });
});
