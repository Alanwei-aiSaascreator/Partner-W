import { mkdtempSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getArtifactAvailability } from '../src/main/artifact/reconcile.js';

/**
 * 展示层可用性判定（"文件已被拦截"的真源）。
 *
 * ## ⚠️ 2026-10-06 真机案例（这就是本文件存在的理由）
 *
 * 工作区经 subst 挂载（U 盘受控测试的标准形态）时，**字面路径**（`S:\Partner-W工作区\…`）
 * 与 **canonical 路径**（`realpath` 解析后的 `D:\…`）必然不同 —— 旧实现里的
 * `samePath(realFile, absolutePath)` 会把**全部**产物误判为 `unsafe`，
 * 界面表现是整版「文件已被拦截」（图16 的三条 PPT 全中）。
 *
 * 这里用 **junction** 钉同构场景（目录链接 = subst 的函数等价物，且不需要管理员权限）。
 * 防护语义必须保持：**文件本体**是符号链接仍拒（下面的用例钉住），
 * **越界**（realpath 逃出工作区）也仍拒（`artifact-reconcile.test.ts` 的 outside-junction 用例钉住）。
 */
describe('getArtifactAvailability（展示层可用性）', () => {
  const cleanups: Array<() => void> = [];
  const mk = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  // LIFO 执行：先摘 junction（rmdir 只删链接本体），再删父目录 —— 防递归穿透链接指向的真目录
  afterEach(() => {
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        fn();
      } catch {}
    }
  });

  it('普通目录里的文件 → available', () => {
    const ws = mk('avail-');
    writeFileSync(join(ws, 'a.pptx'), 'x');
    expect(getArtifactAvailability('a.pptx', ws)).toBe('available');
  });

  it('文件不存在 → missing', () => {
    const ws = mk('avail-');
    expect(getArtifactAvailability('nope.pptx', ws)).toBe('missing');
  });

  it('⭐ 工作区是目录链接（subst/junction 同构）→ 文件仍 available（真机「S: 盘全被拦截」回归）', () => {
    const real = mk('avail-real-');
    writeFileSync(join(real, 'a.pptx'), 'x');
    const parent = mk('avail-link-');
    const link = join(parent, 'ws');
    symlinkSync(real, link, 'junction');
    cleanups.push(() => {
      try {
        rmdirSync(link);
      } catch {}
    });

    expect(getArtifactAvailability('a.pptx', link)).toBe('available');
  });

  it('文件本体是符号链接 → unsafe（既有防护语义保留）', () => {
    const ws = mk('avail-');
    const target = mk('avail-target-');
    writeFileSync(join(target, 'real.pptx'), 'x');
    try {
      symlinkSync(join(target, 'real.pptx'), join(ws, 'a.pptx'), 'file');
    } catch {
      return; // 无文件符号链接权限的环境（未开开发者模式）：跳过，不假绿也不假红
    }
    expect(getArtifactAvailability('a.pptx', ws)).toBe('unsafe');
  });
});
