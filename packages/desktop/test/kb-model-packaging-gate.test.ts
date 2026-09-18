import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KB_MODEL_DIR_NAME } from '../src/main/kb/embedding/locate.js';
import { KB_EMBEDDING_MODEL_ID } from '../src/main/kb/embedding/engine.js';

/**
 * T6b 随包嵌入模型的**打包门禁**。
 *
 * ## 为什么这类"静默失效"必须靠测试钉
 *
 * 模型没打进包、或打进的位置跟代码去找的位置对不上，**表现是没有表现**：
 * 应用照常启动，只是资料库退化成纯关键词检索（`loadEmbeddingEngine` 返回 null 是设计好的
 * 降级路径）。没有报错、没有崩溃、界面上也看不出少了什么 —— 这种问题只会变成
 * 用户的一句"搜东西好像不太准"，永远查不到打包配置上。
 *
 * ⇒ 三件事必须在**提交**时就红：
 *   ① 配置里的 `to:` 与代码常量漂移
 *   ② 模型文件不齐（尤其那 90MB 的 onnx 权重）
 *   ③ 平台裁剪把**当前平台**要用的二进制也裁掉了
 *
 * ⚠️ 与 `runtime-packaging-gate.test.ts` 同款教训：断言前**先剥注释** ——
 *    把某行注释掉时 `toContain` 照样绿，那是本仓库踩过的"假绿"形状。
 */

const requireCjs = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

interface PackagingGate {
  checkBundledRuntime: (config: unknown, projectDir: string, exists?: (p: string) => boolean) => string | null;
  KB_MODEL_TO: string;
  KB_MODEL_ID: string;
  KB_MODEL_REQUIRED: string[];
}

const gate = requireCjs('../scripts/require-bundled-runtime.cjs') as PackagingGate;

const raw = fs.readFileSync(path.join(REPO_ROOT, 'packages/desktop/electron-builder.yml'), 'utf-8');
/** 见文件头：注释掉的行不算配置。 */
const yml = raw
  .split(/\r?\n/)
  .map((line) => (line.trimStart().startsWith('#') ? '' : line.replace(/\s#.*$/, '')))
  .join('\n');

const PROJECT_DIR = path.join(REPO_ROOT, 'packages', 'desktop');
const entries = [...yml.matchAll(/-\s*from:\s*(\S+)\s*\n\s*to:\s*(\S+)/g)].map((m) => ({ from: m[1], to: m[2] }));

describe('随包嵌入模型：配置与代码必须对得上', () => {
  it('⭐ 真配置里有 `from: ../../runtime-out/kb-model` → `to: kb-model`', () => {
    expect(entries).toContainEqual({ from: '../../runtime-out/kb-model', to: 'kb-model' });
  });

  it('⭐ 基准是 projectDir ⇒ 解出来正好是仓库根的 runtime-out/kb-model（抓取脚本的落点）', () => {
    const from = entries.find((e) => e.to === KB_MODEL_DIR_NAME)?.from ?? '';
    expect(path.resolve(PROJECT_DIR, from)).toBe(path.join(REPO_ROOT, 'runtime-out', KB_MODEL_DIR_NAME));
  });

  it('⭐ 三方同一个名字：yml 的 `to` == locate.ts 的常量 == 钩子里的常量', () => {
    // 任何一处改了名字，另外两处不会跟着变 —— 这就是"装出来找不到模型"的成因。
    expect(KB_MODEL_DIR_NAME).toBe('kb-model');
    expect(gate.KB_MODEL_TO).toBe(KB_MODEL_DIR_NAME);
    expect(entries.some((e) => e.to === KB_MODEL_DIR_NAME)).toBe(true);
  });

  it('⭐ 模型 id 也必须对齐：钩子必查的路径 == engine.ts 里的 KB_EMBEDDING_MODEL_ID', () => {
    // 模型 id 是**子目录名**（`<resources>/kb-model/<id>/…`）。这层漏掉过一次：
    // 钩子第一版把必查路径写成 `kb-model/config.json`，结果被自己挡在构建里。
    // 挡得对 —— 不挡的话装出来的包里引擎找不到模型，静默退化成纯关键词检索。
    expect(gate.KB_MODEL_ID).toBe(KB_EMBEDDING_MODEL_ID);
    for (const file of gate.KB_MODEL_REQUIRED) {
      expect(file.startsWith(`${KB_EMBEDDING_MODEL_ID}/`), `${file} 少了模型 id 那层目录`).toBe(true);
    }
  });

  it('⭐ 模型**不能**塞进 runtime 那条映射里（运行时首次启动会把它整个拷进 userData）', () => {
    // `runtime-out` → `<resources>/runtime` 是**整目录**映射；模型在里面就会被当作
    // 运行时内容一起拷走，白占 90MB。必须靠 filter 排除、并单独映射。
    const runtimeBlock = yml.slice(yml.indexOf('to: runtime'), yml.indexOf('to: kb-model'));
    expect(runtimeBlock).toContain('filter:');
    expect(runtimeBlock).toContain('!kb-model/**');
  });

  it('⭐ 原生二进制必须解包（asar 里的 .node/.dll 加载不了；漏了表现为"索引永远建不出来"）', () => {
    expect(yml).toMatch(/asarUnpack:[\s\S]*onnxruntime-node/);
  });
});

describe('平台裁剪：只留当前平台要用的 onnxruntime 二进制', () => {
  /** 取某个平台段落的文本（到下一个顶级键为止）。 */
  function platformBlock(name: string): string {
    const start = yml.indexOf(`\n${name}:`);
    expect(start, `配置里必须有 ${name}: 段`).toBeGreaterThan(-1);
    const rest = yml.slice(start + 1);
    const nextTop = rest.slice(1).search(/\n[a-z]+:/);
    return nextTop === -1 ? rest : rest.slice(0, nextTop + 1);
  }

  it('⭐ Windows（x64）排掉 darwin/linux 和 win32/arm64 —— 那是 225MB 死重', () => {
    const win = platformBlock('win');
    expect(win).toContain('!**/onnxruntime-node/bin/napi-v6/darwin/**');
    expect(win).toContain('!**/onnxruntime-node/bin/napi-v6/linux/**');
    expect(win).toContain('!**/onnxruntime-node/bin/napi-v6/win32/arm64/**');
    // 当前平台那份**必须留下**（裁错了就是本文件头注释里那个"静默失效"）
    expect(win).not.toContain('!**/onnxruntime-node/bin/napi-v6/win32/x64/**');
  });

  it('⭐ mac 保留 darwin（两个架构都要）、排掉 linux 与 win32', () => {
    const mac = platformBlock('mac');
    expect(mac).toContain('!**/onnxruntime-node/bin/napi-v6/linux/**');
    expect(mac).toContain('!**/onnxruntime-node/bin/napi-v6/win32/**');
    expect(mac).not.toContain('!**/onnxruntime-node/bin/napi-v6/darwin/**');
  });

  it('⭐ linux 保留 linux、排掉 darwin 与 win32', () => {
    const linux = platformBlock('linux');
    expect(linux).toContain('!**/onnxruntime-node/bin/napi-v6/darwin/**');
    expect(linux).toContain('!**/onnxruntime-node/bin/napi-v6/win32/**');
    expect(linux).not.toContain('!**/onnxruntime-node/bin/napi-v6/linux/**');
  });

  it('每个平台段都重复写了基础三条（平台 files 是"覆盖"还是"叠加"没有明确文档，两种语义下都要拿到完整集合）', () => {
    for (const name of ['win', 'mac', 'linux']) {
      const block = platformBlock(name);
      expect(block, `${name} 缺 out/**/*`).toContain("'out/**/*'");
      expect(block, `${name} 缺 node_modules/**/*`).toContain("'node_modules/**/*'");
      expect(block, `${name} 缺 package.json`).toContain("'package.json'");
    }
  });
});

describe('门禁钩子：模型不齐必须让构建失败', () => {
  const modelConfig = {
    extraResources: [
      { from: 'build/icon.png', to: 'icon.png' },
      { from: '../../runtime-out', to: 'runtime' },
      { from: '../../runtime-out/kb-model', to: 'kb-model' },
    ],
  };
  const MODEL_ABS = path.resolve(PROJECT_DIR, '../../runtime-out/kb-model');
  const RUNTIME_ABS = path.resolve(PROJECT_DIR, '../../runtime-out');

  const withModel = (files: string[]): ((p: string) => boolean) => {
    const set = new Set<string>([
      path.resolve(PROJECT_DIR, 'build/icon.png'),
      RUNTIME_ABS,
      path.join(RUNTIME_ABS, 'openclaw-runtime-manifest.json'),
      MODEL_ABS,
      ...files.map((f) => path.join(MODEL_ABS, f)),
    ]);
    return (p) => set.has(p);
  };

  it('模型齐 ⇒ 通过', () => {
    expect(gate.checkBundledRuntime(modelConfig, PROJECT_DIR, withModel(gate.KB_MODEL_REQUIRED))).toBeNull();
  });

  it('⭐ 目录在但**缺 onnx 权重** ⇒ 失败，且报错说清楚后果是"静默退化"', () => {
    // ⚠️ 用 endsWith 而不是相等：必查路径带模型 id 前缀（`<id>/onnx/model.onnx`）。
    //    写成相等时这个 filter 一个都滤不掉 ⇒ "缺文件"这条路径根本没被测到（夹具假绿）。
    const missing = gate.KB_MODEL_REQUIRED.filter((f) => !f.endsWith('onnx/model.onnx'));
    expect(missing).toHaveLength(gate.KB_MODEL_REQUIRED.length - 1);
    const message = gate.checkBundledRuntime(modelConfig, PROJECT_DIR, withModel(missing));

    expect(message).not.toBeNull();
    expect(message).toContain('onnx/model.onnx');
    expect(message).toContain('静默退化');
    // 报错里要有**绝对路径**，否则从构建日志里看不出是哪个目录不齐
    expect(message).toContain(MODEL_ABS);
  });

  it('整个 kb-model 目录都不在 ⇒ 失败（走的是原有的"缺源"那条）', () => {
    const exists = (p: string): boolean =>
      p !== MODEL_ABS &&
      (p === RUNTIME_ABS || p === path.join(RUNTIME_ABS, 'openclaw-runtime-manifest.json') || p.endsWith('icon.png'));
    const message = gate.checkBundledRuntime(modelConfig, PROJECT_DIR, exists);

    expect(message).not.toBeNull();
    expect(message).toContain('kb-model');
  });
});
