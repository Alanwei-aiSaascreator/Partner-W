import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractArchive } from '../src/main/runtime/unzip.js';
import type { SeedEntry } from './helpers/make-zip.js';
import { makeZip } from './helpers/make-zip.js';

/**
 * 真解压往返（本文件是**唯一**值得做真 fs 的地方 —— 因为要复现"半成品"与"路径穿越"）。
 *
 * ⚠️ 会话安全：本文件**只在自己的 mkdtemp 目录里**建删文件，
 * **绝不触碰**真实的 `%APPDATA%` / `openclaw-state` / `.state-*`（见 junction 事故）。
 * 收尾清理前一律先确认路径在 tmp 下。
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-unzip-'));
});

afterEach(() => {
  // 双重保险：只删我们自己建的 tmp 目录，路径不含 tmp 就绝不删。
  if (tmpRoot && tmpRoot.includes(path.join(os.tmpdir(), 'clawwork-unzip-'))) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ---------- 造一个**真的** zip（能被本解析器解开，不需要 7-Zip） ----------

function writeArchive(entries: SeedEntry[]): string {
  const p = path.join(tmpRoot, `archive-${Math.random().toString(36).slice(2)}.7z`);
  fs.writeFileSync(p, makeZip(entries));
  return p;
}

function destDir(name = 'out'): string {
  return path.join(tmpRoot, name);
}

describe('extractArchive', () => {
  it('解出文件与目录，内容逐字节正确', async () => {
    const body = Buffer.from('export const x = 1;\n');
    const archive = writeArchive([
      { name: 'node_modules/' },
      { name: 'node_modules/openclaw/openclaw.mjs', content: body, store: true },
      { name: 'node_modules/openclaw/dist/index.js', content: Buffer.from('deflated payload') },
    ]);

    const res = await extractArchive({ archivePath: archive, destDir: destDir() });

    expect(res.fileCount).toBe(2);
    expect(res.dirCount).toBe(1);
    expect(fs.readFileSync(path.join(destDir(), 'node_modules/openclaw/openclaw.mjs'))).toEqual(body);
    expect(fs.readFileSync(path.join(destDir(), 'node_modules/openclaw/dist/index.js')).toString()).toBe(
      'deflated payload',
    );
    expect(fs.statSync(path.join(destDir(), 'node_modules')).isDirectory()).toBe(true);
  });

  it('⭐ 大一点的内容走 deflate 也不失真（统一 stream 路径）', async () => {
    const big = Buffer.from('x'.repeat(300_000) + 'END');
    const archive = writeArchive([{ name: 'big.txt', content: big }]);
    await extractArchive({ archivePath: archive, destDir: destDir() });
    expect(fs.readFileSync(path.join(destDir(), 'big.txt'))).toEqual(big);
  });

  it('⭐ CRC 不符 ⇒ 抛错，且**不留下那个坏文件**', async () => {
    const archive = writeArchive([{ name: 'corrupt.bin', content: Buffer.from('hello'), badCrc: 0xdeadbeef }]);
    await expect(extractArchive({ archivePath: archive, destDir: destDir() })).rejects.toThrow(/CRC/i);
    expect(fs.existsSync(path.join(destDir(), 'corrupt.bin'))).toBe(false);
  });

  it('⭐ 解压后长度不符 ⇒ 抛错', async () => {
    const archive = writeArchive([{ name: 'short.bin', content: Buffer.from('hello'), badSize: 999 }]);
    await expect(extractArchive({ archivePath: archive, destDir: destDir() })).rejects.toThrow(/长度|size/i);
  });

  it('⭐ 路径穿越条目 ⇒ 抛错，且绝不写到目标目录之外', async () => {
    const archive = writeArchive([{ name: '../evil.txt', content: Buffer.from('pwned') }]);
    await expect(extractArchive({ archivePath: archive, destDir: destDir() })).rejects.toThrow(/不安全|越界|路径/i);
    expect(fs.existsSync(path.join(tmpRoot, 'evil.txt'))).toBe(false);
  });

  it('解压中途失败时，目标目录**不会被当成完成**（调用方还要写 stamp）', async () => {
    const archive = writeArchive([
      { name: 'ok.txt', content: Buffer.from('fine') },
      { name: 'bad.bin', content: Buffer.from('x'), badCrc: 1 },
    ]);
    await expect(extractArchive({ archivePath: archive, destDir: destDir() })).rejects.toThrow();
    // 好文件可能已经写出去了（这是允许的），但**没有**完成标记
    expect(fs.existsSync(path.join(destDir(), '.clawwork-runtime.json'))).toBe(false);
  });

  it('进度回调在条目多时会被调用，且最后一次是满额', async () => {
    const entries: SeedEntry[] = [];
    for (let i = 0; i < 12; i++) entries.push({ name: `f${i}.txt`, content: Buffer.from(`n=${i}`) });
    const seen: number[] = [];
    await extractArchive({
      archivePath: writeArchive(entries),
      destDir: destDir(),
      onProgress: (done) => seen.push(done),
      progressEvery: 5,
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBe(12);
  });

  it('⭐ 目录条目也计入进度 —— 最后一次回调必须到 100%（真实包有 2072 个目录）', async () => {
    // 回归：曾经用 fileCount === entries.length 判"最后一条"，而 fileCount 只数文件，
    // 于是任何含目录的归档都**永远发不出最后一次进度** —— 进度条卡住 = 看着像卡死。
    const entries: SeedEntry[] = [
      { name: 'a/' },
      { name: 'a/one.txt', content: Buffer.from('1') },
      { name: 'b/' },
      { name: 'b/two.txt', content: Buffer.from('2') },
    ];
    const seen: Array<[number, number]> = [];
    await extractArchive({
      archivePath: writeArchive(entries),
      destDir: destDir(),
      onProgress: (done, total) => seen.push([done, total]),
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual([4, 4]);
  });

  it('还原 DOS 时间戳（不是「刚刚」）', async () => {
    const archive = writeArchive([{ name: 'stamped.txt', content: Buffer.from('t') }]);
    await extractArchive({ archivePath: archive, destDir: destDir() });
    const st = fs.statSync(path.join(destDir(), 'stamped.txt'));
    // 造的包 dosDate=0x5d2b / dosTime=0x0000 → 2026-09-11 00:00
    expect(st.mtime.getFullYear()).toBe(2026);
    expect(st.mtime.getMonth() + 1).toBe(9);
    expect(st.mtime.getDate()).toBe(11);
  });
});
