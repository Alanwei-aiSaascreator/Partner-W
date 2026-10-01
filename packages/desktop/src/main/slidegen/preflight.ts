import { createHash } from 'node:crypto';
import { messagePageBudgetFailure } from '@clawwork/shared';
import { extractSlidegenBlocks } from './blocks.js';
import { DECK_FILE_MAX_BYTES } from './deck-file.js';
import { SlideDslError } from './dsl.js';
import { evaluateSlide } from './evaluate.js';

interface PreflightDiagnostic {
  code: string;
  diagnostic?: { code: string; offset?: number; detail: string };
  max?: number;
  got?: number;
}

export function preflightSource(source: string) {
  const bytes = Buffer.byteLength(source, 'utf8');
  const diagnostics: PreflightDiagnostic[] = [];
  const decks: Array<{ title: string; pages: number }> = [];
  const sourceSha256 = createHash('sha256').update(source, 'utf8').digest('hex');
  if (bytes > DECK_FILE_MAX_BYTES) {
    diagnostics.push({ code: 'slidegen-file-too-large', max: DECK_FILE_MAX_BYTES, got: bytes });
  } else {
    const extracted = extractSlidegenBlocks(source);
    diagnostics.push(...extracted.failures.map(({ failure }) => failure));
    if (!extracted.decks.length && !diagnostics.length) diagnostics.push({ code: 'slidegen-file-no-fence' });
    for (const deck of extracted.decks) {
      try {
        const pages = evaluateSlide(deck.source);
        decks.push({ title: deck.title.slice(0, 200), pages: pages.length });
        const budget = messagePageBudgetFailure(decks.map((entry) => entry.pages));
        if (budget) {
          diagnostics.push(budget);
          break;
        }
      } catch (error) {
        diagnostics.push({
          code: error instanceof SlideDslError ? error.code : 'source-check-failed',
          ...(error instanceof SlideDslError
            ? { diagnostic: { code: error.code, offset: error.offset, detail: error.message } }
            : {}),
        });
      }
    }
  }
  return {
    schemaVersion: 1,
    status: diagnostics.length ? 'source-invalid' : 'source-valid',
    sourceSha256,
    bytes,
    checks: ['syntax', 'evaluation', 'page-budget'],
    decks,
    diagnostics: diagnostics.slice(0, 32).map((entry) => ({
      ...entry,
      ...(entry.diagnostic
        ? { diagnostic: { ...entry.diagnostic, detail: entry.diagnostic.detail.slice(0, 500) } }
        : {}),
    })),
    diagnosticsTruncated: diagnostics.length > 32,
    artifactCreated: false,
    visualReview: 'not-performed',
  };
}
