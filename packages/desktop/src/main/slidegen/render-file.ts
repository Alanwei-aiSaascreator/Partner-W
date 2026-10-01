import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SlideChild } from './dsl.js';
import { preflightSource } from './preflight.js';
import { extractSlidegenBlocks } from './blocks.js';
import { evaluateSlide } from './evaluate.js';
import { renderSlideDeck } from './render-deck.js';
import { contained, readSlideSourceFile, readWorkspaceBytes } from './source-file.js';
import { documentFileStem } from '../util/document-file-name.js';

function imageNames(nodes: readonly SlideChild[]): string[] {
  const names = new Set<string>();
  const visit = (node: SlideChild) => {
    if (!node || typeof node !== 'object' || node.kind !== 'element') return;
    if (node.tag === 'Image') {
      let src: string;
      try {
        if (typeof node.props.src !== 'string') throw new Error('invalid image');
        src = decodeURIComponent(node.props.src);
      } catch {
        throw new Error('resource-source-invalid');
      }
      if (/^[\\/]|^[a-z]+:/i.test(src) || src.split(/[\\/]/).includes('..')) throw new Error('resource-source-invalid');
      const name = path.basename(src);
      names.add(name);
      node.props.src = encodeURIComponent(name);
    }
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return [...names].sort();
}

export async function renderSlideSourceFile(file: string, workspace: string) {
  let rendering = false;
  let snapshot: { root: string; path: string; identity: fs.Stats } | undefined;
  let sourceSha256: string | undefined;
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
    const fileName = `${documentFileStem(decks[0].title, 'presentation')}-${randomUUID().slice(0, 8)}.pptx`;
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
    return {
      schemaVersion: 1,
      status: 'file-generated',
      sourceSha256,
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
    };
  } catch (error) {
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
