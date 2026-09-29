import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 随包图标**本身**的完整性（2026-09-29）。
 *
 * ## 为什么值得一条测试
 *
 * 图标是"看起来没问题就没人看"的那类资源，而它坏起来是**静默**的：
 * 单尺寸 `.ico` 在任务栏/资源管理器里会糊，尺寸不足的 `.png` 在 Linux/托盘会拉伸，
 * 而**打包不会失败**、门禁也不会红 —— 只有用户看着那张糊图。
 *
 * 换图标时我就是**手工**核了这些（新的 `.ico` 有 7 个尺寸），那就说明它值得被钉住。
 * 判据全部来自文件头，不需要任何图像库。
 */
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** ICO 头：`00 00 01 00` + 目录项数（每项 16 字节）。 */
function icoEntries(buf: Buffer): Array<{ width: number; bytes: number }> {
  expect(buf.subarray(0, 4), 'ICO 魔数不对').toEqual(Buffer.from([0, 0, 1, 0]));
  const count = buf.readUInt16LE(4);
  const out: Array<{ width: number; bytes: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    // ⚠️ 宽高为 0 表示 **256**（一个字节装不下 256）
    out.push({ width: buf[at] === 0 ? 256 : buf[at], bytes: buf.readUInt32LE(at + 8) });
  }
  return out;
}

/** PNG 头：`89 50 4E 47`，宽高是大端 32 位。 */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 4), 'PNG 魔数不对').toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('随包图标资源', () => {
  const ico = readFileSync(path.join(PROJECT_DIR, 'build', 'icon.ico'));
  const png = readFileSync(path.join(PROJECT_DIR, 'build', 'icon.png'));

  it('uses the same current brand artwork inside the application and in the tray', () => {
    const rendererLogo = readFileSync(path.join(PROJECT_DIR, 'src', 'renderer', 'assets', 'logo.png'));
    expect(rendererLogo.equals(png)).toBe(true);
  });

  it('⭐ .ico 必须是**多尺寸**的（单尺寸在任务栏/资源管理器里会糊）', () => {
    const entries = icoEntries(ico);
    expect(entries.length, '尺寸太少：Windows 会挑不到合适的').toBeGreaterThanOrEqual(6);
    const widths = entries.map((e) => e.width).sort((a, b) => a - b);
    expect(widths, '小图标（16/32）要有，否则列表视图会很脏').toContain(16);
    expect(widths, '32 是最常用的那档').toContain(32);
    // 大图标档：`extraLarge`/任务栏大图标 会要 256
    expect(Math.max(...widths), '缺 256 ⇒ 大图标档只能拉伸').toBeGreaterThanOrEqual(256);
    for (const entry of entries) expect(entry.bytes, `${entry.width} 那一档是空的`).toBeGreaterThan(0);
  });

  it('⭐ .png 至少 512（托盘与 Linux 都用它，不够会被拉伸）', () => {
    const { width, height } = pngSize(png);
    expect(width, '宽度不够').toBeGreaterThanOrEqual(512);
    expect(width, '图标该是正方形').toBe(height);
  });

  it('两者**不是**同一个文件（有人把 png 拷成 ico 就会这样）', () => {
    expect(ico.equals(png), 'ico 与 png 同内容 ⇒ 其中一个是错的').toBe(false);
  });
});
