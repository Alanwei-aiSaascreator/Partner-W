import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_SCHEMA_VERSION,
  computeDeploymentKey,
  parseManifest,
  parseNodeManifest,
  resolveArchivePath,
  resolveNodePath,
  selectNodeVariant,
  selectRuntimeVariant,
} from '../src/main/runtime/manifest.js';

/**
 * 装载器读的那份 manifest 的**解析与身份**。
 *
 * 这个文件的每一个断言都对应一个已实测的坑：
 *
 *   ① `archive` 是**相对 runtime-out 根**的路径。`runtime-out/` 下有**两份** manifest
 *      （根一份、`openclaw-runtime/` 里一份副本），副本那份按自身目录解析会得到
 *      `openclaw-runtime/win32-x64/...` —— 一个**不存在**的路径。必须以前者为基准。
 *   ② `size` 字段是**硬编码 0**，真体积在 `archiveSize`。
 *   ③ `extractor` 字段指向**不存在的文件**（`win32-x64/extractor/7za.exe`），
 *      任何把它 join 进 spawn 路径的代码都是错的 —— 装载器一律自解压。
 *   ④ **两个不同的 Node 不能得到同一个 deployment key** —— 否则换了 Node 却复用旧缓存，
 *      跑起来的还是旧的 node.exe。这是「Node 一起进本机缓存」那条的承重断言。
 */

/** 与 `pack-runtime.mjs` 的 `buildManifest()` 逐字同形（字段名改了会静默变成 undefined）。 */
const RUNTIME_MANIFEST = {
  formatVersion: 1,
  packageName: 'openclaw',
  version: '2026.9.3',
  runtimes: [
    {
      platform: 'win32',
      arch: 'x64',
      version: '2026.9.3',
      runtimeDeploymentKey: '2026.9.3',
      archive: 'win32-x64/openclaw-runtime-2026.9.3.7z',
      archiveSize: 128021347,
      extractor: 'win32-x64/extractor/7za.exe',
      size: 0,
      fileCount: 35047,
      packageRoot: 'node_modules/openclaw',
      cliPath: 'node_modules/openclaw/openclaw.mjs',
      source: 'mofang-pack-runtime',
      patches: [],
      requiredPackages: [],
      sha256: '9a525e1e0012795d563f6536132e1ee25293610ff62a554ec3ba9c0471402fda',
    },
  ],
};

const NODE_MANIFEST = {
  formatVersion: 1,
  packageName: 'node',
  nodes: [
    {
      platform: 'win32',
      arch: 'x64',
      version: '26.3.1',
      path: 'node/node.exe',
      sha256: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
      size: 12345678,
      source: 'https://nodejs.org/dist/v26.3.1/win-x64/node.exe',
    },
  ],
};

describe('parseManifest', () => {
  it('接受打包器产出的那份（字段名逐字对齐 pack-runtime.mjs）', () => {
    const m = parseManifest(RUNTIME_MANIFEST);
    expect(m.runtimes).toHaveLength(1);
    expect(m.runtimes[0].cliPath).toBe('node_modules/openclaw/openclaw.mjs');
    expect(m.runtimes[0].fileCount).toBe(35047);
  });

  it.each([
    ['null', null],
    ['字符串', 'nope'],
    ['没有 runtimes', { formatVersion: 1 }],
    ['runtimes 是空数组', { formatVersion: 1, runtimes: [] }],
    ['runtimes 不是数组', { formatVersion: 1, runtimes: {} }],
    ['缺 cliPath', { formatVersion: 1, runtimes: [{ platform: 'win32', arch: 'x64', sha256: 'x' }] }],
    ['缺 sha256', { formatVersion: 1, runtimes: [{ platform: 'win32', arch: 'x64', cliPath: 'a' }] }],
  ])('拒绝垃圾输入：%s', (_label, raw) => {
    expect(() => parseManifest(raw)).toThrow();
  });

  it('formatVersion 不认识就拒绝（不猜未来的格式）', () => {
    expect(() => parseManifest({ ...RUNTIME_MANIFEST, formatVersion: 99 })).toThrow(/formatVersion/);
  });
});

describe('parseNodeManifest', () => {
  it('接受 companion node manifest', () => {
    const m = parseNodeManifest(NODE_MANIFEST);
    expect(m.nodes[0].path).toBe('node/node.exe');
  });

  it('缺少 nodes ⇒ 拒绝（缺了它装载器无法校验真正被执行的 node.exe）', () => {
    expect(() => parseNodeManifest({ formatVersion: 1, packageName: 'node' })).toThrow();
  });
});

describe('selectRuntimeVariant', () => {
  it('按 platform/arch 选中唯一变体', () => {
    const v = selectRuntimeVariant(parseManifest(RUNTIME_MANIFEST), 'win32', 'x64');
    expect(v.runtimeDeploymentKey).toBe('2026.9.3');
  });

  it('没有匹配的平台 ⇒ 明确报错（带上要找的 platform/arch 与现有清单）', () => {
    const m = parseManifest(RUNTIME_MANIFEST);
    expect(() => selectRuntimeVariant(m, 'darwin', 'arm64')).toThrow(/darwin/);
  });
});

describe('resolveArchivePath / resolveNodePath', () => {
  it('⭐ archive 以**传入的运行时根**为基准，而不是 manifest 自身所在目录', () => {
    const root = 'C:/media/usb';
    const v = selectRuntimeVariant(parseManifest(RUNTIME_MANIFEST), 'win32', 'x64');
    // 关键：即便这份 manifest 是 `openclaw-runtime/manifest.json` 那份**副本**，
    // 解析结果也必须落在根下的 win32-x64/，不能是 openclaw-runtime/win32-x64/。
    const p = resolveArchivePath(root, v).replace(/\\/g, '/');
    expect(p).toBe(`${root}/win32-x64/openclaw-runtime-2026.9.3.7z`);
    // 反例：按 manifest 自身目录解析会得到这个**不存在**的路径
    expect(p).not.toContain('openclaw-runtime/win32-x64');
  });

  it('node 路径同样以运行时根为基准', () => {
    const n = selectNodeVariant(parseNodeManifest(NODE_MANIFEST), 'win32', 'x64');
    expect(resolveNodePath('C:/media/usb', n).replace(/\\/g, '/')).toBe('C:/media/usb/node/node.exe');
  });

  it('⭐ 不提供任何把 extractor 解析成可执行路径的导出（它指向不存在的文件）', async () => {
    const mod = await import('../src/main/runtime/manifest.js');
    const names = Object.keys(mod);
    expect(names.filter((n) => /extractor/i.test(n))).toEqual([]);
  });
});

describe('computeDeploymentKey', () => {
  const base = {
    version: '2026.9.3',
    archiveSha256: '9a525e1e0012795d563f6536132e1ee25293610ff62a554ec3ba9c0471402fda',
    nodeVersion: '26.3.1',
    nodeSha256: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
    platform: 'win32',
    arch: 'x64',
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
  };

  it('同输入 ⇒ 同 key（可复现，否则第二次启动会重复解压 128MB）', () => {
    expect(computeDeploymentKey(base)).toBe(computeDeploymentKey({ ...base }));
  });

  it('⭐ 相同 OpenClaw archive + **不同 Node sha** ⇒ key 必须不同', () => {
    const other = computeDeploymentKey({ ...base, nodeSha256: 'ffff0000'.repeat(8) });
    expect(other).not.toBe(computeDeploymentKey(base));
  });

  it('相同 archive + 相同 node sha 但 **node 版本不同** ⇒ key 也不同', () => {
    const other = computeDeploymentKey({ ...base, nodeVersion: '24.16.0' });
    expect(other).not.toBe(computeDeploymentKey(base));
  });

  it('不同 archive sha ⇒ key 不同', () => {
    expect(computeDeploymentKey({ ...base, archiveSha256: 'deadbeef'.repeat(8) })).not.toBe(computeDeploymentKey(base));
  });

  it('不同 platform/arch ⇒ key 不同（将来多平台不会互相覆盖）', () => {
    expect(computeDeploymentKey({ ...base, arch: 'arm64' })).not.toBe(computeDeploymentKey(base));
  });

  it('不同 schemaVersion ⇒ key 不同（换了部署布局不会再复用旧目录）', () => {
    expect(computeDeploymentKey({ ...base, schemaVersion: DEPLOYMENT_SCHEMA_VERSION + 1 })).not.toBe(
      computeDeploymentKey(base),
    );
  });

  it('可用作目录名：只含 [a-z0-9.-]，且带上可读的版本与平台', () => {
    const k = computeDeploymentKey(base);
    expect(k).toMatch(/^[a-z0-9.-]+$/i);
    expect(k.startsWith('2026.9.3-win32-x64-')).toBe(true);
  });
});
