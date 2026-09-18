import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_RUNTIME_DIR_NAME,
  RUNTIME_MANIFEST_FILE,
  RUNTIME_ORIGIN_LABELS,
  buildDriveCandidates,
  candidateRuntimeRoots,
  describeRuntimeSearch,
  findDevRuntimeRoots,
  findRuntimeRoot,
  planRuntimeSearch,
  resolveBundledRuntimeRoot,
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
  it('⭐ 顺序固定：env → config → dev 向上找 → 可移动盘 → 随包自带 → 本机缓存', () => {
    const roots = candidateRuntimeRoots({
      envDir: 'E:\\env-runtime',
      configDir: 'C:\\cfg-runtime',
      devRoots: ['D:\\repo\\runtime-out'],
      drives: ['Z:\\'],
      bundledRoot: 'C:\\Program Files\\荣盈魔方\\resources\\runtime',
      cacheRoot: 'C:\\cache\\deployed\\k1',
    });

    expect(roots.map((r) => r.origin)).toEqual(['env', 'config', 'dev', 'drive', 'bundled', 'cache']);
    expect(roots.map((r) => r.root)).toEqual([
      'E:\\env-runtime',
      'C:\\cfg-runtime',
      'D:\\repo\\runtime-out',
      'Z:\\',
      'C:\\Program Files\\荣盈魔方\\resources\\runtime',
      'C:\\cache\\deployed\\k1',
    ]);
  });

  it('⭐ 插着盘时**盘上那份优先**于随包自带的那份（盘上通常更新）', () => {
    const roots = candidateRuntimeRoots({
      drives: ['Z:\\'],
      bundledRoot: 'C:\\app\\resources\\runtime',
      cacheRoot: 'C:\\cache\\k1',
    });

    const hit = findRuntimeRoot(
      roots,
      paths('Z:\\' + RUNTIME_MANIFEST_FILE, 'C:\\app\\resources\\runtime\\' + RUNTIME_MANIFEST_FILE),
    );
    expect(hit?.origin).toBe('drive');
    expect(hit?.root).toBe('Z:\\');
  });

  it('盘拔了 ⇒ 回落到随包自带的那份（bundled 仍在 cache 之前）', () => {
    const roots = candidateRuntimeRoots({
      drives: ['Z:\\'],
      bundledRoot: 'C:\\app\\resources\\runtime',
      cacheRoot: 'C:\\cache\\k1',
    });

    const hit = findRuntimeRoot(
      roots,
      paths('C:\\app\\resources\\runtime\\' + RUNTIME_MANIFEST_FILE, 'C:\\cache\\k1\\' + RUNTIME_MANIFEST_FILE),
    );
    expect(hit?.origin).toBe('bundled');
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

describe('resolveBundledRuntimeRoot（随安装包自带的那份）', () => {
  it('⭐ 打包态 ⇒ `<resources>/runtime`', () => {
    expect(
      resolveBundledRuntimeRoot({ isPackaged: true, resourcesPath: 'C:\\Program Files\\荣盈魔方\\resources' }),
    ).toBe('C:\\Program Files\\荣盈魔方\\resources\\runtime');
  });

  it('目录名就是 "<resources>/runtime"（与 extraResources 的 to 同名，改一处就要改两处）', () => {
    expect(BUNDLED_RUNTIME_DIR_NAME).toBe('runtime');
    expect(resolveBundledRuntimeRoot({ isPackaged: true, resourcesPath: 'C:\\app\\resources' })).toBe(
      path.join('C:\\app\\resources', BUNDLED_RUNTIME_DIR_NAME),
    );
  });

  it('⭐ dev（isPackaged=false）⇒ **优雅缺席**：连候选都不产生', () => {
    // dev 下 process.resourcesPath 指的是 node_modules/electron/dist/resources，
    // 那里永远不会有我们这份 —— 塞进候选只会污染"找过哪些地方"那段诊断文本。
    expect(
      resolveBundledRuntimeRoot({
        isPackaged: false,
        resourcesPath: 'D:\\repo\\node_modules\\electron\\dist\\resources',
      }),
    ).toBeUndefined();
  });

  it('打包态但拿不到 resourcesPath ⇒ 也不产生候选（不猜路径）', () => {
    expect(resolveBundledRuntimeRoot({ isPackaged: true, resourcesPath: undefined })).toBeUndefined();
    expect(resolveBundledRuntimeRoot({ isPackaged: true, resourcesPath: '' })).toBeUndefined();
  });
});

describe('planRuntimeSearch（把输入排成候选 + 说清谁没产生候选）', () => {
  const packaged = {
    cwd: 'D:\\repo\\packages\\desktop',
    isPackaged: true,
    resourcesPath: 'C:\\Program Files\\荣盈魔方\\resources',
  } as const;

  it('⭐ 打包态 ⇒ 候选里有 bundled（排在 drive 之后、cache 不参与）', () => {
    const { candidates } = planRuntimeSearch({
      ...packaged,
      devRoots: ['D:\\repo\\runtime-out'], // dev 候选由调用方算好传进来
      driveLetters: ['Z:'],
    });

    expect(candidates.map((c) => c.origin)).toEqual(['dev', 'drive', 'bundled']);
    expect(candidates.map((c) => c.root)).toEqual([
      'D:\\repo\\runtime-out',
      'Z:\\',
      'C:\\Program Files\\荣盈魔方\\resources\\runtime',
    ]);
  });

  it('盘符是 `Z:` 还带不带反斜杠都能用（照 buildDriveCandidates 的规则归一）', () => {
    const { candidates } = planRuntimeSearch({ ...packaged, driveLetters: ['Z:', 'Y:\\'] });
    expect(candidates.filter((c) => c.origin === 'drive').map((c) => c.root)).toEqual(['Z:\\', 'Y:\\']);
  });

  it('⭐ dev ⇒ 没有 bundled 候选，且**说明为什么**（不能只是静默少一条）', () => {
    const { candidates, absent } = planRuntimeSearch({
      cwd: 'D:\\repo\\packages\\desktop',
      isPackaged: false,
      resourcesPath: 'D:\\repo\\node_modules\\electron\\dist\\resources',
    });

    expect(candidates.some((c) => c.origin === 'bundled')).toBe(false);
    const note = absent.find((a) => a.origin === 'bundled');
    expect(note?.why).toContain('app.isPackaged=false');
  });

  it('谁没产生候选都有说明（env / config / dev / drive / bundled）', () => {
    const { candidates, absent } = planRuntimeSearch({ cwd: 'D:\\repo', isPackaged: false });

    expect(candidates).toEqual([]);
    expect(absent.map((a) => a.origin)).toEqual(['env', 'config', 'dev', 'drive', 'bundled']);
    expect(absent.find((a) => a.origin === 'dev')?.why).toContain('D:\\repo');
  });

  it('有值的来源就不该出现在 absent 里', () => {
    const { absent } = planRuntimeSearch({
      cwd: 'D:\\repo',
      isPackaged: true,
      resourcesPath: 'C:\\app\\resources',
      envDir: 'E:\\env',
      devRoots: ['D:\\repo\\runtime-out'],
      driveLetters: ['Z:'],
    });

    expect(absent.map((a) => a.origin)).toEqual(['config']); // 本版没接线到配置，其余都有值
  });
});

describe('describeRuntimeSearch（一个都没命中时的诊断文本）', () => {
  it('⭐ 说清"找过哪些地方"：每个候选带来源与 root，还带没产生候选的来源', () => {
    const text = describeRuntimeSearch({
      candidates: [
        { root: 'E:\\env', origin: 'env', manifestPath: 'E:\\env\\openclaw-runtime-manifest.json' },
        { root: 'C:\\app\\resources\\runtime', origin: 'bundled', manifestPath: 'C:\\app\\resources\\runtime\\x.json' },
      ],
      absent: [{ origin: 'config', why: '没有值（本版客户端还没接线）' }],
      fallbackScanned: true,
    });

    expect(text).toContain(RUNTIME_MANIFEST_FILE);
    expect(text).toContain('[env] E:\\env');
    expect(text).toContain('C:\\app\\resources\\runtime');
    expect(text).toContain('[bundled]');
    expect(text).toContain('没产生候选的来源');
    expect(text).toContain('config：没有值');
    expect(text).toContain('盘符兜底扫描');
    // 事故形状：装好的正式包本该命中 bundled ⇒ 文本要能直接指向"包里没带运行时"
    expect(text).toContain('安装包里没带运行时');
  });

  it('一个候选都没有时，说的是"没得找"而不是"找不到"', () => {
    const text = describeRuntimeSearch({ candidates: [], absent: [{ origin: 'bundled', why: '开发态' }] });
    expect(text).toContain('没得找');
    expect(text).not.toContain('已找过');
    expect(text).not.toContain('盘符兜底扫描');
  });

  it('每个来源都有中文名字（诊断文本不能出现裸 origin）', () => {
    for (const [origin, label] of Object.entries(RUNTIME_ORIGIN_LABELS)) {
      expect(label.length, `${origin} 缺中文名`).toBeGreaterThan(0);
    }
  });
});
