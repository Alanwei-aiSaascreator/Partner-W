import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createAsarSafeFs } from '../src/main/update/asar-safe-fs.js';

/**
 * ⭐ 2026-09-25 真机验收（发版阻断级）：**Electron 的 `fs` 会把路径里的 `.asar` 段
 * 当成"只读的虚拟归档"**，而更新包里就有 `resources/app.asar`
 * ⇒ 解压写到那一步必炸（真机原始报错：`failed to initialize archive` /
 *   `Invalid package …\resources\app.asar`，抛在 `createWriteStream._construct`）。
 *
 * 官方逃生口是 `original-fs`；`process.noAsar = true` **不能用**（全进程开关，
 * 解压几分钟里应用自己还要读 asar）。
 *
 * ⚠️ 这条**只有打包态真机能复现**（纯 Node 没有那个补丁）—— 所以这里能钉的是
 * "**拿到逃生口就用它、拿不到才回落**"这条选择逻辑，真机那半靠 E: 盘上的验收。
 */
describe('asar 安全的 fs：拿到 original-fs 就用它', () => {
  const fallback = {
    fs: { createWriteStream } as unknown as typeof import('node:fs'),
    promises: { mkdir, readdir, stat, rm, rename, open: vi.fn() } as unknown as typeof import('node:fs/promises'),
  };

  it('⭐ 拿得到 original-fs ⇒ 用它（这才是 Electron 里正确的那个 fs）', () => {
    const fake = {
      promises: { mkdir: vi.fn(), readdir: vi.fn(), stat: vi.fn(), rm: vi.fn(), rename: vi.fn(), open: vi.fn() },
      createWriteStream: vi.fn(),
      createReadStream: vi.fn(),
    };
    const load = vi.fn(() => fake);

    const fs = createAsarSafeFs(load, fallback);

    expect(load).toHaveBeenCalledWith('original-fs');
    expect(fs.fromOriginalFs).toBe(true);
    expect(fs.promises.mkdir).toBe(fake.promises.mkdir);
    expect(fs.createWriteStream).toBe(fake.createWriteStream);
    // ⚠️ 校验时逐文件算哈希走的是 createReadStream —— 读 `app.asar` 也会被拦，
    //    所以它**必须**和写那条用同一份 fs。
    expect(fs.createReadStream).toBe(fake.createReadStream);
  });

  it('拿不到（纯 Node / 单测）⇒ 回落 node:fs，行为一致', () => {
    const load = vi.fn(() => {
      throw new Error("Cannot find module 'original-fs'");
    });

    const fs = createAsarSafeFs(load, fallback);

    expect(fs.fromOriginalFs).toBe(false);
    expect(fs.promises.mkdir).toBe(mkdir);
    expect(fs.createWriteStream).toBe(createWriteStream);
  });

  it('⭐ 只拿到半个模块 ⇒ 也回落（宁可用打过补丁的 fs，也不要拿半个去解压）', () => {
    const load = vi.fn(() => ({ promises: { mkdir: vi.fn() } }));

    const fs = createAsarSafeFs(load, fallback);

    expect(fs.fromOriginalFs).toBe(false);
    expect(fs.createWriteStream).toBe(createWriteStream);
  });

  it('真程序用的那一份存在（Electron 里会是 original-fs）', async () => {
    const mod = await import('../src/main/update/asar-safe-fs.js');
    const fs = mod.asarSafeFs;

    expect(typeof fs.createWriteStream).toBe('function');
    expect(typeof fs.promises.mkdir).toBe('function');
    // vitest 是纯 Node ⇒ 这里必然是回落那份
    expect(fs.fromOriginalFs).toBe(false);
  });
});
