import fs from 'node:fs';
import path from 'node:path';
import { DECK_FILE_MAX_BYTES, isDeckFileName } from './deck-file.js';

export function contained(root: string, file: string) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function readWorkspaceBytes(workspace: string, file: string, limit: number) {
  const root = fs.realpathSync(workspace);
  const requested = path.resolve(root, file);
  if (!contained(root, requested)) throw new Error('source-outside-workspace');
  const canonical = fs.realpathSync(requested);
  if (!contained(root, canonical)) throw new Error('source-outside-workspace');
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error('source-not-file');
    if (before.size > limit) throw new Error('file-too-large');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (!read) break;
      length += read;
    }
    const after = fs.fstatSync(fd);
    const current = fs.statSync(canonical);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      length !== after.size ||
      current.dev !== after.dev ||
      current.ino !== after.ino ||
      fs.realpathSync(canonical) !== canonical
    )
      throw new Error('source-changed-during-read');
    if (length > limit) throw new Error('file-too-large');
    return buffer.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}

export function readSlideSourceFile(workspace: string, file: string) {
  if (!isDeckFileName(path.basename(file))) throw new Error('source-argument-invalid');
  let buffer: Buffer;
  try {
    buffer = readWorkspaceBytes(workspace, file, DECK_FILE_MAX_BYTES);
  } catch (error) {
    if (error instanceof Error && error.message === 'file-too-large') throw new Error('slidegen-file-too-large');
    throw error;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new Error('source-encoding-invalid');
  }
}
