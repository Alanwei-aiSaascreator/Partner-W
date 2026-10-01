import fs from 'node:fs';
import path from 'node:path';
import { DECK_FILE_MAX_BYTES, isDeckFileName } from './deck-file.js';
import { preflightSource } from './preflight.js';

function contained(root: string, file: string) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readSource(file: string) {
  const root = fs.realpathSync(process.cwd());
  const requested = path.resolve(root, file);
  if (!contained(root, requested)) throw new Error('source-outside-workspace');
  const canonical = fs.realpathSync(requested);
  if (!contained(root, canonical)) throw new Error('source-outside-workspace');
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error('source-not-file');
    if (before.size > DECK_FILE_MAX_BYTES) throw new Error('slidegen-file-too-large');
    const buffer = Buffer.alloc(DECK_FILE_MAX_BYTES + 1);
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
    if (length > DECK_FILE_MAX_BYTES) throw new Error('slidegen-file-too-large');
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new Error('source-encoding-invalid');
    }
  } finally {
    fs.closeSync(fd);
  }
}

function run() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') {
    const result = preflightSource('```slidegen\n// title: self-test\n<Slide><Text>Ready</Text></Slide>\n```');
    return { command: 'slidegen-source-preflight', schemaVersion: 1, ok: result.status === 'source-valid' };
  }
  try {
    if (args.length !== 1 || !isDeckFileName(path.basename(args[0]))) throw new Error('source-argument-invalid');
    return preflightSource(readSource(args[0]));
  } catch (error) {
    const code =
      error instanceof Error && /^(?:source-|slidegen-file-too-large$)/.test(error.message)
        ? error.message
        : 'source-unreadable';
    return {
      schemaVersion: 1,
      status: 'source-invalid',
      diagnostics: [{ code }],
      artifactCreated: false,
      visualReview: 'not-performed',
    };
  }
}

const result = run();
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = 'ok' in result ? (result.ok ? 0 : 1) : result.status === 'source-valid' ? 0 : 1;
