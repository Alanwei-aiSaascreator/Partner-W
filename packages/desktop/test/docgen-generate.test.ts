import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';
import { extractCodeBlocksFromMarkdown } from '../src/main/artifact/extract';

/**
 * 「助手出内容、客户端排版」这条链的端到端那一层：**消息 → 真 .pptx → 产物**。
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

const { deckFileNameFor, generateDecksFromMessage } = await import('../src/main/docgen/generate.js');

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

function deckBlock(body: unknown | string): string {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  return ['好的，我来做这份演示。', '', '```docgen', json, '```', '', '已经放到你的产物里了。'].join('\n');
}

const REQUEST = {
  kind: 'pptx',
  title: '内测汇报',
  subtitle: '2026-09-24',
  slides: [{ title: '本周进展', bullets: ['方案已出'] }],
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

describe('extractDocgenBlocks（经 generateDecksFromMessage 间接验）', () => {
  it('没有 docgen 块 ⇒ 什么都不做（普通回复不该触发文件生成）', async () => {
    const result = await generateDecksFromMessage({
      workspacePath,
      taskId,
      messageId,
      content: '今天天气不错，要不要看看别的？',
    });
    expect(result).toEqual({ saved: [], failed: [] });
    expect(mocks.saveArtifactFromBuffer).not.toHaveBeenCalled();
  });

  it('⭐ 有 docgen 块 ⇒ 生成真 pptx 并交给产物通道', async () => {
    const result = await generateDecksFromMessage({ workspacePath, taskId, messageId, content: deckBlock(REQUEST) });

    expect(result.saved).toHaveLength(1);
    expect(result.failed).toEqual([]);
    const params = mocks.saveArtifactFromBuffer.mock.calls[0]?.[0] as { fileName: string; buffer: Buffer };
    expect(params.fileName).toBe('内测汇报.pptx');
    const names = await unzipNames(params.buffer);
    expect(names, '产出的不是合法 pptx').toContain('ppt/presentation.xml');
  });

  it('围栏语言必须**恰好**是 docgen —— `json` 的块不算', async () => {
    const content = ['```json', JSON.stringify(REQUEST), '```'].join('\n');
    const result = await generateDecksFromMessage({ workspacePath, taskId, messageId, content });
    expect(result.saved).toEqual([]);
    expect(mocks.saveArtifactFromBuffer).not.toHaveBeenCalled();
  });

  it('大小写与尾随空格容忍（模型会写 ```Docgen ）', async () => {
    const content = ['```Docgen ', JSON.stringify(REQUEST), '```'].join('\n');
    const result = await generateDecksFromMessage({ workspacePath, taskId, messageId, content });
    expect(result.saved).toHaveLength(1);
  });

  it('JSON 坏了 ⇒ 记账、不抛、不存文件', async () => {
    const result = await generateDecksFromMessage({
      workspacePath,
      taskId,
      messageId,
      content: deckBlock('{ 不是 json'),
    });
    expect(result.saved).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(mocks.saveArtifactFromBuffer).not.toHaveBeenCalled();
  });

  it('schema 不合法（缺 slides）⇒ 记账', async () => {
    const result = await generateDecksFromMessage({
      workspacePath,
      taskId,
      messageId,
      content: deckBlock({ kind: 'pptx', title: 't' }),
    });
    expect(result.failed).toHaveLength(1);
    expect(mocks.saveArtifactFromBuffer).not.toHaveBeenCalled();
  });

  it('两份块 ⇒ 存两份，且一份坏不影响另一份', async () => {
    const content = [deckBlock(REQUEST), '', deckBlock('{ 坏的'), '', deckBlock({ ...REQUEST, title: '第二份' })].join(
      '\n',
    );
    const result = await generateDecksFromMessage({ workspacePath, taskId, messageId, content });
    expect(result.saved).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
  });

  it('产物通道失败 ⇒ 记账，不抛（消息收尾路径上不能炸）', async () => {
    mocks.saveArtifactFromBuffer.mockRejectedValueOnce(new Error('disk full'));
    const result = await generateDecksFromMessage({ workspacePath, taskId, messageId, content: deckBlock(REQUEST) });
    expect(result.saved).toEqual([]);
    expect(result.failed).toEqual(['disk full']);
  });

  it('重放同一段内容时带 sourceKey（产物通道按它去重，不会存出第二份）', async () => {
    await generateDecksFromMessage({ workspacePath, taskId, messageId, content: deckBlock(REQUEST) });
    const params = mocks.saveArtifactFromBuffer.mock.calls[0]?.[0] as { sourceKey?: string };
    expect(params.sourceKey).toMatch(/^docgen:/);
  });
});

describe('deckFileNameFor', () => {
  it('用标题做文件名；去掉 Windows 不允许的字符', () => {
    expect(deckFileNameFor('内测汇报')).toBe('内测汇报.pptx');
    expect(deckFileNameFor('A/B: C*D?')).toBe('A B C D.pptx');
  });

  it('标题里的**空格与连字符要保留**（别把它们也当非法字符吃掉）', () => {
    expect(deckFileNameFor('内测汇报 - 第一期')).toBe('内测汇报 - 第一期.pptx');
  });

  it('空标题/全是非法字符 ⇒ 退回稳定名字', () => {
    expect(deckFileNameFor('   ')).toBe('演示文稿.pptx');
    expect(deckFileNameFor('///')).toBe('演示文稿.pptx');
  });

  it('超长标题被截断（Windows 路径长度）', () => {
    // 主名截到 60，加上 `.pptx` 一共 65
    const name = deckFileNameFor('长'.repeat(200));
    expect(name.endsWith('.pptx')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(65);
  });
});

describe('docgen 块不会被当成代码产物（否则用户会看到一份 JSON 噪音）', () => {
  it('extractCodeBlocksFromMarkdown 跳过 docgen 围栏', () => {
    const content = [
      '```docgen',
      JSON.stringify({
        kind: 'pptx',
        title: 't',
        slides: [{ title: 'a', bullets: ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'] }],
      }),
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
