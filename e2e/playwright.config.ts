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
      // ⚠️ 这条配方现在**要求先设好一把更新公钥**：打包路径被构建门禁挡着
      //    （`scripts/require-update-public-key.cjs`，空公钥的包不许打出来）。
      //    一次性钥匙即可，例如：
      //    `export MOFANG_UPDATE_PUBLIC_KEY_B64=$(node -e "console.log(require('node:crypto').generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).toString('base64'))")`
      name: 'packaged',
      testMatch: 'packaged/**/*.spec.ts',
      timeout: 20 * 60_000,
    },
  ],
});
