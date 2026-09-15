import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    // A cold full-suite run on Windows can spend more than Vitest's 5s
    // default compiling Electron IPC modules. A timed-out dynamic import keeps
    // running and can then leak mock calls into the next test, hiding the real
    // cause behind misleading call-count failures.
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@clawwork/shared': resolve(__dirname, '../shared/src'),
    },
  },
});
