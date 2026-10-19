import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SlidegenToolProgress } from '@clawwork/shared';
import { preflightSource } from './preflight.js';
import { extractSlidegenBlocks } from './blocks.js';
import { evaluateSlide } from './evaluate.js';
import { renderSlideDeck } from './render-deck.js';
import { contained, readSlideSourceFile, readWorkspaceBytes } from './source-file.js';
import { openRenderSegmentCheckpoint, type RenderSegmentCheckpoint } from './render-segments.js';
import { documentFileStem } from '../util/document-file-name.js';
import { imageNames } from './resources.js';
import { writeSlideGenerationReceipt } from './receipt.js';

export async function renderSlideSourceFile(
  file: string,
  workspace: string,
  options: { onPage?: (progress: SlidegenToolProgress) => void } = {},
) {
  let rendering = false;
  let snapshot: { root: string; path: string; identity: fs.Stats } | undefined;
  let sourceSha256: string | undefined;
  /**
   * ⭐ staged/chunked（P20）：分段账本的生命周期（"谁在什么时候留、什么时候清"）。
   *
   * - **硬中断**（关窗 / 强杀 / 断电）：这里一行代码都不会跑 ⇒ 账本与已完成的段**留在盘上**
   *   ⇒ 下一次跑同一份源从断点接上。这正是这一层存在的理由。
   * - **优雅失败**（本函数正常返回 `render-failed`）：源多半是坏的，模型改完源就换了
   *   sha256 ⇒ 旧账本对新源**本来就作废**；留着只是垃圾。所以在这里清掉，
   *   **既有契约"失败后工作区不留临时数据"一个字都不改**（`renderSlideDeck` 成功时也自清）。
   */
  let checkpoint: RenderSegmentCheckpoint | null = null;
  try {
    const root = fs.realpathSync(workspace);
    const owner = fs.statSync(root);
    const assertCurrent = () => {
      const current = fs.statSync(root);
      if (current.dev !== owner.dev || current.ino !== owner.ino) throw new Error('workspace-changed-during-render');
    };
    const source = readSlideSourceFile(root, file);
    const preflight = preflightSource(source);
    sourceSha256 = preflight.sourceSha256;
    if (preflight.status !== 'source-valid') return { ...preflight, fileCreated: false, artifactIndexed: false };
    const decks = extractSlidegenBlocks(source).decks;
    if (decks.length !== 1) throw new Error('source-one-deck-required');
    rendering = true;
    const pages = evaluateSlide(decks[0].source);
    const assetsPrefix = fs.existsSync(path.join(root, 'assets')) ? 'assets' : '';
    const resources: Array<{ name: string; bytes: number; sha256: string }> = [];
    const snapshotPath = fs.mkdtempSync(path.join(root, '.slidegen-assets-'));
    snapshot = { root, path: snapshotPath, identity: fs.statSync(snapshotPath) };
    let assetBytes = 0;
    for (const name of imageNames(pages)) {
      let bytes: Buffer;
      try {
        bytes = readWorkspaceBytes(root, path.join(assetsPrefix, name), 16 * 1024 * 1024);
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        throw new Error(
          code === 'source-outside-workspace'
            ? 'resource-outside-workspace'
            : code === 'file-too-large'
              ? 'resource-too-large'
              : 'resource-unavailable',
        );
      }
      assetBytes += bytes.length;
      if (assetBytes > 64 * 1024 * 1024) throw new Error('resource-budget-exceeded');
      fs.writeFileSync(path.join(snapshotPath, name), bytes, { flag: 'wx' });
      resources.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    const result = await renderSlideDeck({
      pages,
      workspacePath: snapshotPath,
      assetsRoot: snapshotPath,
      /**
       * ⭐ staged/chunked（P20）：逐页排版 + 量框是这条链上唯一"长且可中断"的一段，
       * 每做完一页就把形状落进**真实工作区**（不是这个临时快照目录 —— 它在 finally 里
       * 会被整个删掉，放进去等于没存）。账本键 = 源文件 sha256：源一变整份账本作废，
       * 绝不把上一份源的页形状套到新源上。出片成功后 `renderSlideDeck` 自己清账本。
       */
      segments: (checkpoint = openRenderSegmentCheckpoint({
        workspace: root,
        planDigest: preflight.sourceSha256,
        total: pages.length,
      })),
      onPage: (completed, total) => {
        if (readSlideSourceFile(root, file) !== source) throw new Error('source-changed-during-render');
        options.onPage?.({
          schemaVersion: 1,
          status: 'slidegen-progress',
          sourceSha256: preflight.sourceSha256,
          completed,
          total,
        });
      },
      assertCurrent: () => {
        assertCurrent();
        try {
          const current = fs.lstatSync(snapshotPath);
          if (current.dev !== snapshot!.identity.dev || current.ino !== snapshot!.identity.ino)
            throw new Error('changed snapshot');
          for (const resource of resources) {
            const bytes = readWorkspaceBytes(snapshotPath, resource.name, 16 * 1024 * 1024);
            if (createHash('sha256').update(bytes).digest('hex') !== resource.sha256) throw new Error('changed image');
          }
        } catch {
          throw new Error('resource-snapshot-changed');
        }
      },
    });
    assertCurrent();
    if (readSlideSourceFile(root, file) !== source) throw new Error('source-changed-during-render');
    const stem = documentFileStem(decks[0].title, 'presentation');
    const fileName = `${stem.startsWith('.') ? '_' : ''}${stem}-${randomUUID().slice(0, 8)}.pptx`;
    const destination = path.join(root, fileName);
    if (!contained(root, destination)) throw new Error('output-outside-workspace');
    const fd = fs.openSync(destination, 'wx');
    try {
      fs.writeFileSync(fd, result.buffer);
    } catch (error) {
      const owned = fs.fstatSync(fd);
      const current = fs.statSync(destination);
      if (owned.dev === current.dev && owned.ino === current.ino) fs.unlinkSync(destination);
      throw error;
    } finally {
      fs.closeSync(fd);
    }
    let receipt:
      | { receiptStatus: 'ready'; receiptFile: string }
      | {
          receiptStatus: 'unavailable';
          receiptDiagnostic: string;
        };
    try {
      const receiptFile = writeSlideGenerationReceipt(root, {
        sourceFile: path.relative(root, path.resolve(root, file)).replaceAll('\\', '/'),
        sourceSha256,
        fileName,
        outputSha256: result.outputSha256,
        bytes: result.bytes,
        pages: result.pages,
        resources: resources.map((resource) => ({
          file: path.posix.join(assetsPrefix, resource.name),
          bytes: resource.bytes,
          sha256: resource.sha256,
        })),
        warnings: result.warnings,
      });
      receipt = { receiptStatus: 'ready', receiptFile: path.basename(receiptFile) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : '';
      receipt = {
        receiptStatus: 'unavailable',
        receiptDiagnostic: detail.length <= 100 && /^receipt-[a-z-]+$/.test(detail) ? detail : 'receipt-unavailable',
      };
    }
    return {
      schemaVersion: 1,
      status: 'file-generated',
      sourceSha256,
      /**
       * ⭐ **东西写在哪**（B 包，2026-10-07）：成品与收据所在目录的**真实路径**。
       *
       * 为什么必须报告它：落点 = 跑这条命令时的 cwd（`process.cwd()`），**主进程对此
       * 零控制、也不知墙**。模型把 cwd 设成应用工作区根层（或任何别的目录）时，
       * 主进程只按助手工作区找收据 ⇒ 读不到 ⇒ 那份真产出被判成"未确认"。
       * 收据就写在同一目录里、且绑定了该目录的身份（dev/ino），所以这一句是
       * "把收据找回来、再把成品登记进任务目录"的唯一线索。
       * ⚠️ 必须是 `root` 的 realpath（`root = fs.realpathSync(workspace)`），与收据里的
       *    `workspaceIdentity` 同一口径 —— 写别的形状，另一头拿去读会直接读不到。
       */
      outputDir: root,
      fileName,
      pages: result.pages,
      bytes: result.bytes,
      outputSha256: result.outputSha256,
      resources,
      warnings: result.warnings,
      layoutReview: result.warnings.length ? 'warnings' : 'no-known-warnings',
      visualReview: result.visualReview,
      fileCreated: true,
      artifactIndexed: false,
      ...receipt,
    };
  } catch (error) {
    // 优雅失败：源多半要重写（换了 sha256 旧账本就作废），留着只污染工作区 ⇒ 清掉。
    // ⚠️ 硬中断走不到这里（没有代码会跑）——那正是账本要活下来的场景。
    try {
      checkpoint?.clear();
    } catch {
      /* best-effort：清账本失败不能顶掉真正的失败原因 */
    }
    const detail = error instanceof Error ? error.message : '';
    const code = /^(?:source-|resource-|workspace-|output-|slidegen-file-too-large$)/.test(detail)
      ? detail
      : rendering
        ? 'render-failed'
        : 'source-unreadable';
    return {
      schemaVersion: 1,
      status: rendering ? 'render-failed' : 'source-invalid',
      sourceSha256,
      diagnostics: [{ code }],
      fileCreated: false,
      artifactIndexed: false,
      visualReview: 'not-performed',
    };
  } finally {
    if (snapshot && contained(snapshot.root, snapshot.path) && fs.existsSync(snapshot.path)) {
      const current = fs.lstatSync(snapshot.path);
      if (current.dev === snapshot.identity.dev && current.ino === snapshot.identity.ino)
        fs.rmSync(snapshot.path, { recursive: true, force: true });
    }
  }
}
