import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(TEST_DIR, '../src/renderer/i18n/locales');

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(collectStrings);
}

describe('Chinese team creation copy', () => {
  for (const locale of ['zh', 'zh-TW']) {
    it(`${locale} keeps user-facing team creation labels in Chinese`, () => {
      const content = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${locale}.json`), 'utf8')) as {
        teams?: unknown;
      };

      const englishLabels = collectStrings(content.teams).filter((text) => /\b(?:Agent|Agents|Skills)\b/u.test(text));

      expect(englishLabels).toEqual([]);
    });
  }
});
