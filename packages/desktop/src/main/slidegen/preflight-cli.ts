import path from 'node:path';
import { isDeckFileName } from './deck-file.js';
import { preflightSource } from './preflight.js';
import { readSlideSourceFile } from './source-file.js';

function run() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') {
    const result = preflightSource('```slidegen\n// title: self-test\n<Slide><Text>Ready</Text></Slide>\n```');
    return { command: 'slidegen-source-preflight', schemaVersion: 1, ok: result.status === 'source-valid' };
  }
  try {
    if (args.length !== 1 || !isDeckFileName(path.basename(args[0]))) throw new Error('source-argument-invalid');
    return preflightSource(readSlideSourceFile(process.cwd(), args[0]));
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
