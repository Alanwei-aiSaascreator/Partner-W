import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

/**
 * 阶段 1 的**真实验收**配置 —— 与 `vitest.config.ts` 分开是刻意的：
 *
 * 这组测试会**真的**解压 128MB 归档、真的 spawn 网关进程、真的占端口，
 * 跑一次几分钟。放进默认 `pnpm test` 会让日常提交变得无法忍受。
 *
 *   npx vitest run --config vitest.e2e.config.ts
 *
 * ⚠️ 全部用**隔离 userData**（`CLAWWORK_USER_DATA_DIR` 或直接传目录），
 * **绝不**碰真实 `%APPDATA%` / `openclaw-state` / `.state-*`（junction 事故）。
 */
export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    environment: 'node',
    // 首次部署要解压 35k 个文件 + 拷 100MB 的 node，网关冷启动还要几十秒
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // 真起进程、真占端口 —— 绝不能并发
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@clawwork/shared': resolve(__dirname, '../shared/src'),
    },
  },
});
