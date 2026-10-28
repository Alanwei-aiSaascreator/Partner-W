import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SRC_DIR = resolve(__dirname, '../src');
const VITE_CONFIG = resolve(__dirname, '../electron.vite.config.ts');
const MAIN_ENTRY = resolve(SRC_DIR, 'main/index.ts');

describe('preload sandbox compatibility', () => {
  const viteConfig = readFileSync(VITE_CONFIG, 'utf-8');
  const mainSource = readFileSync(MAIN_ENTRY, 'utf-8');

  it('electron-vite preload output is configured as CJS', () => {
    expect(viteConfig).toMatch(/format:\s*['"]cjs['"]/);
  });

  it('main process references a .cjs preload file', () => {
    expect(mainSource).toMatch(/preload.*\.cjs/);
  });

  it('BrowserWindow has sandbox enabled', () => {
    expect(mainSource).toMatch(/sandbox:\s*true/);
  });
});
