import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SlidegenToolProgress } from '@clawwork/shared';
import { readWorkspaceBytes } from '../slidegen/source-file.js';
import { readSlideGenerationReceipt, writeSlideGenerationReceipt } from '../slidegen/receipt.js';
import { parseTemplateDeck } from './pptx-template/parse.js';
import { renderPptxFromTemplate } from './pptx-template/render.js';
import { checkNativePpt } from './pptx-template/check.js';
import { documentFileStem } from '../util/document-file-name.js';
import { renderSlotNativePpt } from './template-deck-file.js';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface NativePptReport {
  schemaVersion: 1;
  status: 'file-generated' | 'source-invalid' | 'render-failed';
  fileCreated: boolean;
  artifactIndexed: false;
  visualReview: 'not-performed';
  officeReview: 'not-performed';
  contentReview?: 'field-coverage-passed';
  qualityStatus?: 'needs-review';
  sourceSha256?: string;
  outputSha256?: string;
  fileName?: string;
  bytes?: number;
  pages?: number;
  receiptFile?: string;
  receiptStatus?: 'ready';
  revision?: number;
  previousOutputSha256?: string;
  diagnostics?: unknown[];
}

export async function renderNativePptFile(
  file: string,
  workspace: string,
  options: {
    templatesRoot?: string;
    enabled?: boolean;
    previous?: string;
    sourceReceipt?: string;
    isCurrent?: () => boolean;
    onPage?: (progress: SlidegenToolProgress) => void;
    ensureTemplateFont?: (root: string) => Promise<void>;
  },
): Promise<NativePptReport> {
  let rendering = false,
    fileCreated = false;
  const base = {
    schemaVersion: 1 as const,
    artifactIndexed: false as const,
    visualReview: 'not-performed' as const,
    officeReview: 'not-performed' as const,
  };
  try {
    if (!options.enabled) throw new Error('native-validation-disabled');
    const root = fs.realpathSync(workspace),
      identity = fs.statSync(root);
    const assertCurrent = () => {
      const current = fs.statSync(root);
      if (current.dev !== identity.dev || current.ino !== identity.ino || options.isCurrent?.() === false)
        throw new Error('native-task-canceled');
    };
    assertCurrent();
    const provedSource = options.sourceReceipt ? readSlideGenerationReceipt(root, options.sourceReceipt) : undefined;
    if (provedSource) {
      if (
        !options.previous ||
        provedSource.sourceFormat !== 'native-template-v5' ||
        provedSource.sourceFile !== file ||
        provedSource.revision !== 0
      )
        throw new Error('native-revision-source-invalid');
    } else if (!file.endsWith('.native-ppt.json')) throw new Error('native-source-name-invalid');
    const source = readWorkspaceBytes(root, file, 1024 * 1024),
      sourceSha256 = hash(source);
    if (provedSource && provedSource.sourceSha256 !== sourceSha256) throw new Error('native-source-changed');
    const sourceText = new TextDecoder('utf-8', { fatal: true }).decode(source);
    let raw: unknown;
    try {
      raw = JSON.parse(sourceText);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid JSON source';
      const match = /\bat position (\d+)(?: \(line \d+ column \d+\))?$/.exec(message);
      const position = match
        ? Number(match[1])
        : /^unexpected end of JSON input$/i.test(message)
          ? sourceText.length
          : undefined;
      const prefix = position === undefined ? undefined : sourceText.slice(0, position);
      const lines = prefix?.split(/\r\n|\r|\n/);
      const line = lines?.length;
      const column = lines === undefined ? undefined : lines[lines.length - 1].length + 1;
      return {
        ...base,
        status: 'source-invalid',
        fileCreated: false,
        sourceSha256,
        diagnostics: [
          {
            code: 'native-source-json-invalid',
            message,
            ...(position === undefined ? {} : { position, line, column }),
          },
        ],
      };
    }
    if (raw && typeof raw === 'object' && 'template' in raw && raw.template === 'templateDeck') {
      return renderSlotNativePpt({
        raw,
        source,
        sourceName: file,
        root,
        templatesRoot: options.templatesRoot,
        previous: options.previous,
        assertCurrent,
        ensureFont: options.ensureTemplateFont,
        onPage: options.onPage,
      });
    }
    // ⚠️ 旧受控支路（business-deck-v5，四页型试运行）：保留**只**为修订既有 v5 成品
    //    （--previous 链）。受控环境当前唯一的模型侧契约是上面的 templateDeck
    //    （2026-10-03 版本对齐；收据 sourceFormat 可对）。
    const parsed = parseTemplateDeck(raw, { controlledNative: true });
    if (!parsed.ok)
      return { ...base, status: 'source-invalid', fileCreated: false, sourceSha256, diagnostics: [parsed.failure] };
    if (!parsed.deck.controlledNative) throw new Error('native-template-required');
    let revision = 0,
      previousOutputSha256: string | undefined;
    let previousFileName: string | undefined;
    if (options.previous) {
      const previous = readSlideGenerationReceipt(root, options.previous);
      if (previous.sourceFormat !== 'native-template-v5') throw new Error('native-parent-invalid');
      revision = (previous.revision ?? 0) + 1;
      previousOutputSha256 = previous.outputSha256;
      previousFileName = previous.fileName;
      const previousInput = parseTemplateDeck(
        JSON.parse(readWorkspaceBytes(root, previous.sourceFile, 1024 * 1024).toString('utf8')),
        { controlledNative: true },
      );
      if (!previousInput.ok) throw new Error('native-parent-invalid');
      const charts = (slides: typeof parsed.deck.slides) =>
        slides.filter((slide) => slide.chart).map((slide) => slide.chart);
      if (JSON.stringify(charts(previousInput.deck.slides)) !== JSON.stringify(charts(parsed.deck.slides)))
        throw new Error('native-revision-chart-data-changed');
      const numbers = (slides: typeof parsed.deck.slides) =>
        slides
          .flatMap((slide) => Object.values(slide.data).flatMap((value) => value.match(/\d+(?:\.\d+)?%?/g) ?? []))
          .sort();
      if (JSON.stringify(numbers(previousInput.deck.slides)) !== JSON.stringify(numbers(parsed.deck.slides)))
        throw new Error('native-revision-data-changed');
    }
    if (!options.templatesRoot) throw new Error('native-template-unavailable');
    const snapshot = fs.mkdtempSync(path.join(root, '.royin-native-'));
    const sourceFile = path.relative(root, path.join(snapshot, 'source.json')).replaceAll('\\', '/');
    fs.writeFileSync(path.join(snapshot, 'source.json'), source, { flag: 'wx' });
    const resources = ['business-deck-v5.pptx', 'blank-root.pptx'].map((name) => {
      let bytes: Buffer;
      try {
        bytes = readWorkspaceBytes(options.templatesRoot!, name, 16 * 1024 * 1024);
      } catch {
        throw new Error('native-template-unavailable');
      }
      fs.writeFileSync(path.join(snapshot, name), bytes, { flag: 'wx' });
      return {
        file: path.relative(root, path.join(snapshot, name)).replaceAll('\\', '/'),
        bytes: bytes.length,
        sha256: hash(bytes),
      };
    });
    rendering = true;
    assertCurrent();
    const title =
      typeof raw === 'object' && raw !== null && 'title' in raw && typeof raw.title === 'string'
        ? raw.title
        : 'presentation';
    const stem = documentFileStem(title, 'presentation');
    const fileName = `${stem.startsWith('.') ? '_' : ''}${stem}-${randomUUID().slice(0, 8)}.pptx`;
    const buffer = await renderPptxFromTemplate({ raw, templatesRoot: snapshot, fileName, controlledNative: true });
    assertCurrent();
    if (hash(readWorkspaceBytes(root, file, 1024 * 1024)) !== sourceSha256) throw new Error('native-source-changed');
    checkNativePpt(buffer, parsed.deck);
    for (let completed = 1; completed <= parsed.deck.slides.length; completed++)
      options.onPage?.({
        schemaVersion: 1,
        status: 'slidegen-progress',
        sourceSha256,
        completed,
        total: parsed.deck.slides.length,
      });
    assertCurrent();
    const outputSha256 = hash(buffer),
      pages = parsed.deck.slides.length;
    fs.writeFileSync(path.join(root, fileName), buffer, { flag: 'wx' });
    fileCreated = true;
    const receiptFile = path.basename(
      writeSlideGenerationReceipt(root, {
        sourceFormat: 'native-template-v5',
        revision,
        previousOutputSha256,
        previousFileName,
        previousReceiptFile: options.previous,
        sourceFile,
        sourceSha256,
        fileName,
        outputSha256,
        bytes: buffer.length,
        pages,
        resources,
        warnings: [],
      }),
    );
    return {
      ...base,
      status: 'file-generated',
      fileCreated,
      sourceSha256,
      fileName,
      outputSha256,
      bytes: buffer.length,
      pages,
      receiptFile,
      receiptStatus: 'ready',
      contentReview: 'field-coverage-passed',
      qualityStatus: 'needs-review',
      revision,
      ...(previousOutputSha256 ? { previousOutputSha256 } : {}),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '';
    return {
      ...base,
      status: rendering ? 'render-failed' : 'source-invalid',
      fileCreated,
      diagnostics: [{ code: /^(native-|receipt-|source-)/.test(detail) ? detail : 'native-render-failed' }],
    };
  }
}
