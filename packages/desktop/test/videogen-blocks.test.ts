import { describe, expect, it } from 'vitest';
import { extractVideogenBlocks } from '../src/main/videogen/blocks.js';
import { VIDEOGEN_MAX_TITLE_CHARS, parseVideogenRequest, videoFileNameFor } from '../src/main/videogen/request.js';
import {
  VIDEOGEN_ASPECT_RATIOS,
  VIDEOGEN_DURATION_MAX,
  VIDEOGEN_DURATION_MIN,
  VIDEOGEN_PROMPT_MAX_CHARS,
  VIDEOGEN_RESOLUTIONS,
} from '@clawwork/shared';

/**
 * 2026-10-12 视频接入：```` ```videogen ```` 块的抽取与校验（纯函数，零 mock）。
 *
 * 这里钉两类最容易漂的东西：
 *  1. **围栏边界**——`videogen` 恰好匹配；`video`/`mp4` 不吞（用户贴代码不该被当请求）；
 *  2. **与 relay 的白名单/区间逐字一致**——shared 常量（本文件断言）=
 *     客户端 request.ts 吃的值 = relay `services/relay/src/video.ts` 的白名单。
 *     两侧是两个仓，没法互相 import，所以这里把值**逐字钉死**：
 *     谁改了一侧没改另一侧，这里/那边的测试总有一个红。
 */

function block(json: unknown): string {
  return ['```videogen', typeof json === 'string' ? json : JSON.stringify(json), '```'].join('\n');
}

describe('extractVideogenBlocks（围栏抽取）', () => {
  it('单块 → 一条请求（默认值在解析时填好）', () => {
    const { requests, failures } = extractVideogenBlocks(`前置文字\n${block({ prompt: '一只猫打盹' })}\n后置文字`);
    expect(failures).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      prompt: '一只猫打盹',
      duration: 10,
      resolution: '768P',
      aspectRatio: '16:9',
      title: '',
    });
  });

  it('多块 → 多条；坏了一块不影响另一块', () => {
    const content = [block({ prompt: 'A' }), block('{ 这不是 JSON'), block({ prompt: 'B', duration: 6 })].join('\n');
    const { requests, failures } = extractVideogenBlocks(content);
    expect(requests.map((r) => r.prompt)).toEqual(['A', 'B']);
    expect(failures).toHaveLength(1);
    expect(failures[0].failure.code).toBe('videogen-block-invalid');
  });

  it('大小写宽容；`video` / `mp4` / `videogen.json` 都不算', () => {
    expect(extractVideogenBlocks(block({ prompt: 'x' }).replace('```videogen', '```VideoGen')).requests).toHaveLength(
      1,
    );
    for (const lang of ['video', 'mp4', 'videogen.json', 'video-gen']) {
      const content = ['```' + lang, '{"prompt":"x"}', '```'].join('\n');
      expect(extractVideogenBlocks(content).requests).toHaveLength(0);
    }
  });

  it('没闭合的开栏 ⇒ 报 block-invalid（截断回复的形状）', () => {
    const { requests, failures } = extractVideogenBlocks('```videogen\n{"prompt":"只开了头');
    expect(requests).toHaveLength(0);
    expect(failures[0].failure.code).toBe('videogen-block-invalid');
  });
});

describe('parseVideogenRequest（与 relay 白名单逐字一致）', () => {
  it('常量钉死：区间/上限/白名单（relay services/relay/src/video.ts 的镜像）', () => {
    expect(VIDEOGEN_DURATION_MIN).toBe(4);
    expect(VIDEOGEN_DURATION_MAX).toBe(15);
    expect(VIDEOGEN_PROMPT_MAX_CHARS).toBe(7000);
    expect([...VIDEOGEN_RESOLUTIONS]).toEqual(['768P', '2K']);
    expect([...VIDEOGEN_ASPECT_RATIOS]).toEqual(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
  });

  it('duration 边界：只收 [4,15] 的整数（数字字符串不归一——fence 是 JSON，字符串就是写错了）', () => {
    for (const [duration, ok] of [
      [3, false],
      [4, true],
      [15, true],
      [16, false],
      [4.5, false],
      ['10', false],
      [null, true], // null/undefined 按缺省走默认 10
    ] as const) {
      const result = parseVideogenRequest({ prompt: 'x', duration });
      expect(result.ok, `duration=${String(duration)}`).toBe(ok);
      if (ok && result.ok) expect(result.request.duration).toBe(duration === null ? 10 : duration);
    }
  });

  it('resolution / aspectRatio 白名单（错值带可用清单上屏）', () => {
    const badRes = parseVideogenRequest({ prompt: 'x', resolution: '720P' });
    expect(badRes.ok).toBe(false);
    if (!badRes.ok) {
      expect(badRes.failure.code).toBe('videogen-resolution-invalid');
      if (badRes.failure.code === 'videogen-resolution-invalid') {
        expect([...badRes.failure.allowed]).toEqual(['768P', '2K']);
      }
    }
    const badAspect = parseVideogenRequest({ prompt: 'x', aspectRatio: '16:10' });
    expect(badAspect.ok).toBe(false);
    if (!badAspect.ok && badAspect.failure.code === 'videogen-aspect-invalid') {
      expect(badAspect.failure.value).toBe('16:10');
    } else {
      throw new Error('expected videogen-aspect-invalid');
    }
  });

  it('prompt：必填、去空白、超长拒（带 maxChars）', () => {
    expect(parseVideogenRequest({ prompt: '   ' }).ok).toBe(false);
    expect(parseVideogenRequest({}).ok).toBe(false);
    const tooLong = parseVideogenRequest({ prompt: 'x'.repeat(VIDEOGEN_PROMPT_MAX_CHARS + 1) });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok && tooLong.failure.code === 'videogen-prompt-too-long') {
      expect(tooLong.failure.maxChars).toBe(VIDEOGEN_PROMPT_MAX_CHARS);
    } else {
      throw new Error('expected videogen-prompt-too-long');
    }
    const trimmed = parseVideogenRequest({ prompt: '  猫  ' });
    expect(trimmed.ok && trimmed.request.prompt).toBe('猫');
  });

  it('⭐ 未知字段整份拒（P0 只做文生视频：图/首尾帧字段不许被静默丢弃）', () => {
    const result = parseVideogenRequest({ prompt: 'x', imageUrl: 'https://x/a.png' });
    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.code === 'videogen-unsupported-field') {
      expect(result.failure.field).toBe('imageUrl');
    } else {
      throw new Error('expected videogen-unsupported-field');
    }
    expect(parseVideogenRequest({ prompt: 'x', firstFrame: 'y' }).ok).toBe(false);
    expect(parseVideogenRequest({ prompt: 'x', model: 'minimax-h3' }).ok).toBe(false);
  });

  it('title：可选；非字符串拒；超长截断到上限', () => {
    expect(parseVideogenRequest({ prompt: 'x', title: 42 }).ok).toBe(false);
    const long = parseVideogenRequest({ prompt: 'x', title: '标'.repeat(100) });
    expect(long.ok && long.request.title.length).toBe(VIDEOGEN_MAX_TITLE_CHARS);
  });
});

describe('videoFileNameFor（文件名与 docgen/htmlgen 共用同一份清洗）', () => {
  it('有标题用标题；没有用 prompt 前缀；扩展名固定 .mp4；点/控制字符被洗掉', () => {
    expect(videoFileNameFor({ prompt: 'anything', title: '小猫打盹' })).toBe('小猫打盹.mp4');
    const fromPrompt = videoFileNameFor({ prompt: '  一只橘猫在窗台上伸懒腰  ', title: '' });
    expect(fromPrompt.endsWith('.mp4')).toBe(true);
    expect(fromPrompt).not.toContain(' ');
    const dangerous = videoFileNameFor({ prompt: 'x', title: '关于...的说明' });
    expect(dangerous).not.toContain('..');
    expect(dangerous.endsWith('.mp4')).toBe(true);
  });
});
