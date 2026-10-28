import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { documentFileNameFor } from '../src/main/docgen/generate';
import { parseDocgenRequest } from '../src/main/docgen/request';
import { renderPptx } from '../src/main/docgen/render-pptx';
import { buildArtifactPreview } from '../src/main/preview/build-preview';

/**
 * **真字节那一条链**：消息里的内容 → 真文件 → 写进任务目录 → 读回来能在界面上看。
 *
 * 为什么非要落到磁盘、再真读一遍：
 *  - 「函数返回了 Buffer」证明不了"这个 Buffer 是一份能被打开的文件"；
 *  - 「XML 里有那几个字」证明不了"读回来的顺序与页码是对的"——
 *    而页码错位（`slide10` 排在 `slide2` 前面）恰恰是这类代码最经典的坑；
 *  - 中文是最容易被编码层吃掉的东西：从 JSON → 字符串 → zip → UTF-8 XML → 读回，
 *    中间任何一层用错编码，最后呈现给用户的就是问号。
 *
 * 这里不 mock 任何东西：写的是真的临时目录，读的是真的字节。
 */

const DECK = {
  kind: 'pptx',
  title: '九月经营简报',
  subtitle: '2026-09-26 · 产品组',
  slides: [
    { title: '本月完成情况', bullets: ['文档生成能力已落地', '文件导入提示已修复'] },
    { title: '关键指标', bullets: ['周活 1,240', '留存 38%', '平均时长 21 分钟'] },
    { title: '问题与风险', bullets: ['更新链上偶发启动器卡死', '已加日志留档'] },
    { title: '下一步计划', bullets: ['PPT 主题与配色', '真盘验收', '发布到稳定通道'] },
    { title: '需要支持', bullets: ['一台干净的测试机', '一张测试用激活卡'] },
  ],
} as const;

let taskDir = '';

beforeEach(() => {
  taskDir = mkdtempSync(join(tmpdir(), 'clawwork-pptx-bytes-'));
});
afterEach(() => rmSync(taskDir, { recursive: true, force: true }));

/** 走真实链路：校验 → 渲染 → 写进任务目录（用真实文件名规则）。 */
async function writeDeckToTaskDir(): Promise<string> {
  const parsed = parseDocgenRequest(DECK);
  if (!parsed.ok) throw new Error(`夹具不合法：${parsed.error}`);
  if (parsed.request.kind !== 'pptx') throw new Error('夹具 kind 不对');
  const filePath = join(taskDir, documentFileNameFor(parsed.request.title, 'pptx'));
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(filePath, await renderPptx(parsed.request));
  return filePath;
}

describe('一份五页中文简报：从内容到"用户在界面上看到的东西"', () => {
  it('⭐ 落盘的是真 pptx，且能读成预览（不是 0 字节、不是坏 zip）', async () => {
    const filePath = await writeDeckToTaskDir();
    const bytes = readFileSync(filePath);
    expect(bytes.byteLength).toBeGreaterThan(10_000);
    // zip 魔数：`PK\x03\x04`
    expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');

    const preview = await buildArtifactPreview('九月经营简报.pptx', bytes);
    expect(preview.kind).toBe('pptx');
    if (preview.kind !== 'pptx') return;
    // 封面 + 五页内容 = 6 张，一张都不许少（少一张后面所有页码都会错位）
    expect(preview.slides.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(preview.truncated).toBe(false);
  });

  it('⭐ 中文一路没被吃掉（标题、正文、副标题都原样读得回来）', async () => {
    const preview = await buildArtifactPreview('九月经营简报.pptx', readFileSync(await writeDeckToTaskDir()));
    if (preview.kind !== 'pptx') throw new Error('预览类型不对');
    const all = preview.slides.flatMap((s) => s.lines).join('\n');

    expect(all).toContain('九月经营简报');
    expect(all).toContain('2026-09-26 · 产品组');
    expect(all).toContain('本月完成情况');
    expect(all).toContain('文档生成能力已落地');
    expect(all).toContain('周活 1,240');
    expect(all).toContain('一张测试用激活卡');
  });

  it('⭐ 每张内容页都带着页码与页脚，且页码是「第几页 / 共几页」', async () => {
    const preview = await buildArtifactPreview('九月经营简报.pptx', readFileSync(await writeDeckToTaskDir()));
    if (preview.kind !== 'pptx') throw new Error('预览类型不对');

    for (const index of [2, 3, 4, 5, 6]) {
      const lines = preview.slides[index - 1].lines;
      expect(lines, `第 ${index} 张缺页码`).toContain(`${index} / 6`);
      // 页脚是演示标题 —— 脱离上下文单看一页也知道自己在哪份文件里
      expect(lines, `第 ${index} 张缺页脚`).toContain('九月经营简报');
    }
  });

  it('封面不显示页码（但占第 1 号）', async () => {
    const preview = await buildArtifactPreview('九月经营简报.pptx', readFileSync(await writeDeckToTaskDir()));
    if (preview.kind !== 'pptx') throw new Error('预览类型不对');
    expect(preview.slides[0].lines.join('\n')).not.toContain('1 / 6');
  });

  it('负对照：不存在的那句话必须读不到（否则上面的 toContain 可能恒真）', async () => {
    const preview = await buildArtifactPreview('九月经营简报.pptx', readFileSync(await writeDeckToTaskDir()));
    if (preview.kind !== 'pptx') throw new Error('预览类型不对');
    const all = preview.slides.flatMap((s) => s.lines).join('\n');
    expect(all).not.toContain('这句话压根没写过');
  });
});
