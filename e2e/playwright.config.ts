import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [['html', { open: 'never', outputFolder: '../playwright-report' }]],
  projects: [
    {
      name: 'smoke',
      testMatch: 'smoke/**/*.spec.ts',
    },
    {
      name: 'gateway',
      testMatch: 'gateway/**/*.spec.ts',
    },
    {
      name: 'pwa',
      testMatch: 'pwa/**/*.spec.ts',
    },
    {
      name: 'artifact-loop',
      testMatch: 'local-file-artifact-loop.spec.ts',
    },
    {
      // 打包态验收：真 exe + 真部署 + 真 spawn，单条用例要几分钟。
      // 跑之前先 `pnpm --filter @clawwork/desktop build && npx electron-builder --win --dir`。
      name: 'packaged',
      testMatch: 'packaged/**/*.spec.ts',
      timeout: 20 * 60_000,
    },
  ],
});
