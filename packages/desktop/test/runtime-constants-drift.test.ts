import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLAWROUTER_ENTRY, DEPLOYMENT_STAMP_FILE } from '../src/main/runtime/deploy.js';
import { RUNTIME_MANIFEST_FILE } from '../src/main/runtime/locate.js';
import { DEPLOYMENT_SCHEMA_VERSION } from '../src/main/runtime/manifest.js';

/**
 * 防漂移：客户端里的常量与构建脚本里的那份**必须逐字一致**。
 *
 * 为什么只能这么测：`scripts/` 不在 tsconfig 的 `include` 里（main 进程**不能**
 * import 构建脚本 —— 那会把打包器拖进应用代码），所以两边的"同一份契约"没有
 * 任何编译期检查。而它一旦漂移，症状是**静默不计费**：
 * `clawrouter` 是 relay 计量的唯一入口，入口路径对不上就查不出缺了它。
 *
 * ⚠️ 这里是**读文本**而不是 import —— 就是为了不把那层依赖引进来。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

function readRepoFile(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

/** 从源码文本里抠出一个字符串常量的字面量值。 */
function exportedStringLiteral(source: string, name: string): string | null {
  const m = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*'([^']*)'`).exec(source);
  return m ? m[1] : null;
}

describe('与构建脚本的常量一致性', () => {
  it('⭐ CLAWROUTER_ENTRY 与 scripts/pack-runtime.mjs 逐字一致', () => {
    const source = readRepoFile('scripts/pack-runtime.mjs');
    const fromScript = exportedStringLiteral(source, 'CLAWROUTER_ENTRY');

    expect(fromScript, 'pack-runtime.mjs 里找不到 CLAWROUTER_ENTRY（是不是改名了？）').not.toBeNull();
    expect(CLAWROUTER_ENTRY).toBe(fromScript);
  });

  it('值本身是预期的那个（防止两边一起被改错）', () => {
    expect(CLAWROUTER_ENTRY).toBe('node_modules/openclaw/dist/extensions/clawrouter/index.js');
  });

  it('⭐ 认盘的 marker 文件名与 pack-runtime.mjs 写出的文件名一致', () => {
    const source = readRepoFile('scripts/pack-runtime.mjs');
    // 打包器把这个名字写进它产出的清单文件名；装载器靠它认盘
    expect(source).toContain(RUNTIME_MANIFEST_FILE);
    expect(RUNTIME_MANIFEST_FILE).toBe('openclaw-runtime-manifest.json');
  });
});

describe('部署布局契约', () => {
  it('stamp 文件名是隐藏文件（用户不该在资源管理器里误删它）', () => {
    expect(DEPLOYMENT_STAMP_FILE.startsWith('.')).toBe(true);
  });

  it('⭐ schema 版本变了必须**手动**加一 —— 它进 deployment key，改了旧目录不会被误复用', () => {
    // 这条不是形式主义：改了 `deployed/<key>/` 的结构却忘了 +1，
    // 旧缓存会被当成"当前版本"复用，跑起来的布局和新代码对不上。
    expect(DEPLOYMENT_SCHEMA_VERSION).toBe(1);
  });
});
