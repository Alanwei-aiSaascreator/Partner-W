import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RUNTIME_MANIFEST_FILE,
  buildDriveCandidates,
  candidateRuntimeRoots,
  findDevRuntimeRoots,
  findRuntimeRoot,
} from '../src/main/runtime/locate.js';
import type { RuntimeRootCandidate } from '../src/main/runtime/locate.js';

/**
 * 运行时**部署源**的定位。
 *
 * 全部是纯函数（`exists` 注入）—— 定位逻辑的 bug 表现为"静默用了错的那份运行时"，
 * 那种错误只有把顺序钉死才查得出来。
 */

const paths = (...names: string[]): ((p: string) => boolean) => {
  const set = new Set(names);
  return (p) => set.has(p);
};

describe('candidateRuntimeRoots', () => {
  it('⭐ 顺序固定：env → config → dev 向上找 → 可移动盘 → 本机缓存', () => {
    const roots = candidateRuntimeRoots({
      envDir: 'E:\\env-runtime',
      configDir: 'C:\\cfg-runtime',
      devRoots: ['D:\\repo\\runtime-out'],
      drives: ['Z:\\'],
      cacheRoot: 'C:\\cache\\deployed\\k1',
    });

    expect(roots.map((r) => r.origin)).toEqual(['env', 'config', 'dev', 'drive', 'cache']);
    expect(roots.map((r) => r.root)).toEqual([
      'E:\\env-runtime',
      'C:\\cfg-runtime',
      'D:\\repo\\runtime-out',
      'Z:\\',
      'C:\\cache\\deployed\\k1',
    ]);
  });

  it('每个候选都带 marker 文件的绝对路径（不靠卷标认盘）', () => {
    const roots = candidateRuntimeRoots({ envDir: 'E:\\env-runtime' });
    expect(roots[0].manifestPath).toBe(path.join('E:\\env-runtime', RUNTIME_MANIFEST_FILE));
  });

  it('没配的来源不产生候选（不塞空字符串占位）', () => {
    const roots = candidateRuntimeRoots({ devRoots: [], drives: [] });
    expect(roots).toEqual([]);
  });

  it('dev 可以有多个（向上找出来的一串），保持传入顺序', () => {
    const roots = candidateRuntimeRoots({ devRoots: ['D:\\a\\runtime-out', 'D:\\runtime-out'] });
    expect(roots.map((r) => r.root)).toEqual(['D:\\a\\runtime-out', 'D:\\runtime-out']);
  });
});

describe('buildDriveCandidates', () => {
  it('盘符 → 根路径，顺序保持传入顺序', () => {
    expect(buildDriveCandidates(['Z:', 'Y:', 'X:']).map((c) => c.root)).toEqual(['Z:\\', 'Y:\\', 'X:\\']);
  });

  it('来源标记是 drive（错误措辞要能说清"盘上找不到"）', () => {
    expect(buildDriveCandidates(['Z:'])[0].origin).toBe('drive');
  });

  it('空列表 ⇒ 空数组', () => {
    expect(buildDriveCandidates([])).toEqual([]);
  });
});

describe('findDevRuntimeRoots', () => {
  it('⭐ 从起点向上找 marker，**不硬编码层数**', () => {
    const found = findDevRuntimeRoots(
      'D:\\repo\\packages\\desktop',
      paths('D:\\repo\\runtime-out\\' + RUNTIME_MANIFEST_FILE),
    );
    expect(found).toEqual(['D:\\repo\\runtime-out']);
  });

  it('向上找时优先**最近**的那一层（就近原则）', () => {
    const found = findDevRuntimeRoots(
      'D:\\repo\\a\\b',
      paths('D:\\repo\\a\\b\\runtime-out\\' + RUNTIME_MANIFEST_FILE, 'D:\\repo\\runtime-out\\' + RUNTIME_MANIFEST_FILE),
    );
    expect(found).toEqual(['D:\\repo\\a\\b\\runtime-out', 'D:\\repo\\runtime-out']);
  });

  it('一直找到根都没有 ⇒ 空数组（不是抛错）', () => {
    expect(findDevRuntimeRoots('D:\\repo\\a', paths())).toEqual([]);
  });
});

describe('findRuntimeRoot', () => {
  const candidates: RuntimeRootCandidate[] = [
    { root: 'E:\\env', origin: 'env', manifestPath: 'E:\\env\\openclaw-runtime-manifest.json' },
    { root: 'Z:\\', origin: 'drive', manifestPath: 'Z:\\openclaw-runtime-manifest.json' },
  ];

  it('取第一个 marker 存在的候选', () => {
    expect(findRuntimeRoot(candidates, paths('Z:\\openclaw-runtime-manifest.json'))).toEqual(candidates[1]);
  });

  it('⭐ 前面的候选"目录在但没 marker"⇒ 跳过，不算命中', () => {
    // E:\env 存在但没 marker（比如盘插着、运行时没拷全）—— 必须继续找
    expect(findRuntimeRoot(candidates, paths('E:\\env\\something-else'))).toBeNull();
  });

  it('都不存在 ⇒ null（调用方据此要求插盘）', () => {
    expect(findRuntimeRoot(candidates, paths())).toBeNull();
  });

  it('同时存在时**取先出现的那个**（顺序即优先级）', () => {
    const all = paths('E:\\env\\openclaw-runtime-manifest.json', 'Z:\\openclaw-runtime-manifest.json');
    expect(findRuntimeRoot(candidates, all)).toEqual(candidates[0]);
  });
});
