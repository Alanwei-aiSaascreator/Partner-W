import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { buildSlidegenPreflight } from './scripts/build-slidegen-preflight.mjs';
import { PROD_CSP, rendererDevCsp } from './scripts/lib/renderer-csp.mjs';

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve('src/main/entry.ts') }, output: { chunkFileNames: '[name]-[hash].js' } },
    },
    plugins: [
      { name: 'slidegen-source-preflight', buildStart: () => buildSlidegenPreflight().then(() => undefined) },
      externalizeDepsPlugin({ exclude: ['@clawwork/shared', '@clawwork/core'] }),
    ],
    define: {
      __MOFANG_UPDATE_PUBLIC_KEY_B64__: JSON.stringify(process.env.MOFANG_UPDATE_PUBLIC_KEY_B64 ?? ''),
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@clawwork/shared', '@clawwork/core'] })],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer'),
      },
    },
    css: {
      transformer: 'lightningcss',
    },
    plugins: [
      react(),
      tailwindcss(),
      // ⭐ BUG-056②（S 包 patch，I 接线）：按实际面列白的 CSP 以 <meta> 注入应用自己的两份
      //    文档（index + quick-launch）；dev 只多 dev 源与 HMR 的 ws；隐藏窗口不走这里。
      {
        name: 'rongying-renderer-csp',
        transformIndexHtml(html: string, ctx: { server?: { resolvedUrls?: { local?: string[] } | null } | null }) {
          const devOrigin = ctx?.server?.resolvedUrls?.local?.[0] ?? null;
          const policy = devOrigin ? rendererDevCsp(devOrigin) : PROD_CSP;
          return {
            html,
            tags: [
              {
                tag: 'meta',
                attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
                injectTo: 'head-prepend',
              },
            ],
          };
        },
      },
    ],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          'quick-launch': resolve('src/renderer/quick-launch.html'),
          // 修复模式（FEAT-03）独立单页：`--repair` 只加载它，不挂主界面那条链。
          repair: resolve('src/renderer/repair.html'),
        },
      },
    },
  },
});
