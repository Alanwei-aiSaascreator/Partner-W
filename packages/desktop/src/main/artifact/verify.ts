/**
 * 产物完整性校验（M1「登记前置门」的判据本体）。
 *
 * ## 为什么需要它（2026-10-06，V1 收口 P0）
 *
 * 真机上出现过两类事故：
 * 1. 半截/未写完的 `.pptx` 被登记进产物，用户点开是坏文件（图14/16 的"打不开"族）；
 * 2. 同一任务的多个重复尝试全部进列表，放大事故面（图16）。
 *
 * 本模块负责第 1 类：**登记之前**做一次轻量但真实的完整性检查。检查不过 ⇒
 * 调用方（`save.ts` 的写入路径、`reconcile.ts` 的收编路径）**拒绝登记**。
 *
 * ## 判据为什么是这几条（均为"可打开"的必要条件，而不是深度质量校验）
 *
 * - ZIP 中央目录可读（`listZipEntries` 走尾部中央目录，截断文件在此现形）；
 * - `[Content_Types].xml` 在场（OOXML 包的门面）；
 * - `ppt/presentation.xml` 在场且**条目字节能取出**（截断在条目边界内也会现形）；
 * - 至少一张 `ppt/slides/slideN.xml`。
 *
 * `.docx` 与 `.pptx` 同构（必要件换成 `word/document.xml`；判据 `verifyDocxBuffer`）——
 * 用户反馈 #9 的"新 docx 打不开/乱码"与图14/16 是同一类事故，走同一道门。
 *
 * 更深的逐页/占位符校验属于**模板链的 receipt 通道**（`docgen/template-deck/check.ts`），
 * 不在这里重复——这里只把"物理上打不开"挡在登记之外，不做内容质量裁决。
 *
 * ⚠️ 本模块**不 import 任何 fs**：纯 Buffer 判定，供写入路径（内存 buffer）与
 *    收编路径（自行读文件）复用，也让单测零 mock。
 */
import { extname } from 'node:path';
import { listZipEntries, readZipEntry } from '../preview/zip-entry.js';

/** 校验失败原因（结构化，进日志/事件；文案由界面层按需本地化）。 */
export type ArtifactIntegrityFailure =
  | 'unreadable'
  | 'not-a-zip'
  | 'missing-content-types'
  | 'missing-presentation'
  | 'no-slides'
  | 'missing-document'
  | 'missing-workbook'
  | 'not-a-pdf'
  | 'truncated-pdf'
  | 'part-unreadable';

export type ArtifactIntegrityResult = { ok: true } | { ok: false; reason: ArtifactIntegrityFailure };

/**
 * 校验拒绝的**类型化**错误：调用方据此区分"文件本身不合格"与"IO/DB 事故"。
 * 写入路径（`save.ts`）抛它；收编路径（`reconcile.ts`）不抛，直接记 `skipped`。
 */
export class ArtifactIntegrityError extends Error {
  readonly reason: ArtifactIntegrityFailure;

  constructor(reason: ArtifactIntegrityFailure) {
    super(`artifact failed integrity verification: ${reason}`);
    this.name = 'ArtifactIntegrityError';
    this.reason = reason;
  }
}

/**
 * 需要走完整性校验的格式：**OOXML 包 + PDF**（`.pptx` / `.docx` / `.xlsx` / `.pdf`）——
 * 图14/16 与反馈 #9（"新 docx 打不开/乱码"）的重灾区；其余格式后续按需扩展。
 *
 * ⚠️ `.xlsx` / `.pdf` 是 2026-10-07 体检补的（P2-6）：这两类原来**完全无门**，
 *    半截表格 / 截断 PDF 照样进列表；而 `artifact:open-file` 现在也按这份名单做打开前复核。
 *
 * ⚠️ 这是**格式集合的唯一单点**：`save.ts` / `reconcile.ts` 的登记门、`artifact:open-file`
 *    的打开前复核全部先过这里，再交给 `verifyArtifactBuffer` 按扩展名派判据。加格式只改这一处。
 */
export function isVerifiedFileName(fileName: string): boolean {
  const ext = extname(fileName).toLowerCase();
  return ext === '.pptx' || ext === '.docx' || ext === '.xlsx' || ext === '.pdf';
}

export function verifyPptxBuffer(buffer: Buffer): ArtifactIntegrityResult {
  const entries = listZipEntries(buffer);
  if (entries.length === 0) return { ok: false, reason: 'not-a-zip' };
  const parts = new Set(entries);
  if (!parts.has('[Content_Types].xml')) return { ok: false, reason: 'missing-content-types' };
  if (!parts.has('ppt/presentation.xml')) return { ok: false, reason: 'missing-presentation' };
  if (!entries.some((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))) return { ok: false, reason: 'no-slides' };
  if (!readZipEntry(buffer, '[Content_Types].xml') || !readZipEntry(buffer, 'ppt/presentation.xml'))
    return { ok: false, reason: 'part-unreadable' };
  return { ok: true };
}

/**
 * `.docx` 的完整性判据（与 pptx 同构，必要件换成 Word 的）。
 *
 * 2026-10-06 用户反馈 #9（原话："重新生成 docx：桌面出现 js 文件；**新 docx 打不开/乱码**"）：
 * 旧实现里 docx 不在门槛内 ⇒ 模型把纯文本改名成 `.docx`、或 docgen 写了一半的半截包，
 * 照样进产物列表 —— Word/WPS 打开报损坏/乱码。这里把"物理上打不开"挡在登记之外。
 *
 * 判据与 pptx 门同一哲学（必要件在场 + 条目字节能取出），不做内容质量裁决。
 */
export function verifyDocxBuffer(buffer: Buffer): ArtifactIntegrityResult {
  const entries = listZipEntries(buffer);
  if (entries.length === 0) return { ok: false, reason: 'not-a-zip' };
  const parts = new Set(entries);
  if (!parts.has('[Content_Types].xml')) return { ok: false, reason: 'missing-content-types' };
  if (!parts.has('word/document.xml')) return { ok: false, reason: 'missing-document' };
  if (!readZipEntry(buffer, '[Content_Types].xml') || !readZipEntry(buffer, 'word/document.xml'))
    return { ok: false, reason: 'part-unreadable' };
  return { ok: true };
}

/**
 * `.xlsx` 的完整性判据（与 pptx/docx 同构，必要件换成 Excel 的）。
 *
 * 2026-10-07 体检 P2-6：`.xlsx` 原来**不在受检名单里** ⇒ 截断的工作簿（docgen 写一半、
 * 模型写到一半）照样登记，点开就是"打不开"。判据仍是"必要件在场 + 条目字节能取出"，
 * 不做内容质量裁决。
 */
export function verifyXlsxBuffer(buffer: Buffer): ArtifactIntegrityResult {
  const entries = listZipEntries(buffer);
  if (entries.length === 0) return { ok: false, reason: 'not-a-zip' };
  const parts = new Set(entries);
  if (!parts.has('[Content_Types].xml')) return { ok: false, reason: 'missing-content-types' };
  if (!parts.has('xl/workbook.xml')) return { ok: false, reason: 'missing-workbook' };
  if (!readZipEntry(buffer, '[Content_Types].xml') || !readZipEntry(buffer, 'xl/workbook.xml'))
    return { ok: false, reason: 'part-unreadable' };
  return { ok: true };
}

/**
 * `.pdf` 的完整性判据：**头 + 尾两个标记**。
 *
 * - 头：`%PDF-`（规范要求在第一行；给 1 KiB 的宽容窗，挡的是"纯文本/别的二进制改了后缀"）；
 * - 尾：`%%EOF`（落在末 1 KiB 内）—— 截断/写到一半的 PDF 头部照样在，**只有尾巴能证明它写完了**。
 *
 * ⚠️ 这是"能不能打开"的**必要条件**，不是深度校验（不做对象表/交叉引用解析）。
 *    尾部窗口给 1 KiB 是为了容忍尾随空白/换行（各家生成器都会留）。
 */
export function verifyPdfBuffer(buffer: Buffer): ArtifactIntegrityResult {
  if (buffer.length === 0) return { ok: false, reason: 'not-a-pdf' };
  if (buffer.subarray(0, Math.min(buffer.length, 1024)).indexOf('%PDF-') === -1) {
    return { ok: false, reason: 'not-a-pdf' };
  }
  const tail = buffer.subarray(Math.max(0, buffer.length - 1024));
  if (tail.indexOf('%%EOF') === -1) return { ok: false, reason: 'truncated-pdf' };
  return { ok: true };
}

/**
 * 登记门的**单一派发入口**：调用方（save/reconcile/open-file 复核）只管"名字是受检格式吗"，
 * 具体判据按扩展名在这里选。非受检格式直接放行（调用点先过 `isVerifiedFileName`，
 * 正常到不了这里；这里放行而不是报错，避免把"不该校验"变成"登记失败"）。
 */
export function verifyArtifactBuffer(fileName: string, buffer: Buffer): ArtifactIntegrityResult {
  const ext = extname(fileName).toLowerCase();
  if (ext === '.docx') return verifyDocxBuffer(buffer);
  if (ext === '.pptx') return verifyPptxBuffer(buffer);
  if (ext === '.xlsx') return verifyXlsxBuffer(buffer);
  if (ext === '.pdf') return verifyPdfBuffer(buffer);
  return { ok: true };
}
