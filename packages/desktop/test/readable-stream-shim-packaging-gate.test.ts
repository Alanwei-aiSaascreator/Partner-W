import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 打包垫片 `readable-stream/passthrough` 的**配置闸**。
 *
 * ## 它为什么存在（2026-09-25 打包实测）
 *
 * `exceljs` → `archiver` → `archiver-utils` → `lazystream` 在**模块顶层**
 * `require('readable-stream/passthrough')`；`lazystream` 要 v2（v2 有这个根级入口），
 * 而 v3 **删掉了它**（上游 tarball 实测）。开发树没事（pnpm 给 lazystream 配了旁边的 v2），
 * 但 **electron-builder 把 pnpm 的树压平**、那份 v2 没了 ⇒ 解析到顶层 v3 ⇒ `MODULE_NOT_FOUND`
 * ⇒ **打包态里 `require('exceljs')` 直接抛错，一个 .xlsx 都产不出来**。
 * 实测形状：解包打包产物、`require` 里面的 exceljs ⇒
 * `Cannot find module 'readable-stream/passthrough'`；补上这一个文件后同一棵树里
 * docx 8,582 B、xlsx 6,434 B 都出得来。
 *
 * ## ⚠️ 这个文件**不是**权威
 *
 * 它只钉"配置有没有把垫片映射进去"（便宜、提交时就能红）。**真正的证明是打完包再解包跑一遍**
 * （命令与读数记在 `docs/superpowers/plans/2026-09-24-docgen-p2-word-excel.md`）。
 * 配置对了而打包仍然丢文件，这里是看不出来的。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, '..');
const YML_PATH = path.join(PROJECT_DIR, 'electron-builder.yml');
const SHIM_PATH = path.join(PROJECT_DIR, 'packaging-shims', 'readable-stream', 'passthrough.js');

/** 注释掉的行不算配置（同 `our-skills-packaging-gate.test.ts` 的教训）。 */
const yml = fs
  .readFileSync(YML_PATH, 'utf-8')
  .split(/\r?\n/)
  .map((line) => (line.trimStart().startsWith('#') ? '' : line.replace(/\s#.*$/, '')))
  .join('\n');

/** yml 里的 `- from: X` / `to: Y` 条目（多行 FileSet 也认）。 */
const fileSets = [...yml.matchAll(/-\s*from:\s*(\S+)\s*\n\s*to:\s*(\S+)/g)].map((m) => ({ from: m[1], to: m[2] }));

describe('readable-stream 垫片：文件本身', () => {
  it('垫片文件在（它就是补回 v2 那个入口的那一行）', () => {
    expect(fs.existsSync(SHIM_PATH), `缺 ${SHIM_PATH}`).toBe(true);
  });

  it('⭐ 内容是 v2 的那句原文 —— 从 v3 自己的 readable.js 上取 PassThrough（实测 v3 仍然导出它）', () => {
    const text = fs.readFileSync(SHIM_PATH, 'utf-8');
    expect(text).toContain(`module.exports = require('./readable').PassThrough`);
  });

  it('文件名必须叫 passthrough.js —— require 子路径找的就是这个名字', () => {
    expect(path.basename(SHIM_PATH)).toBe('passthrough.js');
  });
});

describe('readable-stream 垫片：打包映射', () => {
  it('⭐ 顶层 files 里有 `packaging-shims/readable-stream` → `node_modules/readable-stream`', () => {
    expect(fileSets).toContainEqual({ from: 'packaging-shims/readable-stream', to: 'node_modules/readable-stream' });
  });

  it('⭐ 四个 files 列表（顶层 + mac/win/linux）都要有 —— 平台级会覆盖顶层', () => {
    // 顶层 1 条 + mac/win/linux 各 1 条 = 4 条
    const hits = fileSets.filter((e) => e.to === 'node_modules/readable-stream').length;
    expect(hits, '少写一处，那个平台的包里 exceljs 就加载不了').toBe(4);
  });

  it('落点就是 Node 解析 `readable-stream/passthrough` 时会走到的那个目录', () => {
    const entry = fileSets.find((e) => e.to === 'node_modules/readable-stream');
    expect(entry?.to).toBe('node_modules/readable-stream');
    expect(entry?.to.endsWith('/')).toBe(false);
  });

  it('负对照：不存在的垫片映射不该被认成存在（防止上面的断言恒真）', () => {
    expect(fileSets).not.toContainEqual({ from: 'packaging-shims/nonexistent', to: 'node_modules/nonexistent' });
  });
});
