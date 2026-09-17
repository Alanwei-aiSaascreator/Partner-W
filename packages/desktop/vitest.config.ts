import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    // jsdom 在这个版本组合下不提供 localStorage，见 test/setup.ts 的说明
    setupFiles: ['./test/setup.ts'],
    // A cold full-suite run on Windows can spend more than Vitest's default
    // compiling Electron IPC modules and starting the isolated file-service
    // probes. Those probes have their own 30s process timeout, so keep Vitest's
    // outer timeout slightly higher and surface the real probe failure instead
    // of aborting a healthy child process under parallel load.
    testTimeout: 35_000,
    // Several integration tests launch Electron-as-Node probes synchronously.
    // Unbounded worker fan-out on Windows can starve a worker long enough for
    // Vitest's RPC heartbeat to fail even after every assertion has passed.
    maxWorkers: 4,
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
