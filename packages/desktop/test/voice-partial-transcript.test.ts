import { describe, expect, it } from 'vitest';
import {
  appendTranscript,
  partialWindow,
  shouldEmitPartial,
  sliceSamples,
} from '../src/renderer/lib/voice/partial-transcript.js';

/**
 * 语音实时逐字（2026-10-17 用户：「语音输入实时逐字（需接流式 ASR，有成本）」）。
 *
 * relay 的 ASR 是 REST 批式（整段 WAV 进、整段文字出），没有流式通道。
 * 因此实时性由**客户端增量分段**换回来：录音过程中按「新语音 ≥ 2.5s」切一段（带 0.3s 重叠）
 * 送一次转写，把结果拼在输入框里显示；松手后仍用整段音频做一次**权威**转写。
 *
 * 代价（必须诚实）：每一段都按自身秒数计费 ⇒ 一次录音的总计费约 1.4～2.4 倍。
 * 判据都在纯函数里，便于把"什么时候花钱"钉死。
 */
const RATE = 16000;
const sec = (n: number) => Math.round(n * RATE);

describe('shouldEmitPartial', () => {
  const base = {
    sampleCount: sec(3),
    lastPartialSamples: 0,
    sampleRate: RATE,
    nowMs: 10_000,
    lastPartialAtMs: 0,
    inFlight: false,
  };

  it('新语音够 2.5s 且过了最小间隔 ⇒ 发', () => {
    expect(shouldEmitPartial(base)).toBe(true);
  });

  it('新语音不足 2.5s ⇒ 不发（避免每个音频回调都烧一次钱）', () => {
    expect(shouldEmitPartial({ ...base, sampleCount: sec(2.4) })).toBe(false);
  });

  it('距上次不足 1200ms ⇒ 不发', () => {
    expect(shouldEmitPartial({ ...base, lastPartialAtMs: 9_000 })).toBe(false);
  });

  it('已有请求在飞 ⇒ 不发（串行化，避免并发抢槽位）', () => {
    expect(shouldEmitPartial({ ...base, inFlight: true })).toBe(false);
  });

  it('按"上次提交点"算新语音，而不是总时长', () => {
    expect(
      shouldEmitPartial({ ...base, sampleCount: sec(10), lastPartialSamples: sec(8) }),
    ).toBe(false);
    expect(
      shouldEmitPartial({ ...base, sampleCount: sec(11), lastPartialSamples: sec(8) }),
    ).toBe(true);
  });
});

describe('partialWindow', () => {
  it('首次窗口从 0 开始，到当前样本', () => {
    expect(partialWindow(sec(3), 0, RATE)).toEqual({ from: 0, to: sec(3) });
  });

  it('后续窗口带 0.3s 重叠（切在字中间也能给模型上下文）', () => {
    expect(partialWindow(sec(8), sec(5), RATE)).toEqual({
      from: sec(5) - Math.round(RATE * 0.3),
      to: sec(8),
    });
  });

  it('重叠不越过 0（第二次就发也不会要负数下标）', () => {
    expect(partialWindow(sec(3), sec(0.1), RATE).from).toBe(0);
  });
});

describe('appendTranscript', () => {
  it('英文重叠词只保留一份', () => {
    expect(appendTranscript('hello world', 'world again')).toBe('hello world again');
  });

  it('中文重叠按最长公共边界去重', () => {
    expect(appendTranscript('今天天气不错', '不错我们去公园')).toBe('今天天气不错我们去公园');
  });

  it('没有重叠：中文直接拼，英文补一个空格', () => {
    expect(appendTranscript('你好', '我们走吧')).toBe('你好我们走吧');
    expect(appendTranscript('hello', 'again')).toBe('hello again');
  });

  it('半截重叠（"天气好" / "好热"）也能对上', () => {
    expect(appendTranscript('今天天气好', '好热啊')).toBe('今天天气好热啊');
  });

  it('空串是恒等元（第一段就直接返回第二段）', () => {
    expect(appendTranscript('', '第一句')).toBe('第一句');
    expect(appendTranscript('第一句', '')).toBe('第一句');
  });
});

describe('sliceSamples', () => {
  const a = new Float32Array([1, 2, 3]);
  const b = new Float32Array([4, 5, 6]);

  it('跨 chunk 切片（绝对样本下标）', () => {
    expect(Array.from(sliceSamples([a, b], 2, 5))).toEqual([3, 4, 5]);
  });

  it('越界钳制到可用范围', () => {
    expect(Array.from(sliceSamples([a, b], -10, 99))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(sliceSamples([a, b], 4, 4).length).toBe(0);
  });
});
