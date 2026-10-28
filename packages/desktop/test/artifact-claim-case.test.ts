import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkClaimedFiles, extractClaimedFileNames } from '../src/main/artifact/claim-guard';

/**
 * ⭐ T22（2026-10-16 本地全量执行 · Owner D）：**同文件大小写/别名**在声称核对里不许被当成"缺失"。
 *
 * ## 缺口（修之前）
 *
 * `findFileRecursive` 用 `entry.name !== fileName` 做**大小写敏感**的比较。而本产品的目标平台
 * 是 Windows（NTFS/exFAT **不区分大小写**）：盘上的 `报告.PPTX` 与回复里写的 `报告.pptx`
 * **是同一个文件**，守卫却判它"不在" ⇒ 界面弹「说好的文件不在」——**冤枉模型**。
 * 这正是模块开头明确要避免的方向（"冤枉模型的提示比不提示更糟"），也是 T22 验收里
 * 点名的"同文件大小写/别名"。
 *
 * ## 边界（收窄到"同名不同大小写"，不是模糊匹配）
 *
 * 只把**整名比较**改成平台口径的大小写等价；不做前缀/相似/扩展名族匹配 ——
 * `other.docx` 绝不会因为 `report.docx` 的存在而算命中（下面的负对照钉住它）。
 */

const validPptx = async (): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  zip.file('ppt/presentation.xml', '<?xml version="1.0"?><p:presentation/>');
  zip.file('ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld/>');
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;
};

const validDocx = async (): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document/>');
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'claim-case-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('⭐ T22 · 同文件大小写/别名：存在的文件不许被报成"缺失"', () => {
  it('⭐ 盘上 `报告.PPTX`、回复写 `报告.pptx` ⇒ present（旧实现判 missing = 冤枉）', async () => {
    writeFileSync(join(root, '报告.PPTX'), await validPptx());
    const result = checkClaimedFiles('已生成 报告.pptx，请查收。', [root]);
    expect(result.missing).toEqual([]);
    expect(result.present.map((f) => f.name)).toContain('报告.pptx');
  });

  it('⭐ 扩展名大小写（`Report.DOCX` vs `report.docx`）⇒ present', async () => {
    writeFileSync(join(root, 'Report.DOCX'), await validDocx());
    const result = checkClaimedFiles('已生成 report.docx 请查收', [root]);
    expect(result.missing).toEqual([]);
  });

  it('⭐ 子目录里的同文件（taskId 子目录）+ 大小写差 ⇒ 仍命中', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, 'task-1'));
    writeFileSync(join(root, 'task-1', 'Deck.PPTX'), await validPptx());
    const result = checkClaimedFiles('已生成 deck.pptx 请查收', [root]);
    expect(result.missing).toEqual([]);
  });

  it('负对照：只有别的名字（不同名）⇒ 仍判 missing（不是模糊匹配）', async () => {
    writeFileSync(join(root, 'other.docx'), await validDocx());
    const result = checkClaimedFiles('已生成 report.docx 请查收', [root]);
    expect(result.missing.map((f) => f.name)).toContain('report.docx');
  });

  it('负对照：名字只差扩展名（.docx vs .pptx）⇒ 不算同一份，仍 missing', async () => {
    writeFileSync(join(root, 'report.docx'), await validDocx());
    const result = checkClaimedFiles('已生成 report.pptx 请查收', [root]);
    expect(result.missing.map((f) => f.name)).toContain('report.pptx');
  });

  it('提取阶段本身与大小写无关（名字原样抠出，裁决在存在性核对）', () => {
    expect(extractClaimedFileNames('已生成 报告.PPTX 请查收').map((n) => n.name)).toContain('报告.PPTX');
  });
});
