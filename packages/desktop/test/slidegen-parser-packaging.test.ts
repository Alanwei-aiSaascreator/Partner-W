import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

const desktop = new URL('../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, desktop), 'utf8');

it('ships the pure JS parser as a direct production dependency with its runtime entry', () => {
  const manifest = JSON.parse(read('package.json'));
  expect(manifest.dependencies.acorn).toBe('8.16.0');
  const requireDesktop = createRequire(new URL('package.json', desktop));
  const acorn = requireDesktop('acorn') as { parse: (source: string, options: { ecmaVersion: number }) => unknown };
  expect(acorn.parse('const C = {};', { ecmaVersion: 2022 })).toMatchObject({ type: 'Program' });
  const builder = read('electron-builder.yml');
  expect(builder).toContain("'node_modules/**/*'");
  expect(builder).not.toMatch(/!.*(?:acorn|node_modules\/\*\*)/);
});

it('keeps acorn external to avoid the electron-vite 3 import-scanner shim corrupting parser strings', () => {
  const config = read('electron.vite.config.ts');
  const exclusions = [...config.matchAll(/externalizeDepsPlugin\(\{\s*exclude:\s*\[([^\]]*)\]/g)];
  expect(exclusions.length).toBeGreaterThan(0);
  for (const exclusion of exclusions) expect(exclusion[1]).not.toMatch(/['"]acorn['"]/);
});
