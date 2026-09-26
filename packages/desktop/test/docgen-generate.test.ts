import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import { extractCodeBlocksFromMarkdown } from '../src/main/artifact/extract';

/**
 * 「助手出内容、客户端排版」这条链的端到端那一层：**消息 → 真文件 → 产物**（三种格式）。
 *
 * 走的是客户端既有的产物通道（`saveArtifactFromBuffer`：写任务目录 + 写库），
 * 所以不需要新 UI 也不需要新事件 —— 用户在下一条消息的产物里就能看到它。
 */

const mocks = vi.hoisted(() => ({
  insertValues: vi.fn(() => ({ onConflictDoNothing: vi.fn(() => ({ returning: vi.fn(async () => []) })) })),
  saveArtifactFromBuffer: vi.fn(),
}));

// 这一层只验"内容 → 文件"与"有没有交给产物通道"，DB 与界面各自有自己的测试。
vi.mock('../src/main/artifact/save.js', () => ({
  saveArtifactFromBuffer: mocks.saveArtifactFromBuffer,
  detectMimeType: () => 'application/octet-stream',
}));

const { documentFileNameFor, generateDocumentsFromMessage } = await import('../src/main/docgen/generate.js');

function unzipNames(buffer: Buffer): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error('no zipfile'));
      const names: string[] = [];
      zipfile.on('entry', (entry: yauzl.Entry) => {
        names.push(entry.fileName);
        zipfile.readEntry();
      });
      zipfile.on('end', () => resolve(names));
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}

function docgenBlock(body: unknown | string): string {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  return ['好的，我来做。', '', '```docgen', json, '```', '', '已经放到你的产物里了。'].join('\n');
}

const PPTX = {
  kind: 'pptx',
  title: '内测汇报',
  subtitle: '2026-09-24',
  slides: [{ title: '本周进展', bullets: ['方案已出'] }],
};

const DOCX = {
  kind: 'docx',
  title: '内测报告',
  sections: [{ heading: '一、背景', paragraphs: ['本轮补齐了三种格式。'], bullets: ['要点'] }],
};

const XLSX = {
  kind: 'xlsx',
  title: '九月台账',
  sheets: [{ name: '汇总', rows: [['产品', 1200]] }],
};

let workspacePath = '';
const taskId = 'task-1';
const messageId = 'msg-1';

beforeEach(() => {
  workspacePath = mkdtempSync(join(tmpdir(), 'clawwork-docgen-gen-'));
  mocks.saveArtifactFromBuffer.mockReset();
  mocks.saveArtifactFromBuffer.mockImplementation(async (params: { fileName: string; buffer: Buffer }) => ({
    id: 'artifact-1',
    taskId,
    messageId,
    type: 'file',
    name: params.fileName,
    size: params.buffer.length,
  }));
});
afterEach(() => rmSync(workspacePath, { recursive: true, force: true }));

function savedParams(index: number): { fileName: string; buffer: Buffer; sourceKey?: string } {
  return mocks.saveArtifactFromBuffer.mock.calls[index]?.[0] as { fileName: string; buffer: Buffer };
}

describe('extractDocgenBlocks（经 generateDocumentsFromMessage 间接验）', () => {
  it('没有 docgen 块 ⇒ 什么都不做（普通回复不该触发文件生成）', async () => {
    const result = await generateDocumentsFromMessage({
      workspacePath,
      taskId,
      messageId,
      content: '今天天气不错，要不要看看别的？',
    });
    expect(result).toEqual({ saved: [], failed: [] });
    expect(mocks.saveArtifactFromBuffer).not.toHaveBeenCalled();
  });

  it('⭐ 有 docgen 块 ⇒ 生成真 pptx 并交给产物通道', async () => {
    const result = await generateDocumentsFromMessage({
      workspacePath,
      taskId,
      messageId,
      content: docgenBlock(PPTX),
    });

    expect(result.saved).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(savedParams(0).fileName).toBe('内测汇报.pptx');
    expect(await unzipNames(savedParams(0).buffer), '产出的不是合法 pptx').toContain('ppt/presentation.xml');
  });

  it('⭐ docx 块 ⇒ 生成真 docx（扩展名与容器都对）', async () => {
    const result = await generateDocumentsFromMessage({
      workspacePath,
      taskId,
      messageId,
      content: docgenBlock(DOCX),
    });
    expect(result.failed).toEqual([]);
    expect(savedParams(0).fileName).toBe('内测报告.docx');
    expect(await unzipNames(savedParams(0).buffer)).toContain('word/document.xml');
  });

  it('⭐ xlsx 块 ⇒ 生成真 xlsx（扩展名与容器都对）', async () => {
    const result = await generateDocumentsFromMessage({
      workspacePath,
      taskId,
      messageId,
      content: docgenBlock(XLSX),
    });
    expect(result.failed).toEqual([]);
    expect(savedParams(0).fileName).toBe('九月台账.xlsx');
    expect(await unzipNames(savedParams(0).buffer)).toContain('xl/workbook.xml');
  });

  it('⭐ 一段回复里三种格式混着来 ⇒ 三份都出得来，各是各的扩展名', async () => {
    const content = [docgenBlock(PPTX), '', docgenBlock(DOCX), '', docgenBlock(XLSX)].join('\n');
    const result = await generateDocumentsFromMessage({ workspacePath, taskId, messageId, content });
    expect(result.failed).toEqual([]);
    expect(result.saved).toHaveLength(3);
    expect([savedParams(0).fileName, savedParams(1).fileName, savedParams(2).fileName]).toEqual([
      '内测汇报.pptx',
      '内测报告.docx',
      '九月台账.xlsx',
    ]);
  });

  it('围栏语言必须**恰好**是 docgen —— `json` 的块不算', async () => {
    const content = ['```json', JSON.stringify(PPTX), '```'].join('\n');
    const result = await generateDocumentsFromMessage({ workspacePath, taskId, messageId, content });
    expect(result.saved).toEqual([]);
    expect(mocks.saveArtifactFromBuffer).not.toHaveBeenCalled();
  });

  it('大小写与尾随空格容忍（模型会写 ```Docgen ）', async () => {
    const content = ['```Docgen ', JSON.stringify(PPTX), '```'].join('\n');
    const result = await generateDocumentsFromMessage({ workspacePath, taskId, messageId, content });
    expect(result.saved).toHaveLength(1);
  });

  it('JSON 坏了 ⇒ 记账、不抛、不存文件', async () => {
    const result = await generateDocumentsFromMessage({
      workspacePath,
      taskId,
      messageId,
      content: docgenBlock('{ 不是 json'),
    });
    expect(result.saved).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(mocks.saveArtifactFromBuffer).not.toHaveBeenCalled();
  });

  it('schema 不合法（缺 slides）⇒ 记账', async () => {
    const result = await generateDocumentsFromMessage({
      workspacePath,
      taskId,
      messageId,
      content: docgenBlock({ kind: 'pptx', title: 't' }),
    });
    expect(result.failed).toHaveLength(1);
    expect(mocks.saveArtifactFromBuffer).not.toHaveBeenCalled();
  });

  // ⚠️ 2026-09-26：这条原来拿 `pdf` 当"不认识的 kind" —— 而 pdf 从这一版起**认得**了，
  //    于是它走了真渲染路径、报的是"缺 sections"。换成一个真的不存在的 kind，
  //    这条测的才是它本来要测的东西（认不出 ⇒ 记账，而不是硬猜一个格式）。
  it('不认识的 kind（csv）⇒ 记账，而不是硬猜一个格式', async () => {
    const result = await generateDocumentsFromMessage({
      workspacePath,
      taskId,
      messageId,
      content: docgenBlock({ kind: 'csv', title: 't', rows: [] }),
    });
    expect(result.saved).toEqual([]);
    expect(result.failed).toEqual([{ code: 'request-invalid' }]);
  });

  it('两份块 ⇒ 存两份，且一份坏不影响另一份', async () => {
    const content = [docgenBlock(PPTX), '', docgenBlock('{ 坏的'), '', docgenBlock({ ...PPTX, title: '第二份' })].join(
      '\n',
    );
    const result = await generateDocumentsFromMessage({ workspacePath, taskId, messageId, content });
    expect(result.saved).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
  });

  it('产物通道失败 ⇒ 记账，不抛（消息收尾路径上不能炸）', async () => {
    mocks.saveArtifactFromBuffer.mockRejectedValueOnce(new Error('disk full'));
    const result = await generateDocumentsFromMessage({
      workspacePath,
      taskId,
      messageId,
      content: docgenBlock(PPTX),
    });
    expect(result.saved).toEqual([]);
    expect(result.failed).toEqual([{ code: 'render-failed', format: 'pptx' }]);
  });

  it('⭐ sourceKey 认得出"同一份内容"（产物通道按它去重，重放不会存出第二份）', async () => {
    await generateDocumentsFromMessage({ workspacePath, taskId, messageId, content: docgenBlock(PPTX) });
    await generateDocumentsFromMessage({ workspacePath, taskId, messageId, content: docgenBlock(PPTX) });
    const first = savedParams(0).sourceKey ?? '';
    expect(first).toMatch(/^docgen:/);
    expect(savedParams(1).sourceKey, '同样的内容两次，去重键应当相同').toBe(first);
  });

  it('⭐ 内容不同 ⇒ 去重键不同（原来只带"标题+页数"，两份不同内容会互相顶掉）', async () => {
    await generateDocumentsFromMessage({ workspacePath, taskId, messageId, content: docgenBlock(PPTX) });
    await generateDocumentsFromMessage({
      workspacePath,
      taskId,
      messageId,
      content: docgenBlock({ ...PPTX, slides: [{ title: '本周进展', bullets: ['改了一个字'] }] }),
    });
    expect(savedParams(1).sourceKey).not.toBe(savedParams(0).sourceKey);
  });

  it('⭐ 不同 kind 的同名内容 ⇒ 去重键不同（pptx 不该顶掉 docx）', async () => {
    await generateDocumentsFromMessage({ workspacePath, taskId, messageId, content: docgenBlock(PPTX) });
    await generateDocumentsFromMessage({
      workspacePath,
      taskId,
      messageId,
      content: docgenBlock({ kind: 'docx', title: '内测汇报', sections: [{ paragraphs: ['x'] }] }),
    });
    expect(savedParams(0).sourceKey).toContain('pptx');
    expect(savedParams(1).sourceKey).toContain('docx');
  });
});

describe('排不下的内容：**不落文件**，并留下一条能被界面翻译出来的原因', () => {
  const maxBullet = (): string => '内'.repeat(300);

  const overflowingDeck = (slideCount = 1): unknown => ({
    kind: 'pptx',
    title: '内测汇报',
    slides: Array.from({ length: slideCount }, (_, i) => ({
      title: `第 ${i + 1} 部分`,
      bullets: Array.from({ length: 12 }, () => maxBullet()),
    })),
  });

  it('一页 3600 字 ⇒ 报"内容过多"并带上第几页；**没调用过产物通道**', async () => {
    const result = await generateDocumentsFromMessage({
      workspacePath,
      taskId,
      messageId,
      content: docgenBlock(overflowingDeck()),
    });
    expect(result.saved).toEqual([]);
    expect(result.failed).toEqual([{ code: 'presentation-page-overflow', format: 'pptx', page: 1 }]);
    expect(mocks.saveArtifactFromBuffer, '排不下就不能产出文件').not.toHaveBeenCalled();
  });

  it('页号是**改起来最省事**的那个口径：slides 里从 1 数（封面不算）', async () => {
    // 前两页正常、第三页爆掉 —— 这样"page"到底数的是 3 还是 2 才有区分度。
    // （如果三页都爆，page=1 无论按哪种口径都对，这条就白写了。）
    const result = await generateDocumentsFromMessage({
      workspacePath,
      taskId,
      messageId,
      content: docgenBlock({
        kind: 'pptx',
        title: '内测汇报',
        slides: [
          { title: '第一页', bullets: ['一条'] },
          { title: '第二页', bullets: ['一条'] },
          { title: '第三页', bullets: Array.from({ length: 12 }, () => maxBullet()) },
        ],
      }),
    });
    expect(result.failed).toEqual([{ code: 'presentation-page-overflow', format: 'pptx', page: 3 }]);
  });

  it('页标题过长 ⇒ 报"标题过长"，并带上**真的能放下的字数**', async () => {
    const result = await generateDocumentsFromMessage({
      workspacePath,
      taskId,
      messageId,
      content: docgenBlock({ kind: 'pptx', title: '内测汇报', slides: [{ title: '标'.repeat(120), bullets: [] }] }),
    });
    expect(result.saved).toEqual([]);
    const failure = result.failed[0];
    // 显式收窄到那一条：`maxChars` 只在这个 variant 上存在，靠 `toMatchObject` 是收窄不了的
    if (failure?.code !== 'presentation-page-title-overflow') throw new Error(`没被判成标题过长：${failure?.code}`);
    expect(failure).toMatchObject({ format: 'pptx', page: 1 });
    expect(failure.maxChars, '提示里那句"控制在 N 字以内"必须是个真数').toBeGreaterThan(0);
    expect(mocks.saveArtifactFromBuffer).not.toHaveBeenCalled();
  });

  it('⭐ 好坏混合：好文件照样保存，坏的那份单独失败且**没有产物**', async () => {
    const content = [
      docgenBlock({ ...PPTX, title: '好的那份' }),
      '',
      docgenBlock(overflowingDeck()),
      '',
      docgenBlock({ ...DOCX, title: '好的另一份' }),
    ].join('\n');
    const result = await generateDocumentsFromMessage({ workspacePath, taskId, messageId, content });

    expect(result.saved.map((a) => a.name)).toEqual(['好的那份.pptx', '好的另一份.docx']);
    expect(result.failed).toEqual([{ code: 'presentation-page-overflow', format: 'pptx', page: 1 }]);
    // 坏的那份**从来没进过产物通道** —— 不是"存了再删"
    expect(mocks.saveArtifactFromBuffer).toHaveBeenCalledTimes(2);
    const names = mocks.saveArtifactFromBuffer.mock.calls.map((call) => (call[0] as { fileName: string }).fileName);
    expect(names).not.toContain('内测汇报.pptx');
  });

  it('docx / xlsx 不受 pptx 那套版面判定影响（判定只活在 pptx 上）', async () => {
    const result = await generateDocumentsFromMessage({
      workspacePath,
      taskId,
      messageId,
      content: docgenBlock({
        kind: 'xlsx',
        title: '台账',
        sheets: [{ name: '汇总', rows: Array.from({ length: 300 }, (_, i) => ['内'.repeat(900), i]) }],
      }),
    });
    expect(result.failed).toEqual([]);
    expect(result.saved).toHaveLength(1);
  });
});

describe('documentFileNameFor', () => {
  it('用标题做文件名，扩展名跟着 kind 走', () => {
    expect(documentFileNameFor('内测汇报', 'pptx')).toBe('内测汇报.pptx');
    expect(documentFileNameFor('内测汇报', 'docx')).toBe('内测汇报.docx');
    expect(documentFileNameFor('内测汇报', 'xlsx')).toBe('内测汇报.xlsx');
  });

  it('去掉 Windows 不允许的字符，但**保留空格与连字符**', () => {
    expect(documentFileNameFor('A/B: C*D?', 'docx')).toBe('A B C D.docx');
    expect(documentFileNameFor('内测汇报 - 第一期', 'pptx')).toBe('内测汇报 - 第一期.pptx');
  });

  it('空标题/全是非法字符 ⇒ 退回该格式的稳定名字', () => {
    expect(documentFileNameFor('   ', 'pptx')).toBe('演示文稿.pptx');
    expect(documentFileNameFor('///', 'docx')).toBe('文档.docx');
    expect(documentFileNameFor('', 'xlsx')).toBe('表格.xlsx');
  });

  it('超长标题被截断（Windows 路径长度）—— 三种格式一样长', () => {
    for (const [kind, suffix] of [
      ['pptx', '.pptx'],
      ['docx', '.docx'],
      ['xlsx', '.xlsx'],
    ] as const) {
      const name = documentFileNameFor('长'.repeat(200), kind);
      expect(name.endsWith(suffix), kind).toBe(true);
      expect(name.length, kind).toBeLessThanOrEqual(65);
    }
  });
});

describe('docgen 块不会被当成代码产物（否则用户会看到一份 JSON 噪音）', () => {
  it('extractCodeBlocksFromMarkdown 跳过 docgen 围栏（三种 kind 都跳）', () => {
    const content = [
      '```docgen',
      JSON.stringify(PPTX),
      '```',
      '',
      '```docgen',
      JSON.stringify(DOCX),
      '```',
      '',
      '```docgen',
      JSON.stringify(XLSX),
      '```',
      '',
      // ⚠️ 这一段必须有**扩展名**（或超过 10 行）：既有的抽取规则会跳过
      //    "短且没有扩展名"的块（那是行内代码片段，不是产物）。夹具踩过一次。
      '```app.ts',
      'const a = 1;',
      '```',
    ].join('\n');
    const blocks = extractCodeBlocksFromMarkdown(content);
    expect(blocks.map((b) => b.language)).toEqual(['app.ts']);
  });
});
