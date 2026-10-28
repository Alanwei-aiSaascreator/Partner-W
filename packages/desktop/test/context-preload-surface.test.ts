import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('context preload surface', () => {
  it('does not expose renderer-chosen absolute path context APIs', () => {
    const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8');
    const declarations = readFileSync(new URL('../src/preload/clawwork.d.ts', import.meta.url), 'utf8');
    const unsafeNames = [
      'selectContextFolder',
      'listContextFiles',
      'readContextFile',
      'watchContextFolder',
      'unwatchContextFolder',
    ];

    for (const name of unsafeNames) {
      expect(preload).not.toContain(`${name}:`);
      expect(declarations).not.toContain(`${name}:`);
    }
  });
});
