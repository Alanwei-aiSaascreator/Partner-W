import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { listZipEntries, readZipEntry } from '../src/main/preview/zip-entry';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const probePath = fileURLToPath(new URL('./helpers/pptx-template-esm-probe.ts', import.meta.url));
let scratch: string;

beforeAll(async () => {
  scratch = mkdtempSync(join(packageDir, '.pptx-esm-probe-'));
  await build({
    configFile: false,
    logLevel: 'silent',
    root: packageDir,
    ssr: { external: ['pptx-automizer'] },
    build: {
      emptyOutDir: false,
      minify: false,
      target: 'node20',
      outDir: scratch,
      ssr: probePath,
      rollupOptions: { output: { format: 'es', entryFileNames: 'probe.mjs' } },
    },
  });
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

it('fills real templates in native ESM with external dependencies and no fallback', () => {
  const child = spawnSync(
    process.execPath,
    [join(scratch, 'probe.mjs'), join(packageDir, 'resources/pptx-templates'), scratch],
    { cwd: packageDir, encoding: 'utf8', timeout: 30_000, windowsHide: true },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const buffer = readFileSync(join(scratch, 'native-esm.pptx'));
  const slides = listZipEntries(buffer).filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry));
  expect(slides).toHaveLength(2);
  const cover = readZipEntry(buffer, 'ppt/slides/slide1.xml')!.toString('utf8');
  const closing = readZipEntry(buffer, 'ppt/slides/slide2.xml')!.toString('utf8');
  expect(cover).toContain('Native ESM cover');
  expect(cover).toContain('COVER_TITLE');
  expect(closing).toContain('Native ESM closing');
  expect(cover + closing).not.toMatch(/\{\{[^}]+\}\}/);
});
