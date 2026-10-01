import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { buildSlidegenPreflight } from './scripts/build-slidegen-preflight.mjs';

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve('src/main/entry.ts') } } },
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
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          'quick-launch': resolve('src/renderer/quick-launch.html'),
        },
      },
    },
  },
});
