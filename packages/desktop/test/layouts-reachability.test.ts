import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * **每一个 layout 都必须被产品代码 import**（2026-09-25）。
 *
 * ## 为什么要有这条
 *
 * 2026-09-25 实测：`layouts/StartupReadiness`（整屏门禁）自 `5e103c2e`
 * （"prepare ai inside workspace" 那次重构）起**没有任何产品代码 import 它**，
 * 但组件与它的测试都留着 ⇒
 *
 * - 它承载的四条文案（**「这不是安装」** 等，其中那条是同事真反馈加上的）**一个字都不显示**；
 * - 而它的测试**一直全绿** —— 断言的是一个用户看不到的界面。
 *
 * `knip`（`pnpm check:dead-code`）**抓不到这一类**：它把测试文件的 import 算作"被使用"
 * （本仓早就记过这条：`check:dead-code` 抓不到"被测试养着的死代码"）。
 * 所以这里自己看一眼：**布局目录**（用户可见的顶层界面）有没有人渲染。
 *
 * ## ⚠️ 这条守卫自己踩过的坑（别重犯）
 *
 * 第一版量法是"在 src 里搜 `layouts/<名字>` 这个串"，于是
 * `import FileBrowser from '../FileBrowser'`（**相对路径**）被误判成"没人用"——
 * **假阳性**，脚本的错与真结果长得一模一样。所以这里**真的解析模块说明符**
 * （`@/` → `src/renderer`，`.` → 相对当前文件），并配一条"至少认得出 17 个"的对照，
 * 免得扫描器坏掉时整段空转通过。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');
const RENDERER = path.join(SRC, 'renderer');
const LAYOUTS = path.join(RENDERER, 'layouts');

/**
 * 已知的"没人渲染"的 layout，**每一条都必须挂着待办/决定**。
 *
 * ⚠️ 往这里加东西不是"让测试变绿"的手段：它是**记账**。
 *    新加一条 = 承认界面上多了一块用户看不到的东西。
 */
const KNOWN_UNRENDERED: Record<string, string> = {
  StartupReadiness:
    '自 5e103c2e 起没人渲染（面板 + 欢迎屏接管了它）。文案去向（搬走还是接回去）待用户拍，见 docs/superpowers/plans/2026-09-25-workspace-filesystem-preflight.md 的「执行期发现」第 1 条',
};

function sourceFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
    }
  })(SRC);
  return out;
}

/** `@/x` ⇒ `<renderer>/x`；`./x` / `../x` ⇒ 相对当前文件；包名 ⇒ null。 */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith('@/')) return path.join(RENDERER, specifier.slice(2));
  if (specifier.startsWith('.')) return path.resolve(path.dirname(fromFile), specifier);
  return null;
}

const IMPORT_RE = /(?:import[^'"]*from\s*|import\(\s*)['"]([^'"]+)['"]/g;

function layoutNames(): string[] {
  return fs
    .readdirSync(LAYOUTS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** 名字 ⇒ 产品代码里 import 了它的文件（**不含它自己目录内部的相互引用**）。 */
function importersByLayout(): Map<string, string[]> {
  const names = layoutNames();
  const result = new Map(names.map((name) => [name, [] as string[]]));
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT_RE)) {
      const resolved = resolveSpecifier(match[1] ?? '', file);
      if (!resolved) continue;
      for (const name of names) {
        const dir = path.join(LAYOUTS, name);
        if (resolved !== dir && !resolved.startsWith(dir + path.sep)) continue;
        if (file.startsWith(dir + path.sep)) continue;
        result.get(name)?.push(path.relative(SRC, file));
      }
    }
  }
  return result;
}

describe('layouts 可达性：每个界面都得有人渲染', () => {
  it('⭐ 没有"没人 import"的 layout（除已知的记账项）', () => {
    const unrendered = [...importersByLayout().entries()]
      .filter(([, importers]) => importers.length === 0)
      .map(([name]) => name);

    const unexpected = unrendered.filter((name) => !(name in KNOWN_UNRENDERED));
    expect(
      unexpected,
      '这些 layout 没有任何产品代码 import —— 用户根本看不到它们（要么接上去，要么删掉；' +
        '确认是"故意留着"就往 KNOWN_UNRENDERED 里记账并写明原因）',
    ).toEqual([]);
  });

  it('对照：已知记账项之外的 17 个都认得出引用方（扫描器坏掉时这里先红）', () => {
    const importers = importersByLayout();
    const referenced = [...importers.entries()].filter(([, list]) => list.length > 0);
    expect(referenced.length, '扫描器认出的"被引用 layout"数量').toBeGreaterThanOrEqual(17);
  });

  it('⭐ 对照：相对路径的 import 也算数（`../FileBrowser` 那种 —— 第一版量法就栽在这里）', () => {
    const importers = importersByLayout();
    expect(importers.get('FileBrowser'), 'FileBrowser 是相对路径被引用的').not.toHaveLength(0);
  });

  it('记账项必须写明原因（不许只写个名字）', () => {
    for (const [name, reason] of Object.entries(KNOWN_UNRENDERED)) {
      expect(reason.length, `${name} 的记账理由太短，等于没写`).toBeGreaterThan(30);
    }
  });
});
