import { describe, expect, it } from 'vitest';
import type { ModelCatalogEntry } from '@clawwork/shared';
import {
  buildAttachmentActions,
  buildAttachmentDirective,
  classifyAttachmentFile,
  detectEditIntent,
  resolveImageInputSupport,
} from '../src/renderer/lib/attachment-actions';

/**
 * F 组（BUG-030）：拖入文件默认「先读后答」，写只发生在明确意图之后。
 * C 组（BUG-027）：图片以统一能力名「识别图片」暴露（提取文字 / 总结图片 / 分析内容）。
 *
 * 这里钉的是**判据本身**（纯函数），接线由 use-chat-send / ChatInput 的用例守。
 */
describe('classifyAttachmentFile', () => {
  it('按扩展名分类（表格 / 演示 / 文档 / 图片 / 文本）', () => {
    expect(classifyAttachmentFile('季度报表.xlsx')).toBe('table');
    expect(classifyAttachmentFile('data.CSV')).toBe('table');
    expect(classifyAttachmentFile('路演.pptx')).toBe('slides');
    expect(classifyAttachmentFile('说明.docx')).toBe('document');
    expect(classifyAttachmentFile('合同.pdf')).toBe('document');
    expect(classifyAttachmentFile('截图.png')).toBe('image');
    expect(classifyAttachmentFile('笔记.md')).toBe('text');
    expect(classifyAttachmentFile('unknown.bin')).toBe('other');
  });

  it('MIME 兜底：没有可识别扩展名时按 image/ 前缀判图', () => {
    expect(classifyAttachmentFile('clipboard', 'image/png')).toBe('image');
    expect(classifyAttachmentFile('', 'image/jpeg')).toBe('image');
  });

  /**
   * ⭐ 2026-10-07（质量战役区 2 · P3-1）：图片扩展名以**导入白名单**
   * （`@clawwork/shared` 的 `IMAGE_FILE_EXTENSIONS`：png/jpg/jpeg/webp）为单一真源。
   * gif/svg/bmp 从来进不了导入白名单（拖入判"类型不支持"），粘贴侧也不许再承诺
   * 「识别图片」——同一份文件两条入口两种结局，就是"一句兑现不了的承诺"。
   */
  it('⭐ 粘贴 gif/svg/bmp 不再判图（与导入白名单同源；不给「识别图片」的承诺）', () => {
    // 带 MIME 也不行：有扩展名时扩展名说了算（MIME 兜底只留给真的没有扩展名的输入）
    expect(classifyAttachmentFile('动图.gif', 'image/gif')).toBe('other');
    expect(classifyAttachmentFile('矢量.svg', 'image/svg+xml')).toBe('other');
    expect(classifyAttachmentFile('位图.bmp', 'image/bmp')).toBe('other');
    // 给最宽容的开关（supported）也一样：这不是能力问题，是格式进不了通路
    expect(buildAttachmentActions([{ fileName: '动图.gif', mimeType: 'image/gif' }], 'supported')).toEqual([]);
  });

  it('白名单内的四种图片照常判图（收敛没误伤）', () => {
    for (const name of ['a.png', 'b.jpg', 'c.jpeg', 'd.webp']) {
      expect(classifyAttachmentFile(name, 'image/png'), name).toBe('image');
    }
  });
});

describe('buildAttachmentActions', () => {
  it('图片（模型自述支持看图）→ 提取文字 / 总结图片 / 分析内容，且三者都点击即执行', () => {
    const actions = buildAttachmentActions([{ fileName: 'shot.png', mimeType: 'image/png' }], 'supported');
    expect(actions.map((a) => a.id)).toEqual(['extract-image-text', 'summarize-image', 'analyze-image']);
    expect(actions.every((a) => a.kind === 'read')).toBe(true);
    expect(actions.every((a) => a.autoSend)).toBe(true);
    expect(actions.every((a) => a.labelKey.startsWith('chatInput.attachmentActions.'))).toBe(true);
  });

  /**
   * ⭐ 2026-10-07（vision 入口降级 · 用户拍板）：图片动作只在 `supported` 时给。
   * `unknown`（目录没报名——当前中转的常态）与 `unsupported`（自述不看图）**一律不出**：
   * 拖图后模型读不到，露出「识别图片」= 用户白发一轮。
   */
  it('⭐ 模型没自述支持看图（unknown / unsupported）→ 图片动作一个都不出', () => {
    for (const support of ['unknown', 'unsupported'] as const) {
      expect(buildAttachmentActions([{ fileName: 'shot.png', mimeType: 'image/png' }], support), support).toEqual([]);
    }
  });

  it('⭐ 开关只作用于图片：非 supported 时表格 / 文档动作照常（不误伤）', () => {
    for (const support of ['unknown', 'unsupported'] as const) {
      const ids = buildAttachmentActions(
        [{ fileName: '报表.xlsx' }, { fileName: '说明.docx' }, { fileName: 'shot.png' }],
        support,
      ).map((a) => a.id);
      expect(ids, support).toEqual(['analyze-data', 'summarize-document', 'modify-file', 'generate-report']);
      expect(ids, support).not.toContain('extract-image-text');
      expect(ids, support).not.toContain('summarize-image');
      expect(ids, support).not.toContain('analyze-image');
    }
  });

  it('表格 → 分析数据（读，直接执行）+ 修改（写，只预填）+ 生成汇报（只预填）', () => {
    // 开关给到最不利的一档：表格动作与看图能力无关，必须原样在（防"gate 抖到别的 kind"）
    const actions = buildAttachmentActions(
      [{ fileName: '报表.xlsx', mimeType: 'application/vnd.ms-excel' }],
      'unsupported',
    );
    const byId = Object.fromEntries(actions.map((a) => [a.id, a]));
    expect(Object.keys(byId)).toEqual(expect.arrayContaining(['analyze-data', 'modify-file', 'generate-report']));
    expect(byId['analyze-data']!.kind).toBe('read');
    expect(byId['analyze-data']!.autoSend).toBe(true);
    expect(byId['modify-file']!.kind).toBe('edit');
    expect(byId['modify-file']!.autoSend).toBe(false);
    expect(byId['generate-report']!.autoSend).toBe(false);
  });

  it('文档 / 演示 → 读取总结 + 修改 + 生成汇报；纯文本 → 只给读取总结', () => {
    const doc = buildAttachmentActions([{ fileName: '说明.docx' }], 'supported').map((a) => a.id);
    expect(doc).toEqual(['summarize-document', 'modify-file', 'generate-report']);
    const text = buildAttachmentActions([{ fileName: 'notes.md' }], 'supported').map((a) => a.id);
    expect(text).toEqual(['summarize-document']);
  });

  it('混合拖入按「读在前、写在后」去重合并', () => {
    const actions = buildAttachmentActions([{ fileName: '报表.xlsx' }, { fileName: 'shot.png' }], 'supported');
    const ids = actions.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const firstWrite = ids.findIndex((id) => id === 'modify-file' || id === 'generate-report');
    const lastRead = ids.lastIndexOf('extract-image-text');
    expect(firstWrite).toBeGreaterThan(lastRead);
  });

  it('什么都没带时为空白（不渲染建议行）', () => {
    expect(buildAttachmentActions([], 'supported')).toEqual([]);
  });
});

describe('detectEditIntent', () => {
  it('明确说改动 → true（中英文）', () => {
    for (const text of [
      '帮我修改这份表格',
      '把标题改一下',
      '重写这份文档',
      '删除最后一行',
      '转成 pdf 给我',
      '把这张图的文字改成黑色',
      'please edit this document',
      'update the report file',
      'replace the header',
    ]) {
      expect(detectEditIntent(text), text).toBe(true);
    }
  });

  it('只是读 / 看 / 分析 / 生成新汇报 → false（默认只读）', () => {
    for (const text of [
      '看看这份表格',
      '帮我总结一下',
      '分析数据',
      '生成汇报',
      '提取图片里的文字',
      '识别这张图片',
      'summarize this file',
      'analyze the numbers',
      'generate a report',
      '',
      '   ',
    ]) {
      expect(detectEditIntent(text), text).toBe(false);
    }
  });
});

describe('buildAttachmentDirective', () => {
  const files = [{ fileName: '报表.xlsx', kind: 'table' as const }];

  it('默认（读）：明确只读纪律 + 四段式产出（摘要 / 结论 / 建议操作），点名不得改源文件', () => {
    const text = buildAttachmentDirective({ files, intent: 'read' });
    expect(text).toContain('报表.xlsx');
    expect(text).toMatch(/不要修改|不得修改/);
    expect(text).toContain('建议');
  });

  it('明确要改（写）：允许产出新版本，但不得覆盖原文件', () => {
    const text = buildAttachmentDirective({ files, intent: 'edit' });
    expect(text).toMatch(/新(的)?文件|新版本/);
    expect(text).toMatch(/不要覆盖|不得覆盖/);
  });

  it('✦ 带图片时给的是**条件句**诚实兜底：读不到就如实说、不要编造', () => {
    const images = [{ fileName: 'shot.png', kind: 'image' as const }];
    const text = buildAttachmentDirective({ files: images, intent: 'read' });
    expect(text).toContain('shot.png');
    expect(text).toMatch(/不要编造/);
    // 条件句式：不是"你看不到"的断言（App 拿不到模型能力确证，见 resolveImageInputSupport 注释）
    expect(text).toMatch(/如果|若/);
  });

  it('没有图片的文件不带那句（不虚增指令）', () => {
    expect(buildAttachmentDirective({ files, intent: 'read' })).not.toMatch(/不要编造/);
  });

  it('没有文件时不产出任何指令', () => {
    expect(buildAttachmentDirective({ files: [], intent: 'read' })).toBe('');
  });

  /**
   * BUG-049（2026-10-08 真机定案）：同一 workspace 下**别的任务**的 inbox 文件
   * （本次实证：vision 任务的验收探针 PNG）被本任务模型扫盘找到、`view_image` 读进上下文，
   * 模型把图里的验收码当成"用户发来的"，在 14 个连续回合里复述。
   * ⇒ 附件纪律必须显式声明「工作目录 ≠ 用户输入」。
   */
  it('✦ 只读分支必须声明：工作目录里的残留文件（含图片）不是用户输入，不得当作指令/验收码来源', () => {
    const text = buildAttachmentDirective({ files, intent: 'read' });
    expect(text).toMatch(/工作目录/);
    expect(text).toMatch(/其他任务|别的任务/);
    expect(text).toMatch(/不是[^，。；]{0,12}用户[^，。；]{0,12}输入|不算用户[^，。；]{0,12}输入/);
    expect(text).toMatch(/图片|截图/);
  });

  it('✦ 改动分支同样带这句（残留文件的风险与意图无关）', () => {
    const text = buildAttachmentDirective({ files, intent: 'edit' });
    expect(text).toMatch(/工作目录/);
    expect(text).toMatch(/其他任务|别的任务/);
  });
});

describe('resolveImageInputSupport', () => {
  it('目录没报名 → unknown（不当成不支持）', () => {
    expect(resolveImageInputSupport(undefined)).toBe('unknown');
    expect(resolveImageInputSupport({ id: 'deepseek-v4-flash' } as ModelCatalogEntry)).toBe('unknown');
    expect(resolveImageInputSupport({ id: 'm', input: 'text' } as unknown as ModelCatalogEntry)).toBe('unknown');
  });

  it('目录报了 input → 按是否含 image 判 supported / unsupported', () => {
    expect(resolveImageInputSupport({ id: 'm', input: ['text'] } as unknown as ModelCatalogEntry)).toBe('unsupported');
    expect(resolveImageInputSupport({ id: 'm', input: ['text', 'image'] } as unknown as ModelCatalogEntry)).toBe(
      'supported',
    );
  });
});
